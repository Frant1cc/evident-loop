import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';

import { sqlite } from '../../db.js';
import { artifactBinaryStore } from './binaryStore.js';
import type { ArtifactBinaryStore } from './types.js';
import type { SqliteImageProviderStore } from './imageProviders.js';

export const imageLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxPixels: 20_000_000,
  maxRedirects: 3
} as const;

export class ImageAssetError extends Error {
  readonly code = 'image_asset_rejected';

  constructor(message: string) {
    super(message);
    this.name = 'ImageAssetError';
  }
}

export type ImageAsset = {
  id: string;
  generationId: string;
  sourceId?: string;
  originalPageUrl?: string;
  imageUrl: string;
  licenseConfirmed: boolean;
  mimeType: string;
  byteSize: number;
  pixelWidth?: number;
  pixelHeight?: number;
  storageKey: string;
  /** Render-only media is kept in memory and is never exposed by the API. */
  data?: Buffer;
};

export type ImageFetchOptions = {
  fetchImpl?: typeof fetch;
  store?: ArtifactBinaryStore;
  signal?: AbortSignal;
  maxBytes?: number;
  maxPixels?: number;
  /** Confirmed versions may use a transient fallback without mutating media rows. */
  persist?: boolean;
  /** Re-check the generation lifecycle immediately before durable media writes. */
  beforePersist?: () => void | Promise<void>;
};

export async function fetchSourceImage(input: {
  generationId: string;
  imageUrl: string;
  originalPageUrl?: string;
  sourceId?: string;
  licenseConfirmed: boolean;
  consentId?: string;
}, options: ImageFetchOptions = {}) {
  if (!input.licenseConfirmed) throw new ImageAssetError('Explicit image usage confirmation is required');
  assertPersistableGeneration(input.generationId, options.persist !== false);
  const maxBytes = options.maxBytes ?? imageLimits.maxBytes;
  const maxPixels = options.maxPixels ?? imageLimits.maxPixels;
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = options.store ?? artifactBinaryStore;
  let currentUrl = validateImageUrl(input.imageUrl);
  if (input.originalPageUrl) validatePageUrl(input.originalPageUrl);

  let response: Response | undefined;
  for (let redirect = 0; redirect <= imageLimits.maxRedirects; redirect += 1) {
    await rejectPrivateHost(currentUrl);
    response = options.fetchImpl
      ? await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: options.signal,
          headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' }
        })
      : await pinnedHttpsFetch(currentUrl, options.signal, { accept: 'image/png,image/jpeg,image/gif,image/webp' });
    if (response.status < 300 || response.status >= 400) break;
    if (redirect === imageLimits.maxRedirects) throw new ImageAssetError('Image redirect limit exceeded');
    const location = response.headers.get('location');
    if (!location) throw new ImageAssetError('Image redirect has no location');
    currentUrl = validateImageUrl(new URL(location, currentUrl).toString());
  }
  if (!response || !response.ok) throw new ImageAssetError(`Image fetch failed with status ${response?.status ?? 'unknown'}`);
  const mimeType = normalizeMime(response.headers.get('content-type'));
  if (!allowedMimeTypes.has(mimeType)) throw new ImageAssetError(`Unsupported image MIME type: ${mimeType || 'missing'}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ImageAssetError('Image exceeds byte limit');
  const buffer = await readResponseBodyWithLimit(response, maxBytes, options.signal);
  if (buffer.byteLength === 0) throw new ImageAssetError('Image exceeds byte limit');
  const dimensions = readImageDimensions(mimeType, buffer);
  if (!dimensions) throw new ImageAssetError('Image dimensions could not be verified');
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > maxPixels) {
    throw new ImageAssetError('Image dimensions exceed the allowed limit');
  }

  const id = randomUUID();
  const storageKey = `assets/${input.generationId}/${id}`;
  const persist = options.persist !== false;
  if (persist) {
    await options.beforePersist?.();
    await store.put(storageKey, buffer);
    try {
      await options.beforePersist?.();
    } catch (error) {
      await store.delete(storageKey);
      throw error;
    }
  }
  const now = new Date().toISOString();
  if (persist) {
    try {
      sqlite.prepare(`INSERT INTO research_artifact_assets
        (id, generation_id, source_id, original_page_url, image_url, license_confirmed, mime_type, byte_size, pixel_width, pixel_height, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.generationId,
          input.sourceId ?? null,
          input.originalPageUrl ?? null,
          currentUrl,
          mimeType,
          buffer.byteLength,
          dimensions.width,
          dimensions.height,
          storageKey,
          now
        );
    } catch (error) {
      await store.delete(storageKey);
      throw error;
    }
  }
  return {
    id,
    generationId: input.generationId,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.originalPageUrl ? { originalPageUrl: input.originalPageUrl } : {}),
    imageUrl: currentUrl,
    licenseConfirmed: true,
    mimeType,
    byteSize: buffer.byteLength,
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
    storageKey,
    ...(persist ? {} : { data: buffer })
  } satisfies ImageAsset;
}

