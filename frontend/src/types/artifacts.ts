export type WordArtifact = {
  artifactId: string;
  fileName: string;
  downloadUrl: string;
  previewUrl: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  preset?: string;
};

export function parseWordArtifact(value: unknown): WordArtifact | undefined {
  if (!isRecord(value)) return undefined;

  const artifactId = readString(value.artifactId);
  const fileName = readString(value.fileName);
  const downloadUrl = readString(value.downloadUrl);
  const createdAt = readString(value.createdAt);
  const expiresAt = readString(value.expiresAt);
  const size = typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined;

  if (!artifactId || !fileName || !downloadUrl || !createdAt || !expiresAt || size === undefined) {
    return undefined;
  }

  return {
    artifactId,
    fileName,
    downloadUrl,
    previewUrl:
      readString(value.previewUrl) ??
      `/api/artifacts/${encodeURIComponent(artifactId)}/preview`,
    size,
    createdAt,
    expiresAt,
    preset: readString(value.preset)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
