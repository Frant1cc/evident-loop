import type { ArtifactBranding, ArtifactSpec, ArtifactTheme, ResearchArtifactGeneration } from '../types/artifacts';

type ApiResponse<T> = { code: 0 | 1; message: string; data: T | null };

export type ArtifactDraftPreferences = {
  title?: string;
  audience?: string;
  theme?: ArtifactTheme;
  targetSlideCount?: number;
  targetPageCount?: number;
  branding?: ArtifactBranding;
  formats?: Array<'pptx' | 'pdf' | 'docx'>;
};

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
    { method: 'PATCH', body: { spec: serializeArtifactSpec(spec) } }
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

function serializeArtifactSpec(spec: ArtifactSpec) {
  const { longform, ...persisted } = spec;
  if (!longform) return persisted;

  const sections: ArtifactSpec['pdf']['sections'] = [];
  let current: ArtifactSpec['pdf']['sections'][number] | undefined;
  const ensureSection = () => {
    if (!current) {
      current = { id: `section-${sections.length + 1}`, title: '正文', paragraphs: [], bullets: [], citations: [] };
      sections.push(current);
    }
    return current;
  };

  for (const block of longform.blocks) {
    if (block.type === 'heading') {
      current = {
        id: block.id,
        title: block.text || '未命名章节',
        paragraphs: [],
        bullets: [],
        citations: [...block.citations]
      };
      sections.push(current);
    } else if (block.type === 'paragraph') {
      ensureSection().paragraphs.push(block.text);
      ensureSection().citations.push(...block.citations);
    } else if (block.type === 'bulletList' || block.type === 'numberedList') {
      ensureSection().bullets.push(...block.items);
      ensureSection().citations.push(...block.citations);
    } else if (block.type === 'table') {
      const tableText = [block.headers.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n');
      ensureSection().paragraphs.push(tableText);
      ensureSection().citations.push(...block.citations);
    } else if (block.type === 'pageBreak') {
      current = undefined;
    }
  }

  const normalizedSections = sections.filter((section) =>
    section.paragraphs.length || section.bullets.length || section.title !== '正文'
  );
  return {
    ...persisted,
    pdf: {
      ...persisted.pdf,
      sections: normalizedSections.length ? normalizedSections : persisted.pdf.sections,
      targetPageCount: Math.min(20, Math.max(6, normalizedSections.length + 2))
    }
  };
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
