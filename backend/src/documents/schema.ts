import { z } from 'zod';

import { markdownToDocumentBlocks } from './markdown.js';
import { documentPresetNames, type DocumentSpecInput } from './types.js';

const textSchema = (max: number) => z.string().trim().min(1).max(max);
const optionalTextSchema = (max: number) => z.string().trim().min(1).max(max).optional();

const blockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      text: textSchema(300)
    })
    .strict(),
  z
    .object({
      type: z.literal('paragraph'),
      text: textSchema(5_000),
      alignment: z.enum(['left', 'center', 'right', 'justify']).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('bulletList'),
      items: z.array(textSchema(1_000)).min(1).max(100)
    })
    .strict(),
  z
    .object({
      type: z.literal('numberedList'),
      items: z.array(textSchema(1_000)).min(1).max(100)
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      headers: z.array(textSchema(200)).min(1).max(12),
      rows: z.array(z.array(z.string().trim().max(2_000)).max(12)).min(1).max(100)
    })
    .strict(),
  z.object({ type: z.literal('pageBreak') }).strict()
]);

const formatSchema = z
  .object({
    preset: z.enum(documentPresetNames).optional(),
    pageSize: z.enum(['A4', 'LETTER']).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    margins: z
      .object({
        top: z.number().min(5).max(50).optional(),
        right: z.number().min(5).max(50).optional(),
        bottom: z.number().min(5).max(50).optional(),
        left: z.number().min(5).max(50).optional()
      })
      .strict()
      .optional(),
    titleFont: optionalTextSchema(80),
    titleFontSize: z.number().min(16).max(36).optional(),
    headingFont: optionalTextSchema(80),
    bodyFont: optionalTextSchema(80),
    bodyFontSize: z.number().min(9).max(16).optional(),
    lineSpacing: z.number().min(1).max(2).optional(),
    primaryColor: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color')
      .optional(),
    showHeader: z.boolean().optional(),
    headerText: optionalTextSchema(200),
    footerText: optionalTextSchema(200),
    showPageNumber: z.boolean().optional()
  })
  .strict();

const commonDocumentShape = {
  fileName: optionalTextSchema(160),
  title: textSchema(200),
  subtitle: optionalTextSchema(300),
  author: optionalTextSchema(120),
  format: formatSchema.optional()
};

export const documentSpecSchema = z
  .object({
    ...commonDocumentShape,
    blocks: z.array(blockSchema).min(1).max(120)
  })
  .strict();

const markdownDocumentSpecSchema = z
  .object({
    ...commonDocumentShape,
    contentMarkdown: textSchema(40_000)
  })
  .strict();

const documentToolInputSchema = z.union([markdownDocumentSpecSchema, documentSpecSchema]);

const normalizedDocumentSpecSchema = documentSpecSchema.superRefine((spec, context) => {
  let totalChars = spec.title.length + (spec.subtitle?.length ?? 0) + (spec.author?.length ?? 0);

  for (const [blockIndex, block] of spec.blocks.entries()) {
    if (block.type === 'heading' || block.type === 'paragraph') totalChars += block.text.length;
    if (block.type === 'bulletList' || block.type === 'numberedList') {
      totalChars += block.items.reduce((sum, item) => sum + item.length, 0);
    }
    if (block.type === 'table') {
      totalChars += block.headers.reduce((sum, cell) => sum + cell.length, 0);
      for (const [rowIndex, row] of block.rows.entries()) {
        totalChars += row.reduce((sum, cell) => sum + cell.length, 0);
        if (row.length !== block.headers.length) {
          context.addIssue({
            code: 'custom',
            path: ['blocks', blockIndex, 'rows', rowIndex],
            message: `must contain exactly ${block.headers.length} cells`
          });
        }
      }
    }
  }

  if (totalChars > 40_000) {
    context.addIssue({
      code: 'custom',
      path: ['blocks'],
      message: 'document content exceeds the 40000 character limit'
    });
  }
});

export function parseDocumentSpec(args: unknown): DocumentSpecInput {
  const inputResult = documentToolInputSchema.safeParse(args);
  if (!inputResult.success) throwInvalidDocumentSpecification(inputResult.error);

  const input = inputResult.data;
  const normalized: DocumentSpecInput =
    'contentMarkdown' in input
      ? {
          fileName: input.fileName,
          title: input.title,
          subtitle: input.subtitle,
          author: input.author,
          format: input.format,
          blocks: markdownToDocumentBlocks(input.contentMarkdown)
        }
      : input;

  const result = normalizedDocumentSpecSchema.safeParse(normalized);
  if (result.success) return result.data;
  throwInvalidDocumentSpecification(result.error);
}

function throwInvalidDocumentSpecification(error: z.ZodError): never {
  const details = error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid document specification: ${details}`);
}