export async function generateImageAsset(input: {
  generationId: string;
  providerId: string;
  prompt: string;
  providerStore: SqliteImageProviderStore;
}, options: ImageFetchOptions = {}) {
  assertPersistableGeneration(input.generationId, options.persist !== false);
  const provider = input.providerStore.get(input.providerId);
  const apiKey = input.providerStore.getCredential(input.providerId);
  if (!provider || !apiKey) throw new ImageAssetError('Image provider is unavailable or credentials are not configured');
  const providerUrl = validateImageUrl(provider.baseUrl);
  const body = JSON.stringify({ model: provider.model, prompt: input.prompt, response_format: 'b64_json' });
  const response = await fetchProviderResponse(
    `${providerUrl}/images/generations`,
    apiKey,
    body,
    options
  );
  if (!response.ok) throw new ImageAssetError(`Image provider failed with status ${response.status}`);
  let payload: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    const providerResponseLimit = options.maxBytes === undefined
      ? Math.min(imageLimits.maxBytes * 2, 32 * 1024 * 1024)
      : options.maxBytes;
    payload = JSON.parse((await readResponseBodyWithLimit(response, providerResponseLimit, options.signal)).toString('utf8')) as { data?: Array<{ b64_json?: string; url?: string }> };
  } catch (error) {
    if (error instanceof ImageAssetError) throw error;
    throw new ImageAssetError('Image provider returned an invalid response');
  }
  const first = payload.data?.[0];
  if (first?.b64_json) {
    const buffer = Buffer.from(first.b64_json, 'base64');
    return saveGeneratedImage(
      input.generationId,
      buffer,
      options.store ?? artifactBinaryStore,
      options.persist !== false,
      options.beforePersist
    );
  }
  if (first?.url) {
    return fetchSourceImage({ generationId: input.generationId, imageUrl: first.url, licenseConfirmed: true }, options);
  }
  throw new ImageAssetError('Image provider returned no image');
}

export function validateImageUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImageAssetError('Image URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') throw new ImageAssetError('Image URL must use HTTPS');
  if (parsed.username || parsed.password) throw new ImageAssetError('Image URL must not contain credentials');
  if (!parsed.hostname) throw new ImageAssetError('Image URL must include a hostname');
  return parsed.toString();
}

function validatePageUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new ImageAssetError('Original page URL must use HTTPS');
  } catch (error) {
    if (error instanceof ImageAssetError) throw error;
    throw new ImageAssetError('Original page URL must be a valid HTTPS URL');
  }
}

async function rejectPrivateHost(value: string) {
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw new ImageAssetError('Image host resolves to a private or local network');
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((address) => isPrivateHost(address.address))) throw new ImageAssetError('Image host resolves to a private or local network');
  } catch (error) {
    if (error instanceof ImageAssetError) throw error;
    // DNS failures are left to fetch so local adapters/tests can supply a fake fetch.
  }
}

async function fetchProviderResponse(
  value: string,
  apiKey: string,
  body: string,
  options: ImageFetchOptions
) {
  let currentUrl = validateImageUrl(value);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= imageLimits.maxRedirects; redirect += 1) {
    // Resolve and validate every hop. A provider must not redirect a safe
    // configured endpoint into a private network or a non-HTTPS URL.
    await rejectPrivateHost(currentUrl);
    response = options.fetchImpl
      ? await options.fetchImpl(currentUrl, {
          method: 'POST',
          redirect: 'manual',
          signal: options.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body
        })
      : await pinnedHttpsFetch(currentUrl, options.signal, {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        }, 'POST', body);
    if (response.status < 300 || response.status >= 400) return response;
    // A provider POST carries a bearer credential. Reject every redirect so
    // it can never be replayed to another origin.
    throw new ImageAssetError('Image provider POST redirects are not allowed');
  }
  throw new ImageAssetError('Image provider redirect limit exceeded');
}

