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

export type ArtifactTheme = 'research' | 'technical' | 'business';
export type ArtifactStatus =
  | 'planning'
  | 'awaiting_confirmation'
  | 'rendering'
  | 'validating'
  | 'repairing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export type ArtifactOutputStatus = 'pending' | 'rendering' | 'validating' | 'completed' | 'failed' | 'cancelled';

export type ArtifactOutput = {
  id: string;
  generationId: string;
  version: number;
  format: 'pptx' | 'pdf' | 'docx';
  status: ArtifactOutputStatus;
  fileName?: string;
  contentType?: string;
  size?: number;
  downloadUrl?: string;
  previewUrl?: string;
  renderedSpec?: ArtifactSpec;
  renderedSpecDigest?: string;
  provenance?: Array<{
    kind: 'authorized_source_asset' | 'builtin_vector_shape';
    assetIds?: string[];
    providerId?: string;
    sourceUrls?: string[];
    detail?: string;
  }>;
  error?: string;
  diagnostics?: string[];
  progress?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactImageConsent = {
  id: string;
  generationId: string;
  conversationId: string;
  imageUrl: string;
  sourceId?: string;
  confirmedAt: string;
};

export type ArtifactSlide = {
  id: string;
  title: string;
  kind: 'title' | 'content' | 'comparison' | 'closing';
  bullets: string[];
  speakerNotes?: string;
  citations: string[];
  visual?:
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'bar'; labels: string[]; values: number[] };
};

export type ArtifactBranding = {
  primaryColor?: string;
  logoUrl?: string;
  titleFont?: string;
  bodyFont?: string;
};

export type LongformBlock =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string; citations: string[] }
  | { id: string; type: 'paragraph'; text: string; citations: string[] }
  | { id: string; type: 'bulletList'; items: string[]; citations: string[] }
  | { id: string; type: 'numberedList'; items: string[]; citations: string[] }
  | { id: string; type: 'table'; headers: string[]; rows: string[][]; citations: string[] }
  | { id: string; type: 'pageBreak' };

export type LongformPageSettings = {
  size: 'A4' | 'Letter';
  orientation: 'portrait' | 'landscape';
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  header?: string;
  footer?: string;
  pageNumbers: boolean;
};

export type ArtifactSpec = {
  title: string;
  audience: string;
  theme: ArtifactTheme;
  branding: ArtifactBranding;
  brief: {
    title: string;
    audience: string;
    executiveSummary: string;
    keyFindings: string[];
    recommendations: string[];
    sections: Array<{
      id: string;
      title: string;
      summary: string;
      keyPoints: string[];
      citations: string[];
    }>;
    citations: Array<{ citationKey: string; sourceId: string; title: string; locator?: string }>;
  };
  presentation: { slides: ArtifactSlide[]; targetSlideCount: number };
  longform: { blocks: LongformBlock[]; pageSettings: LongformPageSettings };
  pdf: { sections: Array<{ id: string; title: string; paragraphs: string[]; bullets: string[]; citations: string[] }>; targetPageCount: number };
  formats: Array<'pptx' | 'pdf' | 'docx'>;
};

export type ResearchArtifactGeneration = {
  id: string;
  conversationId: string;
  version: number;
  snapshotDigest: string;
  status: ArtifactStatus;
  stale: boolean;
  spec: ArtifactSpec;
  outputs: ArtifactOutput[];
  snapshot?: {
    conversationTitle: string;
  };
  imageConsents?: ArtifactImageConsent[];
  createdAt: string;
  updatedAt: string;
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
