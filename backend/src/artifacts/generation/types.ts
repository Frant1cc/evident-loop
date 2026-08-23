export const artifactStatuses = [
  'planning',
  'awaiting_confirmation',
  'rendering',
  'validating',
  'repairing',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'superseded'
] as const;

export type ArtifactStatus = (typeof artifactStatuses)[number];
export type ArtifactFormat = 'pptx' | 'pdf';
export type ArtifactOutputStatus =
  | 'pending'
  | 'rendering'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled';
export const artifactDraftRequestStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ArtifactDraftRequestStatus = (typeof artifactDraftRequestStatuses)[number];
export type ArtifactTheme = 'research' | 'technical' | 'business';

export type SnapshotMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type SnapshotSource = {
  id: string;
  citationKey: string;
  title: string;
  file: string;
  heading?: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
};

export type SnapshotNote = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchSnapshot = {
  conversationId: string;
  conversationTitle: string;
  topic?: string;
  summary?: string;
  messages: SnapshotMessage[];
  sources: SnapshotSource[];
  notes: SnapshotNote[];
  capturedAt: string;
  digest: string;
};

export type ArtifactCitation = {
  citationKey: string;
  sourceId: string;
  title: string;
  locator?: string;
};

export type ResearchBriefSection = {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  citations: string[];
};

export type ResearchBrief = {
  title: string;
  audience: string;
  executiveSummary: string;
  keyFindings: string[];
  recommendations: string[];
  sections: ResearchBriefSection[];
  citations: ArtifactCitation[];
};

export type PresentationSlide = {
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

export type PresentationPlan = {
  slides: PresentationSlide[];
  targetSlideCount: number;
};

export type PdfReportSection = {
  id: string;
  title: string;
  paragraphs: string[];
  bullets: string[];
  citations: string[];
};

export type PdfReportPlan = {
  sections: PdfReportSection[];
  targetPageCount: number;
};

export type ArtifactBranding = {
  primaryColor?: string;
  logoUrl?: string;
  titleFont?: string;
  bodyFont?: string;
};

export type ArtifactSpec = {
  title: string;
  audience: string;
  theme: ArtifactTheme;
  branding: ArtifactBranding;
  brief: ResearchBrief;
  presentation: PresentationPlan;
  pdf: PdfReportPlan;
  /** Files the user asked to render. Outline planning may still keep both plans. */
  formats: ArtifactFormat[];
};

export type ArtifactPreferences = {
  title?: string;
  audience?: string;
  theme?: ArtifactTheme;
  targetSlideCount?: number;
  targetPageCount?: number;
  branding?: ArtifactBranding;
  formats?: ArtifactFormat[];
};

export type ArtifactOutput = {
  id: string;
  generationId: string;
  version: number;
  format: ArtifactFormat;
  status: ArtifactOutputStatus;
  fileName?: string;
  contentType?: string;
  size?: number;
  downloadUrl?: string;
  previewUrl?: string;
  /** The exact format-local effective spec that produced this file. */
  renderedSpec?: ArtifactSpec;
  renderedSpecDigest?: string;
  provenance?: ArtifactVisualProvenance[];
  error?: string;
  diagnostics?: string[];
  /** Latest renderer progress message while status is rendering/validating. */
  progress?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactVisualProvenance = {
  kind: 'authorized_source_asset' | 'image_provider' | 'builtin_vector_shape';
  assetIds?: string[];
  providerId?: string;
  sourceUrls?: string[];
  detail?: string;
};

export type ArtifactImageConsent = {
  id: string;
  generationId: string;
  conversationId: string;
  imageUrl: string;
  sourceId?: string;
  confirmedAt: string;
};

export type ArtifactGeneration = {
  id: string;
  conversationId: string;
  version: number;
  snapshotDigest: string;
  status: ArtifactStatus;
  stale: boolean;
  spec: ArtifactSpec;
  snapshot: ResearchSnapshot;
  outputs: ArtifactOutput[];
  imageConsents?: ArtifactImageConsent[];
  createdAt: string;
  updatedAt: string;
};

/**
 * A durable request created by the research agent while its run is still
 * streaming. It is deliberately bound to the originating run so a later run
 * cannot accidentally consume an old natural-language request.
 */
export type ArtifactDraftRequest = {
  id: string;
  conversationId: string;
  researchRunId?: string;
  preferences?: ArtifactPreferences;
  status: ArtifactDraftRequestStatus;
  generationId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type RendererResult = {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  preview?: Buffer;
  previewContentType?: string;
  diagnostics?: string[];
  provenance?: ArtifactVisualProvenance[];
  renderedSpec?: ArtifactSpec;
  layoutManifest?: ArtifactLayoutManifest;
};

export type ArtifactLayoutBox = {
  id: string;
  page: number;
  kind: 'container' | 'text' | 'image' | 'table' | 'chart' | 'other';
  x: number;
  y: number;
  width: number;
  height: number;
  textLength?: number;
  estimatedTextHeight?: number;
  containerId?: string;
  scrollWidth?: number;
  clientWidth?: number;
  scrollHeight?: number;
  clientHeight?: number;
};

export type ArtifactLayoutPage = {
  page: number;
  width: number;
  height: number;
  boxes: ArtifactLayoutBox[];
  scrollWidth?: number;
  clientWidth?: number;
  scrollHeight?: number;
  clientHeight?: number;
};

/** Deterministic renderer geometry used by QA. It is deliberately a heuristic
 * contract: it can identify bounds, clipping and obvious overlap, but cannot
 * prove pixel-perfect absence of every visual collision. */
export type ArtifactLayoutManifest = {
  pageCount: number;
  pages: ArtifactLayoutPage[];
  limitations?: string[];
};

export type RendererContext = {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  assets?: ArtifactRenderAsset[];
  snapshot?: ResearchSnapshot;
  visualProvenance?: ArtifactVisualProvenance[];
};

export type ArtifactRenderAsset = {
  id: string;
  imageUrl: string;
  originalPageUrl?: string;
  mimeType: string;
  data: Buffer;
  licenseConfirmed: boolean;
};

export type ArtifactRenderer = {
  render: (
    spec: ArtifactSpec,
    snapshot: ResearchSnapshot,
    context?: RendererContext
  ) => Promise<RendererResult>;
};

export type QualityReport = {
  ok: boolean;
  diagnostics: string[];
  preview?: Buffer;
  previewContentType?: string;
};

export type ArtifactQualityInspector = {
  inspect: (
    format: ArtifactFormat,
    result: RendererResult,
    spec: ArtifactSpec,
    context?: RendererContext
  ) => Promise<QualityReport>;
};

export type ArtifactBinaryStore = {
  put: (key: string, buffer: Buffer) => Promise<void>;
  get: (key: string) => Promise<Buffer | null>;
  delete: (key: string) => Promise<void>;
};
