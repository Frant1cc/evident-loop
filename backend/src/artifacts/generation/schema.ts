import { z } from 'zod';

import type {
  ArtifactPreferences,
  ArtifactSpec,
  PdfReportPlan,
  PresentationPlan,
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
  targetSlideCount: z.number().int().min(8).max(15)
}).strict();

const modelPresentationPlanSchema = z.object({
  slides: z.array(slideSchema).min(3).max(30),
  targetSlideCount: z.number().int().min(8).max(15)
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

export const artifactSpecSchema = z.object({
  title: text(200),
  audience: text(300),
  theme: z.enum(['research', 'technical', 'business']),
  branding: brandingSchema,
  brief: researchBriefSchema,
  presentation: presentationPlanSchema,
  pdf: pdfReportPlanSchema
}).strict();

export const artifactPreferencesSchema = z.object({
  title: text(200).optional(),
  audience: text(300).optional(),
  theme: z.enum(['research', 'technical', 'business']).optional(),
  targetSlideCount: z.number().int().min(8).max(15).optional(),
  targetPageCount: z.number().int().min(6).max(20).optional(),
  branding: brandingSchema.optional()
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

export function parseArtifactPlanModelOutput(value: unknown, fallback?: ArtifactPlanModelOutput): ArtifactPlanModelOutput {
  const completed = fallback ? completePlanModelOutput(value, fallback) : value;
  const parsed = z.object({
    brief: researchBriefSchema,
    presentation: modelPresentationPlanSchema,
    pdf: modelPdfReportPlanSchema
  }).strict().parse(completed);
  return parsed as ArtifactPlanModelOutput;
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

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown, max: number) {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => asNonEmptyString(item)).filter((item): item is string => Boolean(item)).slice(0, max);
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
      title: asNonEmptyString(briefIn.title) ?? fallback.brief.title,
      audience: asNonEmptyString(briefIn.audience) ?? fallback.brief.audience,
      executiveSummary: asNonEmptyString(briefIn.executiveSummary) ?? fallback.brief.executiveSummary,
      keyFindings: asStringArray(briefIn.keyFindings, 20) ?? fallback.brief.keyFindings,
      recommendations: asStringArray(briefIn.recommendations, 20) ?? fallback.brief.recommendations,
      sections: sections.length ? sections : fallback.brief.sections,
      citations
    },
    presentation: {
      slides: slides.length ? slides : fallback.presentation.slides,
      targetSlideCount: typeof presentationIn?.targetSlideCount === 'number'
        ? presentationIn.targetSlideCount
        : (slides.length ? slides.length : fallback.presentation.targetSlideCount)
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
  const citationKey = asNonEmptyString(value.citationKey);
  const sourceId = asNonEmptyString(value.sourceId);
  const title = asNonEmptyString(value.title);
  if (!citationKey || !sourceId || !title) return undefined;
  const locator = asNonEmptyString(value.locator);
  return locator ? { citationKey, sourceId, title, locator } : { citationKey, sourceId, title };
}

function completeBriefSection(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id);
  const title = asNonEmptyString(value.title);
  const summary = asNonEmptyString(value.summary);
  const keyPoints = asStringArray(value.keyPoints, 12);
  if (!id || !title || !summary || !keyPoints?.length) return undefined;
  return {
    id,
    title,
    summary,
    keyPoints,
    citations: asStringArray(value.citations, 24) ?? []
  };
}

function completeSlide(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id);
  const title = asNonEmptyString(value.title);
  const kind = value.kind === 'title' || value.kind === 'content' || value.kind === 'comparison' || value.kind === 'closing'
    ? value.kind
    : 'content';
  if (!id || !title) return undefined;
  const slide: Record<string, unknown> = {
    id,
    title,
    kind,
    bullets: asStringArray(value.bullets, 8) ?? [],
    citations: asStringArray(value.citations, 24) ?? []
  };
  const speakerNotes = asNonEmptyString(value.speakerNotes);
  if (speakerNotes) slide.speakerNotes = speakerNotes;
  if (isRecord(value.visual)) slide.visual = value.visual;
  return slide;
}

function completePdfSection(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = asNonEmptyString(value.id);
  const title = asNonEmptyString(value.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    paragraphs: asStringArray(value.paragraphs, 12) ?? [],
    bullets: asStringArray(value.bullets, 20) ?? [],
    citations: asStringArray(value.citations, 24) ?? []
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
