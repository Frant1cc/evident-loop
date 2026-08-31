/**
 * Zod schemas for unified document generation.
 * Phase 1: Domain model and single tool
 */

import { z } from 'zod';
import type {
  DocumentGenerationSpec,
  LongformDeliverable,
  PresentationDeliverable,
  ResearchBrief
} from './documentTypes.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const citationKeys = z.array(text(80)).max(24);

// Citation schema
const citationSchema = z.object({
  citationKey: text(80),
  sourceId: text(120),
  title: text(500),
  locator: text(300).optional()
}).strict();

// Brief section schema
const briefSectionSchema = z.object({
  id: text(80),
  title: text(200),
  summary: text(4_000),
  keyPoints: z.array(text(1_000)).min(1).max(12),
  citations: citationKeys
}).strict();

// Research brief schema
export const researchBriefSchema = z.object({
  title: text(200),
  audience: text(300),
  executiveSummary: text(8_000),
  keyFindings: z.array(text(1_000)).min(1).max(20),
  recommendations: z.array(text(1_000)).max(20),
  sections: z.array(briefSectionSchema).min(1).max(20),
  citations: z.array(citationSchema).max(100)
}).strict();

// Presentation slide schema
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

// Longform block schemas
const longformBlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: text(80),
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: text(500),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('paragraph'),
    text: text(8_000),
    alignment: z.enum(['left', 'center', 'right', 'justify']).optional(),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('bulletList'),
    items: z.array(text(1_000)).min(1).max(20),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('numberedList'),
    items: z.array(text(1_000)).min(1).max(20),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('table'),
    headers: z.array(text(200)).min(1).max(12),
    rows: z.array(z.array(text(500)).max(12)).min(1).max(50),
    citations: citationKeys
  }).strict(),
  z.object({
    id: text(80),
    type: z.literal('pageBreak'),
    citations: z.array(z.never()).length(0)
  }).strict()
]);

// Presentation deliverable schema
const presentationDeliverableSchema = z.object({
  id: text(80),
  documentType: z.literal('presentation'),
  formats: z.tuple([z.literal('pptx')]),
  targetSlideCount: z.number().int().min(8).max(30),
  slides: z.array(slideSchema).min(8).max(30)
}).strict();

// Longform deliverable schema
const longformDeliverableSchema = z.object({
  id: text(80),
  documentType: z.literal('longform'),
  formats: z.array(z.enum(['docx', 'pdf'])).min(1).max(2),
  subtitle: text(300).optional(),
  author: text(120).optional(),
  targetPageCount: z.number().int().min(6).max(30),
  page: z.object({
    size: z.enum(['A4', 'LETTER']),
    orientation: z.enum(['portrait', 'landscape']),
    margins: z.object({
      top: z.number().min(5).max(50),
      right: z.number().min(5).max(50),
      bottom: z.number().min(5).max(50),
      left: z.number().min(5).max(50)
    }).strict(),
    showHeader: z.boolean(),
    headerText: text(200).optional(),
    footerText: text(200).optional(),
    showPageNumber: z.boolean()
  }).strict(),
  blocks: z.array(longformBlockSchema).min(1).max(120)
}).strict();

// Branding schema
const brandingSchema = z.object({
  primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().refine((value) => value.startsWith('https://'), 'logoUrl must use HTTPS').optional(),
  titleFont: text(120).optional(),
  bodyFont: text(120).optional()
}).strict();

// Main document generation spec schema
export const documentGenerationSpecSchema = z.object({
  title: text(200),
  audience: text(300),
  theme: z.enum(['research', 'technical', 'business']),
  branding: brandingSchema,
  brief: researchBriefSchema,
  deliverables: z.array(
    z.discriminatedUnion('documentType', [
      presentationDeliverableSchema,
      longformDeliverableSchema
    ])
  ).min(1).max(2)
}).strict().refine((data) => {
  // Validate deliverable IDs are unique
  const ids = data.deliverables.map(d => d.id);
  return ids.length === new Set(ids).size;
}, 'Deliverable IDs must be unique').refine((data) => {
  // Validate no duplicate document types
  const types = data.deliverables.map(d => d.documentType);
  return types.length === new Set(types).size;
}, 'Cannot have multiple deliverables of the same type').refine((data) => {
  // Validate all block IDs are unique across all deliverables
  const blockIds: string[] = [];
  for (const deliverable of data.deliverables) {
    if (deliverable.documentType === 'presentation') {
      blockIds.push(...deliverable.slides.map(s => s.id));
    } else if (deliverable.documentType === 'longform') {
      blockIds.push(...deliverable.blocks.map(b => b.id));
    }
  }
  return blockIds.length === new Set(blockIds).size;
}, 'Block and slide IDs must be unique within the generation').refine((data) => {
  // Validate longform has at least one non-pageBreak block
  for (const deliverable of data.deliverables) {
    if (deliverable.documentType === 'longform') {
      const hasContent = deliverable.blocks.some(b => b.type !== 'pageBreak');
      if (!hasContent) return false;
    }
  }
  return true;
}, 'Longform deliverable must have at least one content block');

export function parseDocumentGenerationSpec(value: unknown): DocumentGenerationSpec {
  return documentGenerationSpecSchema.parse(value) as DocumentGenerationSpec;
}

export function validateDocumentCitations(spec: DocumentGenerationSpec) {
  const sourceKeys = new Set(spec.brief.citations.map((citation) => citation.citationKey));
  const missing: string[] = [];

  // Check brief sections
  for (const section of spec.brief.sections) {
    for (const key of section.citations) {
      if (!sourceKeys.has(key)) missing.push(key);
    }
  }

  // Check deliverables
  for (const deliverable of spec.deliverables) {
    if (deliverable.documentType === 'presentation') {
      for (const slide of deliverable.slides) {
        for (const key of slide.citations) {
          if (!sourceKeys.has(key)) missing.push(key);
        }
      }
    } else if (deliverable.documentType === 'longform') {
      for (const block of deliverable.blocks) {
        for (const key of block.citations) {
          if (!sourceKeys.has(key)) missing.push(key);
        }
      }
    }
  }

  return [...new Set(missing)];
}