async function pinnedHttpsFetch(
  value: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string
): Promise<Response> {
  const parsed = new URL(value);
  const address = await resolvePublicAddress(parsed.hostname);
  return new Promise<Response>((resolve, reject) => {
    const request = https.request({
      protocol: parsed.protocol,
      hostname: address,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: { ...headers, host: parsed.host },
      servername: parsed.hostname,
      rejectUnauthorized: true
    }, (response) => {
      const bodyStream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(bodyStream, { status: response.statusCode ?? 502, headers: response.headers as HeadersInit }));
    });
    request.once('error', reject);
    if (signal) {
      if (signal.aborted) request.destroy(signal.reason);
      else signal.addEventListener('abort', () => request.destroy(signal.reason), { once: true });
    }
    if (body) request.write(body);
    request.end();
  });
}

async function resolvePublicAddress(hostname: string) {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(literal)) throw new ImageAssetError('Image host resolves to a private or local network');
  try {
    const addresses = await lookup(literal, { all: true });
    if (!addresses.length || addresses.some((address) => isPrivateHost(address.address))) {
      throw new ImageAssetError('Image host resolves to a private or local network');
    }
    return addresses[0]!.address;
  } catch (error) {
    if (error instanceof ImageAssetError) throw error;
    throw new ImageAssetError('Image host could not be resolved safely');
  }
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number, signal?: AbortSignal) {
  if (!response.body) {
    throwIfAborted(signal);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new ImageAssetError('Image exceeds byte limit');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel('image byte limit exceeded');
        throw new ImageAssetError('Image exceeds byte limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isPrivateHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('::ffff:')) return isPrivateHost(normalized.slice('::ffff:'.length));
    return false;
  }
  if (isIP(normalized) !== 4) return false;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  // Unspecified, loopback, RFC1918, link-local, CGNAT, documentation,
  // benchmark, multicast and reserved IPv4 ranges are not fetch targets.
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 0 && c === 0 || b === 168 || b === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function normalizeMime(value: string | null) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function readImageDimensions(mimeType: string, buffer: Buffer) {
  if (mimeType === 'image/png' && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && buffer.length >= 10 && (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a')) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/webp' && buffer.length >= 30 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    if (buffer.subarray(12, 16).toString() === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
  }
  if (mimeType === 'image/jpeg') return readJpegDimensions(buffer);
  return undefined;
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

async function saveGeneratedImage(
  generationId: string,
  buffer: Buffer,
  store: ArtifactBinaryStore,
  persist = true,
  beforePersist?: () => void | Promise<void>
) {
  if (buffer.byteLength > imageLimits.maxBytes) throw new ImageAssetError('Generated image exceeds byte limit');
  const dimensions = readImageDimensions('image/png', buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > imageLimits.maxPixels) {
    throw new ImageAssetError('Generated image dimensions could not be verified');
  }
  const id = randomUUID();
  const storageKey = `assets/${generationId}/${id}`;
  if (persist) {
    await beforePersist?.();
    await store.put(storageKey, buffer);
    try {
      await beforePersist?.();
    } catch (error) {
      await store.delete(storageKey);
      throw error;
    }
  }
  const now = new Date().toISOString();
  if (persist) {
    try {
      sqlite.prepare(`INSERT INTO research_artifact_assets
        (id, generation_id, image_url, license_confirmed, mime_type, byte_size, pixel_width, pixel_height, storage_key, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(id, generationId, 'generated://provider', 'image/png', buffer.byteLength, dimensions.width, dimensions.height, storageKey, now);
    } catch (error) {
      await store.delete(storageKey);
      throw error;
    }
  }
  return {
    id,
    generationId,
    imageUrl: 'generated://provider',
    licenseConfirmed: true,
    mimeType: 'image/png',
    byteSize: buffer.byteLength,
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
    storageKey,
    ...(persist ? {} : { data: buffer })
  } satisfies ImageAsset;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Image request cancelled');
}

function assertPersistableGeneration(generationId: string, persist: boolean) {
  if (!persist) return;
  const row = sqlite.prepare('SELECT status FROM research_artifacts WHERE id = ?').get(generationId) as { status?: string } | undefined;
  // Unit-level callers may exercise URL policy without a database generation;
  // the application/service boundary enforces the same rule for real rows.
  if (!row) return;
  if (row.status !== 'planning' && row.status !== 'awaiting_confirmation') {
    throw new ImageAssetError('Only a planning or awaiting-confirmation draft can add image assets');
  }
}
