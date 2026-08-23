import type { ArtifactBranding, ArtifactSpec, ArtifactTheme, ResearchArtifactGeneration } from '../types/artifacts';

type ApiResponse<T> = { code: 0 | 1; message: string; data: T | null };

export type ArtifactDraftPreferences = {
  title?: string;
  audience?: string;
  theme?: ArtifactTheme;
  targetSlideCount?: number;
  targetPageCount?: number;
  branding?: ArtifactBranding;
  formats?: Array<'pptx' | 'pdf'>;
};

export type ImageProvider = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export function listArtifactImageProviders() {
  return request<{ providers: ImageProvider[] }>('/api/artifact-image-providers');
}

export function saveArtifactImageProvider(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }) {
  return request<{ provider: ImageProvider }>('/api/artifact-image-providers', { method: 'POST', body: input });
}

export function deleteArtifactImageProvider(id: string) {
  return request<{ deleted: boolean }>(`/api/artifact-image-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listResearchArtifactGenerations(conversationId: string) {
  return request<{ generations: ResearchArtifactGeneration[] }>(
    `/api/research/conversations/${encodeURIComponent(conversationId)}/artifacts`
  );
}

export function createResearchArtifactDraft(conversationId: string, preferences: ArtifactDraftPreferences = {}) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/research/conversations/${encodeURIComponent(conversationId)}/artifacts/drafts`,
    { method: 'POST', body: preferences }
  );
}

export function getResearchArtifactGeneration(id: string) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/artifacts/generations/${encodeURIComponent(id)}`
  );
}

export function updateResearchArtifactDraft(id: string, spec: ArtifactSpec) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/artifacts/generations/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { spec } }
  );
}

export function renderResearchArtifact(id: string) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/artifacts/generations/${encodeURIComponent(id)}/render`,
    { method: 'POST' }
  );
}

export function confirmResearchArtifactImageUse(id: string, imageUrl: string, sourceId?: string) {
  return request<{ consent: { id: string; generationId: string; imageUrl: string; sourceId?: string; confirmedAt: string } }>(
    `/api/artifacts/generations/${encodeURIComponent(id)}/image-consents`,
    { method: 'POST', body: { imageUrl, ...(sourceId ? { sourceId } : {}) } }
  );
}

export function fetchResearchArtifactSourceImage(input: {
  generationId: string;
  imageUrl: string;
  consentId: string;
  originalPageUrl?: string;
  sourceId?: string;
}) {
  return request<{ asset: {
    id: string;
    generationId: string;
    imageUrl: string;
    originalPageUrl?: string;
    sourceId?: string;
    licenseConfirmed: boolean;
    mimeType: string;
    byteSize: number;
  } }>(
    `/api/artifacts/generations/${encodeURIComponent(input.generationId)}/images/source`,
    {
      method: 'POST',
      body: {
        imageUrl: input.imageUrl,
        consentId: input.consentId,
        ...(input.originalPageUrl ? { originalPageUrl: input.originalPageUrl } : {}),
        ...(input.sourceId ? { sourceId: input.sourceId } : {})
      }
    }
  );
}

export function cancelResearchArtifact(id: string) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/artifacts/generations/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' }
  );
}

export function deleteResearchArtifactGeneration(id: string) {
  return request<{ deleted: boolean }>(`/api/artifacts/generations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function retryResearchArtifactOutput(id: string) {
  return request<{ generation: ResearchArtifactGeneration }>(
    `/api/artifacts/outputs/${encodeURIComponent(id)}/retry`,
    { method: 'POST' }
  );
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: init.method,
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || payload.code !== 1 || !payload.data) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload.data;
}
