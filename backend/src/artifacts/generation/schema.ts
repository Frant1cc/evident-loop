import { z } from 'zod';

import { normalizeArtifactFormats } from './formats.js';
import type {
  ArtifactFormat,
  ArtifactPreferences,
  ArtifactSpec,
  PdfReportPlan,
  PresentationPlan,
  PresentationSlide,
  ResearchBrief
} from './types.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const citationKeys = z.array(text(80)).max(24);

const citationSchema = z.object({
  citationKey: text(80),
  sourceId: text(120),
  title: text(500),
  locator: text(300).optional()
}).strict();

const briefSectionSchema = z.object({
  id: text(80),
  title: text(200),
  summary: text(4_000),
  keyPoints: z.array(text(1_000)).min(1).max(12),
  citations: citationKeys
}).strict();

export const researchBriefSchema = z.object({
  title: text(200),
  audience: text(300),
  executiveSummary: text(8_000),
  keyFindings: z.array(text(1_000)).min(1).max(20),
  recommendations: z.array(text(1_000)).max(20),
  sections: z.array(briefSectionSchema).min(1).max(20),
  citations: z.array(citationSchema).max(100)
}).strict();

const slideSchema = z.object({
  id: text(80),
  title: text(200),
  kind: z.enum(['title', 'content', 'comparison', 'closing']),
  bullets: z.array(text(1_000)).max(8),
  html: text(60_000).optional(),
  speakerNotes: text(4_000).optional(),
  citations: citationKeys,
  visual: z.union([
    z.object({
      type: z.literal('table'),
      headers: z.array(text(200)).min(1).max(12),
      rows: z.array(z.array(text(500)).max(12)).max(50)
    }).strict(),
    z.object({
      type: z.literal('bar'),
      labels: z.array(text(120)).min(1).max(20),
      values: z.array(z.number().finite()).min(1).max(20)
    }).strict()
  ]).optional()
}).strict();

export const presentationPlanSchema = z.object({
  // A confirmed plan is renderable only when it contains a real deck-sized
  // outline. Short model plans are rejected during planning; the renderer
  // never invents filler slides.
  slides: z.array(slideSchema).min(8).max(30),
  targetSlideCount: z.number().int().min(8).max(15),
  themeCss: text(64_000).optional()
}).strict();

const modelPresentationPlanSchema = z.object({
  slides: z.array(slideSchema).min(3).max(30),
  targetSlideCount: z.number().int().min(8).max(15),
  themeCss: text(64_000).optional()
}).strict();

const reportSectionSchema = z.object({
  id: text(80),
  title: text(200),
  paragraphs: z.array(text(8_000)).max(12),
  bullets: z.array(text(1_000)).max(20),
  citations: citationKeys
}).strict();

export const pdfReportPlanSchema = z.object({
  sections: z.array(reportSectionSchema).min(4).max(30),
  targetPageCount: z.number().int().min(6).max(20)
}).strict();

const editableText = (max: number) => z.string().max(max);
const artifactLongformBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: text(80),
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: editableText(500),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('paragraph'),
    text: editableText(8_000),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('bulletList'),
    items: z.array(editableText(1_000)).min(1).max(20),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('numberedList'),
    items: z.array(editableText(1_000)).min(1).max(20),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('table'),
    headers: z.array(editableText(200)).max(12),
    rows: z.array(z.array(editableText(500)).max(12)).max(50),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('pageBreak')
  }).strict()
]);

const artifactLongformStateSchema = z.object({
  blocks: z.array(artifactLongformBlockSchema).max(120),
  pageSettings: z.object({
    size: z.enum(['A4', 'Letter']),
    orientation: z.enum(['portrait', 'landscape']),
    marginTop: z.number().finite().min(5).max(50),
    marginBottom: z.number().finite().min(5).max(50),
    marginLeft: z.number().finite().min(5).max(50),
    marginRight: z.number().finite().min(5).max(50),
    header: editableText(200).optional(),
    footer: editableText(200).optional(),
    pageNumbers: z.boolean()
  }).strict()
}).strict();

const modelPdfReportPlanSchema = z.object({
  sections: z.array(reportSectionSchema).min(3).max(30),
  targetPageCount: z.number().int().min(6).max(20)
}).strict();

const brandingSchema = z.object({
  primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().refine((value) => value.startsWith('https://'), 'logoUrl must use HTTPS').optional(),
  titleFont: text(120).optional(),
  bodyFont: text(120).optional()
}).strict();

const artifactFormatsSchema = z.preprocess(
  (value) => normalizeArtifactFormats(value) ?? ['pptx', 'pdf'],
  z.array(z.enum(['pptx', 'docx', 'pdf'])).min(1).max(3)
);

