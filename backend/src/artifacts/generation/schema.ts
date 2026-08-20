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

export function parseArtifactPlanModelOutput(value: unknown): ArtifactPlanModelOutput {
  const parsed = z.object({
    brief: researchBriefSchema,
    presentation: modelPresentationPlanSchema,
    pdf: modelPdfReportPlanSchema
  }).strict().parse(value);
  return parsed as ArtifactPlanModelOutput;
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
