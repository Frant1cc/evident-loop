import { randomUUID } from 'node:crypto';

import { sqlite } from '../../db.js';
import { parseArtifactSpec } from './schema.js';
import type {
  ArtifactDraftRequest,
  ArtifactDraftRequestStatus,
  ArtifactFormat,
  ArtifactGeneration,
  ArtifactOutput,
  ArtifactOutputStatus,
  ArtifactSpec,
  ArtifactStatus,
  ArtifactVisualProvenance,
  ResearchSnapshot
} from './types.js';

type GenerationRow = {
  id: string;
  conversation_id: string;
  version: number;
  snapshot_digest: string;
  status: ArtifactStatus;
  stale: number;
  spec_json: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
};

type OutputRow = {
  id: string;
  generation_id: string;
  version: number;
  format: ArtifactFormat;
  status: ArtifactOutputStatus;
  file_name: string | null;
  content_type: string | null;
  size: number | null;
  storage_key: string | null;
  preview_key: string | null;
  provenance_json: string | null;
  rendered_spec_json: string | null;
  rendered_spec_digest: string | null;
  error: string | null;
  diagnostics_json: string | null;
  progress: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

type AssetRow = {
  id: string;
  generation_id: string;
  source_id: string | null;
  original_page_url: string | null;
  image_url: string;
  license_confirmed: number;
  mime_type: string;
  byte_size: number;
  pixel_width: number | null;
  pixel_height: number | null;
  storage_key: string;
  created_at: string;
};

type ConsentRow = {
  id: string;
  generation_id: string;
  conversation_id: string;
  image_url: string;
  source_id: string | null;
  confirmed_at: string;
};

type DraftRequestRow = {
  id: string;
  conversation_id: string;
  research_run_id: string | null;
  preferences_json: string | null;
  status: ArtifactDraftRequestStatus;
  generation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ArtifactBinaryReference = {
  storageKey: string;
  previewKey?: string;
};

export type ArtifactMediaCopy = {
  sourceStorageKey: string;
  targetStorageKey: string;
  targetAssetId: string;
};

export function createArtifactDraftRequest(input: {
  conversationId: string;
  researchRunId: string;
  preferences?: unknown;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO research_artifact_draft_requests
    (id, conversation_id, research_run_id, preferences_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(
      id,
      input.conversationId,
      input.researchRunId,
      input.preferences === undefined ? null : JSON.stringify(input.preferences),
      now,
      now
    );
  return getArtifactDraftRequest(id)!;
}

export function getArtifactDraftRequest(id: string) {
  const row = sqlite.prepare('SELECT * FROM research_artifact_draft_requests WHERE id = ?')
    .get(id) as DraftRequestRow | undefined;
  return row ? toDraftRequest(row) : undefined;
}

export function listArtifactDraftRequests(conversationId: string, researchRunId?: string) {
  const rows = researchRunId === undefined
    ? sqlite.prepare(`SELECT * FROM research_artifact_draft_requests
        WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId)
    : sqlite.prepare(`SELECT * FROM research_artifact_draft_requests
        WHERE conversation_id = ? AND research_run_id = ? ORDER BY created_at ASC`).all(conversationId, researchRunId);
  return (rows as DraftRequestRow[]).map(toDraftRequest);
}

/** Atomically claims one queued request so only one process plans it. */
export function claimArtifactDraftRequest(id: string) {
  const now = new Date().toISOString();
  const result = sqlite.prepare(`UPDATE research_artifact_draft_requests
    SET status = 'running', updated_at = ?
    WHERE id = ? AND status = 'queued'`).run(now, id);
  return result.changes ? getArtifactDraftRequest(id) : undefined;
}

export function finishArtifactDraftRequest(input: {
  id: string;
  status: Extract<ArtifactDraftRequestStatus, 'completed' | 'failed' | 'cancelled'>;
  generationId?: string;
  error?: string;
}) {
  const now = new Date().toISOString();
  sqlite.prepare(`UPDATE research_artifact_draft_requests SET
    status = ?, generation_id = ?, error = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status IN ('queued', 'running')`)
    .run(
      input.status,
      input.generationId ?? null,
      input.error ?? null,
      now,
      now,
      input.id
    );
  return getArtifactDraftRequest(input.id);
}

export function failInFlightArtifactDraftRequests(error: string) {
  const now = new Date().toISOString();
  return sqlite.prepare(`UPDATE research_artifact_draft_requests SET
    status = 'failed', error = ?, updated_at = ?, completed_at = ?
    WHERE status = 'running'`).run(error, now, now).changes;
}

export function finalizeArtifactDraftRequests(input: {
  conversationId: string;
  researchRunId?: string;
  status: Extract<ArtifactDraftRequestStatus, 'failed' | 'cancelled'>;
  error: string;
}) {
  const now = new Date().toISOString();
  const result = input.researchRunId === undefined
    ? sqlite.prepare(`UPDATE research_artifact_draft_requests SET
        status = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE conversation_id = ? AND status IN ('queued', 'running')`)
      .run(input.status, input.error, now, now, input.conversationId)
    : sqlite.prepare(`UPDATE research_artifact_draft_requests SET
        status = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE conversation_id = ? AND research_run_id = ? AND status IN ('queued', 'running')`)
      .run(input.status, input.error, now, now, input.conversationId, input.researchRunId);
  return result.changes;
}

export function createArtifactGeneration(input: {
  conversationId: string;
  snapshot: ResearchSnapshot;
  spec: ArtifactSpec;
  status?: ArtifactStatus;
}) {
  // The UNIQUE(conversation_id, version) constraint is the cross-process
  // serialization point. A short retry handles another backend instance
  // winning the same MAX(version)+1 race without exposing duplicate versions.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const version = nextVersion(input.conversationId);
    try {
      sqlite.prepare(`INSERT INTO research_artifacts
        (id, conversation_id, version, snapshot_digest, status, stale, spec_json, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(
          id,
          input.conversationId,
          version,
          input.snapshot.digest,
          input.status ?? 'awaiting_confirmation',
          JSON.stringify(input.spec),
          JSON.stringify(input.snapshot),
          now,
          now
        );
      return getArtifactGeneration(id)!;
    } catch (error) {
      if (!isVersionConflict(error) || attempt === 4) throw error;
    }
  }
  throw new Error('Artifact version allocation failed');
}

export function cloneArtifactGenerationAsVersion(source: ArtifactGeneration) {
  return createArtifactGeneration({
    conversationId: source.conversationId,
    snapshot: source.snapshot,
    spec: source.spec,
    status: 'rendering'
  });
}

/**
 * Re-home the draft's durable visual records to a confirmed generation.
 * Asset binaries are copied by the service because the binary store is async;
 * this transaction only creates new rows and never lets two generations share
 * a mutable storage key. Consents receive new ids as well so deleting either
 * generation cannot revoke or cascade through the other version.
 */
export function cloneArtifactGenerationMedia(sourceGenerationId: string, targetGenerationId: string) {
  return sqlite.transaction(() => {
    const assets = sqlite.prepare('SELECT * FROM research_artifact_assets WHERE generation_id = ? ORDER BY created_at ASC')
      .all(sourceGenerationId) as AssetRow[];
    const mediaCopies: ArtifactMediaCopy[] = [];
    for (const asset of assets) {
      const targetAssetId = randomUUID();
      const targetStorageKey = `assets/${targetGenerationId}/${targetAssetId}`;
      sqlite.prepare(`INSERT INTO research_artifact_assets
        (id, generation_id, source_id, original_page_url, image_url, license_confirmed, mime_type, byte_size, pixel_width, pixel_height, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          targetAssetId,
          targetGenerationId,
          asset.source_id,
          asset.original_page_url,
          asset.image_url,
          asset.license_confirmed,
          asset.mime_type,
          asset.byte_size,
          asset.pixel_width,
          asset.pixel_height,
          targetStorageKey,
          asset.created_at
        );
      mediaCopies.push({
        sourceStorageKey: asset.storage_key,
        targetStorageKey,
        targetAssetId
      });
    }

    const consents = sqlite.prepare('SELECT * FROM research_artifact_image_consents WHERE generation_id = ? ORDER BY confirmed_at ASC')
      .all(sourceGenerationId) as ConsentRow[];
    for (const consent of consents) {
      sqlite.prepare(`INSERT INTO research_artifact_image_consents
        (id, generation_id, conversation_id, image_url, source_id, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          targetGenerationId,
          consent.conversation_id,
          consent.image_url,
          consent.source_id,
          consent.confirmed_at
        );
    }
    return { mediaCopies, consentCount: consents.length };
  })();
}

export function getArtifactGeneration(id: string): ArtifactGeneration | undefined {
  const row = sqlite.prepare('SELECT * FROM research_artifacts WHERE id = ?').get(id) as GenerationRow | undefined;
  if (!row) return undefined;
  const outputRows = sqlite.prepare(`SELECT * FROM research_artifact_outputs
    WHERE generation_id = ? ORDER BY format ASC`).all(id) as OutputRow[];
  return toGeneration(row, outputRows);
}

export function listArtifactGenerations(conversationId: string) {
  const rows = sqlite.prepare(`SELECT * FROM research_artifacts
    WHERE conversation_id = ? ORDER BY version DESC`).all(conversationId) as GenerationRow[];
  const outputStatement = sqlite.prepare(`SELECT * FROM research_artifact_outputs
    WHERE generation_id = ? ORDER BY format ASC`);
  return rows.map((row) => toGeneration(row, outputStatement.all(row.id) as OutputRow[]));
}

export function updateArtifactSpec(id: string, spec: ArtifactSpec) {
  const updatedAt = new Date().toISOString();
  sqlite.prepare('UPDATE research_artifacts SET spec_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(spec), updatedAt, id);
  return getArtifactGeneration(id);
}

export function updateArtifactGeneration(id: string, changes: {
  status?: ArtifactStatus;
  stale?: boolean;
}) {
  const current = sqlite.prepare('SELECT * FROM research_artifacts WHERE id = ?').get(id) as GenerationRow | undefined;
  if (!current) return undefined;
  const updatedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE research_artifacts SET status = ?, stale = ?, updated_at = ? WHERE id = ?`)
    .run(changes.status ?? current.status, changes.stale === undefined ? current.stale : changes.stale ? 1 : 0, updatedAt, id);
  return getArtifactGeneration(id);
}

export function createArtifactOutput(generationId: string, version: number, format: ArtifactFormat) {
  const now = new Date().toISOString();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO research_artifact_outputs
    (id, generation_id, version, format, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`)
    .run(id, generationId, version, format, now, now);
  return getArtifactOutput(id)!;
}

export function getArtifactOutput(id: string): ArtifactOutput | undefined {
  const row = sqlite.prepare('SELECT * FROM research_artifact_outputs WHERE id = ?').get(id) as OutputRow | undefined;
  return row ? toOutput(row) : undefined;
}

export function getArtifactOutputByFormat(generationId: string, format: ArtifactFormat) {
  const row = sqlite.prepare('SELECT * FROM research_artifact_outputs WHERE generation_id = ? AND format = ?')
    .get(generationId, format) as OutputRow | undefined;
  return row ? toOutput(row) : undefined;
}

export function updateArtifactOutput(id: string, changes: {
  status?: ArtifactOutputStatus;
  fileName?: string;
  contentType?: string;
  size?: number;
  storageKey?: string;
  previewKey?: string;
  provenance?: ArtifactVisualProvenance[];
  renderedSpec?: ArtifactSpec;
  renderedSpecDigest?: string;
  error?: string;
  diagnostics?: string[];
  progress?: string;
  attempts?: number;
}) {
  const current = sqlite.prepare('SELECT * FROM research_artifact_outputs WHERE id = ?').get(id) as OutputRow | undefined;
  if (!current) return undefined;
  const updatedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE research_artifact_outputs SET
    status = ?, file_name = ?, content_type = ?, size = ?, storage_key = ?, preview_key = ?,
    provenance_json = ?, rendered_spec_json = ?, rendered_spec_digest = ?, error = ?, diagnostics_json = ?, progress = ?, attempts = ?, updated_at = ? WHERE id = ?`)
    .run(
      changes.status ?? current.status,
      changes.fileName ?? current.file_name,
      changes.contentType ?? current.content_type,
      changes.size ?? current.size,
      changes.storageKey ?? current.storage_key,
      changes.previewKey ?? current.preview_key,
      'provenance' in changes ? changes.provenance ? JSON.stringify(changes.provenance) : null : current.provenance_json,
      'renderedSpec' in changes ? changes.renderedSpec ? JSON.stringify(changes.renderedSpec) : null : current.rendered_spec_json,
      'renderedSpecDigest' in changes ? changes.renderedSpecDigest ?? null : current.rendered_spec_digest,
      'error' in changes ? changes.error ?? null : current.error,
      'diagnostics' in changes ? changes.diagnostics ? JSON.stringify(changes.diagnostics) : null : current.diagnostics_json,
      'progress' in changes ? changes.progress ?? null : current.progress,
      changes.attempts ?? current.attempts,
      updatedAt,
      id
    );
  return getArtifactOutput(id);
}

export function listArtifactBinaryReferences(conversationId: string) {
  return sqlite.prepare(`SELECT storage_key, preview_key FROM research_artifact_outputs
    JOIN research_artifacts ON research_artifacts.id = research_artifact_outputs.generation_id
    WHERE research_artifacts.conversation_id = ? AND (storage_key IS NOT NULL OR preview_key IS NOT NULL)
    UNION ALL
    SELECT research_artifact_assets.storage_key, NULL AS preview_key
    FROM research_artifact_assets
    JOIN research_artifacts ON research_artifacts.id = research_artifact_assets.generation_id
    WHERE research_artifacts.conversation_id = ?`)
    .all(conversationId, conversationId)
    .flatMap((row) => {
      const reference = row as { storage_key: string | null; preview_key: string | null };
      return reference.storage_key
        ? [{ storageKey: reference.storage_key, ...(reference.preview_key ? { previewKey: reference.preview_key } : {}) }]
        : reference.preview_key ? [{ storageKey: reference.preview_key }] : [];
    });
}

export function listArtifactBinaryReferencesForGeneration(generationId: string) {
  return sqlite.prepare(`SELECT storage_key, preview_key FROM research_artifact_outputs
    WHERE generation_id = ? AND (storage_key IS NOT NULL OR preview_key IS NOT NULL)
    UNION ALL
    SELECT storage_key, NULL AS preview_key FROM research_artifact_assets
    WHERE generation_id = ?`)
    .all(generationId, generationId)
    .flatMap((row) => {
      const reference = row as { storage_key: string | null; preview_key: string | null };
      return reference.storage_key
        ? [{ storageKey: reference.storage_key, ...(reference.preview_key ? { previewKey: reference.preview_key } : {}) }]
        : reference.preview_key ? [{ storageKey: reference.preview_key }] : [];
    });
}

export function listArtifactAssets(generationId: string) {
  return (sqlite.prepare('SELECT * FROM research_artifact_assets WHERE generation_id = ? ORDER BY created_at ASC').all(generationId) as AssetRow[])
    .map((row) => ({
      id: row.id,
      generationId: row.generation_id,
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      ...(row.original_page_url ? { originalPageUrl: row.original_page_url } : {}),
      imageUrl: row.image_url,
      licenseConfirmed: row.license_confirmed === 1,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      ...(row.pixel_width === null ? {} : { pixelWidth: row.pixel_width }),
      ...(row.pixel_height === null ? {} : { pixelHeight: row.pixel_height }),
      storageKey: row.storage_key
    }));
}

export function createArtifactImageConsent(input: {
  generationId: string;
  conversationId: string;
  imageUrl: string;
  sourceId?: string;
}) {
  const existing = sqlite.prepare(`SELECT * FROM research_artifact_image_consents
    WHERE generation_id = ? AND image_url = ?`).get(input.generationId, input.imageUrl) as ConsentRow | undefined;
  if (existing) return toConsent(existing);
  const now = new Date().toISOString();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO research_artifact_image_consents
    (id, generation_id, conversation_id, image_url, source_id, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.generationId, input.conversationId, input.imageUrl, input.sourceId ?? null, now);
  return getArtifactImageConsent(id)!;
}

export function getArtifactImageConsent(id: string) {
  const row = sqlite.prepare('SELECT * FROM research_artifact_image_consents WHERE id = ?').get(id) as ConsentRow | undefined;
  return row ? toConsent(row) : undefined;
}

export function listArtifactImageConsents(generationId: string) {
  return (sqlite.prepare('SELECT * FROM research_artifact_image_consents WHERE generation_id = ? ORDER BY confirmed_at ASC').all(generationId) as ConsentRow[])
    .map(toConsent);
}

export function deleteArtifactRecordsForGeneration(generationId: string) {
  return sqlite.prepare('DELETE FROM research_artifacts WHERE id = ?').run(generationId).changes > 0;
}

export function deleteArtifactRecordsForConversation(conversationId: string) {
  return sqlite.prepare('DELETE FROM research_artifacts WHERE conversation_id = ?').run(conversationId).changes > 0;
}

function nextVersion(conversationId: string) {
  const row = sqlite.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM research_artifacts WHERE conversation_id = ?')
    .get(conversationId) as { version: number };
  return row.version + 1;
}

function isVersionConflict(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed: research_artifacts\.conversation_id, research_artifacts\.version/i.test(error.message);
}

function toConsent(row: ConsentRow) {
  return {
    id: row.id,
    generationId: row.generation_id,
    conversationId: row.conversation_id,
    imageUrl: row.image_url,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    confirmedAt: row.confirmed_at
  };
}

function toDraftRequest(row: DraftRequestRow): ArtifactDraftRequest {
  let preferences: ArtifactDraftRequest['preferences'];
  if (row.preferences_json) {
    try {
      preferences = JSON.parse(row.preferences_json) as ArtifactDraftRequest['preferences'];
    } catch {
      preferences = undefined;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ...(row.research_run_id ? { researchRunId: row.research_run_id } : {}),
    ...(preferences === undefined ? {} : { preferences }),
    status: row.status,
    ...(row.generation_id ? { generationId: row.generation_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function toGeneration(row: GenerationRow, outputRows: OutputRow[]): ArtifactGeneration {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    version: row.version,
    snapshotDigest: row.snapshot_digest,
    status: row.status,
    stale: row.stale === 1,
    spec: parseArtifactSpec(JSON.parse(row.spec_json)),
    snapshot: JSON.parse(row.snapshot_json) as ResearchSnapshot,
    outputs: outputRows.map(toOutput),
    imageConsents: listArtifactImageConsents(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toOutput(row: OutputRow): ArtifactOutput {
  const diagnostics = parseStringArray(row.diagnostics_json);
  const provenance = parseProvenance(row.provenance_json);
  const renderedSpec = parseRenderedSpec(row.rendered_spec_json);
  return {
    id: row.id,
    generationId: row.generation_id,
    version: row.version,
    format: row.format,
    status: row.status,
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.content_type ? { contentType: row.content_type } : {}),
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.storage_key ? { downloadUrl: `/api/artifact-files/${encodeURIComponent(row.id)}/download` } : {}),
    ...(row.preview_key ? { previewUrl: `/api/artifact-files/${encodeURIComponent(row.id)}/preview` } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(provenance.length ? { provenance } : {}),
    ...(renderedSpec ? { renderedSpec } : {}),
    ...(row.rendered_spec_digest ? { renderedSpecDigest: row.rendered_spec_digest } : {}),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseRenderedSpec(value: string | null): ArtifactSpec | undefined {
  if (!value) return undefined;
  try {
    return parseArtifactSpec(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseProvenance(value: string | null): ArtifactVisualProvenance[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ArtifactVisualProvenance => {
      if (!item || typeof item !== 'object') return false;
      const kind = (item as { kind?: unknown }).kind;
      return kind === 'authorized_source_asset' || kind === 'builtin_vector_shape';
    });
  } catch {
    return [];
  }
}

function parseStringArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