export const artifactSpecSchema = z.object({
  title: text(200),
  audience: text(300),
  theme: z.enum(['research', 'technical', 'business']),
  branding: brandingSchema,
  brief: researchBriefSchema,
  presentation: presentationPlanSchema,
  pdf: pdfReportPlanSchema,
  longform: artifactLongformStateSchema.optional(),
  formats: artifactFormatsSchema
}).strict();

export const artifactPreferencesSchema = z.object({
  title: text(200).optional(),
  audience: text(300).optional(),
  theme: z.enum(['research', 'technical', 'business']).optional(),
  targetSlideCount: z.number().int().min(8).max(15).optional(),
  targetPageCount: z.number().int().min(6).max(20).optional(),
  branding: brandingSchema.optional(),
  formats: z.array(z.enum(['pptx', 'docx', 'pdf'])).min(1).max(3).optional()
}).strict();

export type ArtifactPlanModelOutput = {
  brief: ResearchBrief;
  presentation: PresentationPlan;
  pdf: PdfReportPlan;
};

export function parseArtifactSpec(value: unknown): ArtifactSpec {
  return artifactSpecSchema.parse(value) as ArtifactSpec;
}

export function parseArtifactPreferences(value: unknown): ArtifactPreferences {
  return artifactPreferencesSchema.parse(value) as ArtifactPreferences;
}

export function parseArtifactPlanModelOutput(
  value: unknown,
  fallback?: ArtifactPlanModelOutput,
  requestedFormats?: ArtifactFormat[]
): ArtifactPlanModelOutput {
  const completed = fallback ? completePlanModelOutput(value, fallback) : value;
  if (!fallback || !requestedFormats) {
    const parsed = z.object({
      brief: researchBriefSchema,
      presentation: modelPresentationPlanSchema,
      pdf: modelPdfReportPlanSchema
    }).strict().parse(completed);
    return parsed as ArtifactPlanModelOutput;
  }

  const root = z.object({
    brief: z.unknown(),
    presentation: z.unknown(),
    pdf: z.unknown()
  }).strict().parse(completed);
  const wantsPresentation = requestedFormats.includes('pptx');
  const wantsLongform = requestedFormats.includes('pdf') || requestedFormats.includes('docx');
  return {
    brief: researchBriefSchema.parse(root.brief) as ResearchBrief,
    presentation: wantsPresentation
      ? modelPresentationPlanSchema.parse(root.presentation) as PresentationPlan
      : fallback.presentation,
    pdf: wantsLongform
      ? modelPdfReportPlanSchema.parse(root.pdf) as PdfReportPlan
      : fallback.pdf
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapPlanRoot(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  for (const key of ['plan', 'spec', 'artifact', 'output', 'data']) {
    if (!isRecord(value[key])) continue;
    const nested = unwrapPlanRoot(value[key]);
    if (nested.brief !== undefined || nested.presentation !== undefined || nested.pdf !== undefined) {
      return nested;
    }
  }
  return value;
}

function asNonEmptyString(value: unknown, maxLength?: number) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (maxLength === undefined || trimmed.length <= maxLength) return trimmed;
  const clipped = trimmed.slice(0, maxLength);
  // Avoid leaving a dangling UTF-16 high surrogate when clipping emoji or
  // supplementary characters at a schema boundary.
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function asStringArray(value: unknown, maxItems: number, maxItemLength: number) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => asNonEmptyString(item, maxItemLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items;
}

function completePlanModelOutput(value: unknown, fallback: ArtifactPlanModelOutput): ArtifactPlanModelOutput {
  const root = unwrapPlanRoot(value);
  const briefIn = isRecord(root.brief) ? root.brief : {};
  const presentationIn = [root.presentation, root.presentationPlan, root.deck].find(isRecord);
  const pdfIn = [root.pdf, root.pdfPlan, root.report].find(isRecord);

  const citations = Array.isArray(briefIn.citations)
    ? briefIn.citations.map(completeCitation).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 100)
    : fallback.brief.citations;
  const sections = Array.isArray(briefIn.sections) && briefIn.sections.length
    ? briefIn.sections.map(completeBriefSection).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 20)
    : fallback.brief.sections;

  const slides = presentationIn && Array.isArray(presentationIn.slides) && presentationIn.slides.length
    ? presentationIn.slides.map(completeSlide).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 30)
    : fallback.presentation.slides;
  const pdfSections = pdfIn && Array.isArray(pdfIn.sections) && pdfIn.sections.length
    ? pdfIn.sections.map(completePdfSection).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 30)
    : fallback.pdf.sections;

  return {
    brief: {
      title: asNonEmptyString(briefIn.title, 200) ?? fallback.brief.title,
      audience: asNonEmptyString(briefIn.audience, 300) ?? fallback.brief.audience,
      executiveSummary: asNonEmptyString(briefIn.executiveSummary, 8_000) ?? fallback.brief.executiveSummary,
      keyFindings: asStringArray(briefIn.keyFindings, 20, 1_000) ?? fallback.brief.keyFindings,
      recommendations: asStringArray(briefIn.recommendations, 20, 1_000) ?? fallback.brief.recommendations,
      sections: sections.length ? sections : fallback.brief.sections,
      citations
    },
    presentation: {
      slides: slides.length ? slides : fallback.presentation.slides,
      targetSlideCount: typeof presentationIn?.targetSlideCount === 'number'
        ? presentationIn.targetSlideCount
        : (slides.length ? slides.length : fallback.presentation.targetSlideCount),
      ...(asNonEmptyString(presentationIn?.themeCss, 64_000) || fallback.presentation.themeCss
        ? { themeCss: asNonEmptyString(presentationIn?.themeCss, 64_000) ?? fallback.presentation.themeCss }
        : {})
    },
    pdf: {
      sections: pdfSections.length ? pdfSections : fallback.pdf.sections,
      targetPageCount: typeof pdfIn?.targetPageCount === 'number'
        ? pdfIn.targetPageCount
        : (pdfSections.length ? pdfSections.length + 2 : fallback.pdf.targetPageCount)
    }
  };
}

