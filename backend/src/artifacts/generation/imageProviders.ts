import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { sqlite } from '../../db.js';
import { createCredentialCipher, type CredentialCipher } from '../../mcp/crypto.js';

export type ImageProviderInput = {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type ImageProviderDto = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

type ImageProviderRow = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  created_at: string;
  updated_at: string;
};

export class SqliteImageProviderStore {
  private readonly database: typeof sqlite;
  private readonly cipher: CredentialCipher;

  constructor(database = sqlite, cipher = createCredentialCipher()) {
    this.database = database;
    this.cipher = cipher;
  }

  list() {
    return (this.database.prepare('SELECT * FROM artifact_image_providers ORDER BY created_at ASC').all() as ImageProviderRow[])
      .map((row) => toDto(row, this.cipher));
  }

  get(id: string) {
    const row = this.database.prepare('SELECT * FROM artifact_image_providers WHERE id = ?').get(id) as ImageProviderRow | undefined;
    return row ? toDto(row, this.cipher) : undefined;
  }

  getCredential(id: string) {
    const row = this.database.prepare('SELECT * FROM artifact_image_providers WHERE id = ?').get(id) as ImageProviderRow | undefined;
    if (!row) return undefined;
    return this.cipher.decrypt(row.encrypted_api_key);
  }

  save(input: ImageProviderInput) {
    const name = normalizeText(input.name, 'name', 120);
    const model = normalizeText(input.model, 'model', 160);
    const baseUrl = normalizeHttpsUrl(input.baseUrl);
    const id = input.id ?? randomUUID();
    const existing = this.database.prepare('SELECT * FROM artifact_image_providers WHERE id = ?').get(id) as ImageProviderRow | undefined;
    const apiKey = input.apiKey?.trim();
    const encrypted = apiKey
      ? this.cipher.encrypt(apiKey)
      : existing?.encrypted_api_key;
    if (!encrypted) throw new Error('MCP_CREDENTIALS_KEY is required to save image provider credentials');
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO artifact_image_providers
      (id, name, base_url, model, encrypted_api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
      model = excluded.model, encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at`)
      .run(id, name, baseUrl, model, encrypted, existing?.created_at ?? now, now);
    return this.get(id)!;
  }

  delete(id: string) {
    return this.database.prepare('DELETE FROM artifact_image_providers WHERE id = ?').run(id).changes > 0;
  }
}

export const imageProviderStore = new SqliteImageProviderStore();

export function createImageProviderStore(database = sqlite, cipher = createCredentialCipher()) {
  return new SqliteImageProviderStore(database, cipher);
}

function toDto(row: ImageProviderRow, cipher: CredentialCipher): ImageProviderDto {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    credentialConfigured: Boolean(row.encrypted_api_key && cipher.decrypt(row.encrypted_api_key)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeText(value: string, field: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${field} is required and must be <= ${maximum} characters`);
  return normalized;
}

function normalizeHttpsUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('baseUrl must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('baseUrl must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('baseUrl must not contain credentials');
  if (isPrivateLiteralHost(parsed.hostname)) throw new Error('baseUrl must not target a private or local network');
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function isPrivateLiteralHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) return true;
    if (host.startsWith('::ffff:')) return isPrivateLiteralHost(host.slice('::ffff:'.length));
    return false;
  }
  if (isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || b === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}
