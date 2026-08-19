import { z } from 'zod';

import { generateWordDocument } from '../wordDocumentTool.js';
import { defineTool } from '../defineTool.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();

const formatSchema = z.object({
  preset: z.enum(['research-report', 'technical-report', 'business-report', 'simple']).optional(),
  pageSize: z.enum(['A4', 'LETTER']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  margins: z.object({
    top: z.number().min(5).max(50).optional(),
    right: z.number().min(5).max(50).optional(),
    bottom: z.number().min(5).max(50).optional(),
    left: z.number().min(5).max(50).optional()
  }).optional(),
  titleFont: optionalText(80),
  titleFontSize: z.number().min(16).max(36).optional(),
  headingFont: optionalText(80),
  bodyFont: optionalText(80),
  bodyFontSize: z.number().min(9).max(16).optional(),
  lineSpacing: z.number().min(1).max(2).optional(),
  primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  showHeader: z.boolean().optional(),
  headerText: optionalText(200),
  footerText: optionalText(200),
  showPageNumber: z.boolean().optional()
});

const blockSchema = z.object({
  type: z.string().min(1),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  level: z.number().int().optional(),
  alignment: z.string().optional()
});

const documentInputSchema = z.object({
  fileName: optionalText(160),
  title: text(200),
  subtitle: optionalText(300),
  author: optionalText(120),
  contentMarkdown: text(40_000).optional(),
  blocks: z.array(blockSchema).min(1).max(120).optional(),
  format: formatSchema.optional()
});

export const documentToolModules = [
  defineTool({
    label: '生成 Word 文档',
    name: 'generate_word_document',
    description:
      'Generate a downloadable DOCX only when the user explicitly asks to create, export, or download a Word/DOCX document. Put the complete body in contentMarkdown instead of constructing JSON block arrays. Supported Markdown: #/##/### headings, paragraphs, - bullet lists, 1. numbered lists, pipe tables, fenced code as plain text, and <!-- pagebreak -->. Do not repeat title/subtitle in contentMarkdown. Choose research-report for research and analysis, technical-report for architecture and implementation plans, business-report for decisions and action plans, and simple for general notes. Call at most once per user request. The client renders preview and download actions from the structured tool result. Do not repeat downloadUrl, previewUrl, localhost URLs, Markdown download links, or download instructions in the final prose.',
    inputSchema: documentInputSchema,
    execute: generateWordDocument
  })
];