function completeCitation(value: unknown) {
  if (!isRecord(value)) return undefined;
  const citationKey = asNonEmptyString(value.citationKey, 80);
  const sourceId = asNonEmptyString(value.sourceId, 120);
  const title = asNonEmptyString(value.title, 500);
  if (!citationKey || !sourceId || !title) return undefined;
  const locator = asNonEmptyString(value.locator, 300);
  return locator ? { citationKey, sourceId, title, locator } : { citationKey, sourceId, title };
}

function completeBriefSection(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id, 80);
  const title = asNonEmptyString(value.title, 200);
  const summary = asNonEmptyString(value.summary, 4_000);
  const keyPoints = asStringArray(value.keyPoints, 12, 1_000);
  if (!id || !title || !summary || !keyPoints?.length) return undefined;
  return {
    id,
    title,
    summary,
    keyPoints,
    citations: asStringArray(value.citations, 24, 80) ?? []
  };
}

function completeSlide(value: unknown): PresentationSlide | undefined {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id, 80);
  const title = asNonEmptyString(value.title, 200);
  const kind = value.kind === 'title' || value.kind === 'content' || value.kind === 'comparison' || value.kind === 'closing'
    ? value.kind
    : 'content';
  if (!id || !title) return undefined;
  const slide: PresentationSlide = {
    id,
    title,
    kind,
    bullets: asStringArray(value.bullets, 8, 1_000) ?? [],
    citations: asStringArray(value.citations, 24, 80) ?? []
  };
  const html = asNonEmptyString(value.html, 60_000);
  if (html) slide.html = html;
  const speakerNotes = asNonEmptyString(value.speakerNotes, 4_000);
  if (speakerNotes) slide.speakerNotes = speakerNotes;
  const visual = completeVisual(value.visual);
  if (visual) slide.visual = visual;
  return slide;
}

function completeVisual(value: unknown): PresentationSlide['visual'] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'table') {
    const headers = asStringArray(value.headers, 12, 200);
    const rows = Array.isArray(value.rows)
      ? value.rows.slice(0, 50).map((row) => asStringArray(row, 12, 500) ?? [])
      : [];
    if (!headers?.length || !rows.length) return undefined;
    return { type: 'table', headers, rows };
  }
  if (value.type === 'bar') {
    const labels = asStringArray(value.labels, 20, 120);
    const values = Array.isArray(value.values)
      ? value.values.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).slice(0, 20)
      : [];
    if (!labels?.length || !values.length) return undefined;
    return { type: 'bar', labels, values };
  }
  return undefined;
}

function completePdfSection(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id, 80);
  const title = asNonEmptyString(value.title, 200);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    paragraphs: asStringArray(value.paragraphs, 12, 8_000) ?? [],
    bullets: asStringArray(value.bullets, 20, 1_000) ?? [],
    citations: asStringArray(value.citations, 24, 80) ?? []
  };
}

export function validateArtifactCitations(spec: ArtifactSpec) {
  const sourceKeys = new Set(spec.brief.citations.map((citation) => citation.citationKey));
  const missing: string[] = [];
  for (const section of spec.brief.sections) {
    for (const key of section.citations) if (!sourceKeys.has(key)) missing.push(key);
  }
  for (const slide of spec.presentation.slides) {
    for (const key of slide.citations) if (!sourceKeys.has(key)) missing.push(key);
  }
  for (const section of spec.pdf.sections) {
    for (const key of section.citations) if (!sourceKeys.has(key)) missing.push(key);
  }
  return [...new Set(missing)];
}
