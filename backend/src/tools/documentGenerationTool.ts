import { z } from 'zod';

import type { ArtifactApplication } from '../modules/artifacts/index.js';
import { defineTool } from './defineTool.js';
import type { ToolContext, ToolModule } from './contracts.js';
import { ToolExecutionError } from './contracts.js';

const deliverableSchema = z.discriminatedUnion('documentType', [
  z.object({
    documentType: z.literal('presentation'),
    formats: z.tuple([z.literal('pptx')]),
    targetSlideCount: z.number().int().min(8).max(15).optional()
  }).strict(),
  z.object({
    documentType: z.literal('longform'),
    formats: z.array(z.enum(['docx', 'pdf'])).min(1).max(2),
    targetPageCount: z.number().int().min(6).max(20).optional()
  }).strict()
]);

const documentGenerationInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  audience: z.string().trim().min(1).max(300).optional(),
  theme: z.enum(['research', 'technical', 'business']).optional(),
  branding: z.object({
    primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
    logoUrl: z.string().url().refine((value) => value.startsWith('https://'), 'logoUrl must use HTTPS').optional(),
    titleFont: z.string().trim().min(1).max(120).optional(),
    bodyFont: z.string().trim().min(1).max(120).optional()
  }).strict().optional(),
  deliverables: z.array(deliverableSchema).min(1).max(2)
}).strict();

export function createStartDocumentGenerationTool(application: ArtifactApplication): ToolModule {
  return defineTool({
    label: '文档生成',
    name: 'start_document_generation',
    description: `Start a document generation draft from the current research conversation.
Use this tool when the user explicitly asks to generate, export, create, or download a document (Word, DOCX, PDF report, PPT, PPTX, or slides).

Deliverable selection rules:
- Word / DOCX only → deliverables: [{documentType: "longform", formats: ["docx"]}]
- PDF report / 长篇 PDF only → deliverables: [{documentType: "longform", formats: ["pdf"]}]
- Word and PDF → deliverables: [{documentType: "longform", formats: ["docx", "pdf"]}]
- PPT / PPTX / slides / 演示文稿 only → deliverables: [{documentType: "presentation", formats: ["pptx"]}]
- PPT and formal report → deliverables: [{documentType: "presentation", formats: ["pptx"]}, {documentType: "longform", formats: [...explicit formats]}]
- PPT export to PDF → not supported; ask the user which format they want

If the format is ambiguous, ask the user before calling this tool. Never default to all formats.
This call only creates an editable draft; the user must confirm before rendering begins.
Never call any renderer directly. Do not repeat download instructions or URLs in the final answer.`,
    inputSchema: documentGenerationInputSchema,
    annotations: { readOnlyHint: false },
    execute: (args, context) => startDocumentGeneration(application, args, context)
  });
}

async function startDocumentGeneration(application: ArtifactApplication, args: unknown, context?: ToolContext) {
  const input = documentGenerationInputSchema.parse(args);
  const conversationId = context?.conversationId;
  if (!conversationId) {
    throw new ToolExecutionError({
      code: 'unauthorized',
      message: 'Document generation requires the current research conversation scope',
      retryable: false,
      reason: 'missing_conversation_scope'
    });
  }
  if (typeof context.toolScope === 'object' && context.toolScope?.conversationId
    && context.toolScope.conversationId !== conversationId) {
    throw new ToolExecutionError({
      code: 'unauthorized',
      message: 'Document generation scope does not match the current research conversation',
      retryable: false,
      reason: 'conversation_scope_mismatch'
    });
  }
  const researchRunId = typeof context.toolScope === 'object' && context.toolScope
    ? context.toolScope.runId
    : undefined;

  const presentation = input.deliverables.find((deliverable) => deliverable.documentType === 'presentation');
  const longform = input.deliverables.find((deliverable) => deliverable.documentType === 'longform');
  const formats = input.deliverables.flatMap((deliverable) => [...deliverable.formats]);
  const preferences = {
    ...(input.title ? { title: input.title } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.branding ? { branding: input.branding } : {}),
    ...(presentation?.targetSlideCount ? { targetSlideCount: presentation.targetSlideCount } : {}),
    ...(longform?.targetPageCount ? { targetPageCount: longform.targetPageCount } : {}),
    formats
  };

  const result = await application.requestDraft(conversationId, preferences, context.signal, { researchRunId });

  if (result.queued) {
    return {
      status: 'awaiting_confirmation' as const,
      conversationId: result.conversationId,
      generationId: result.requestId,
      requiresConfirmation: true as const,
      deliverables: input.deliverables.map((d) => ({
        documentType: d.documentType,
        formats: d.formats,
        itemCount: 0
      })),
      message: result.message
    };
  }

  const draft = result.generation;
  const deliverableSummary = input.deliverables.map((d) => ({
    documentType: d.documentType,
    formats: d.formats,
    itemCount: d.documentType === 'presentation'
      ? (draft.spec as { presentation?: { slides?: unknown[] } }).presentation?.slides?.length ?? 0
      : (draft.spec as { pdf?: { sections?: unknown[] } }).pdf?.sections?.length ?? 0
  }));

  return {
    generationId: draft.id,
    status: 'awaiting_confirmation' as const,
    version: draft.version,
    deliverables: deliverableSummary,
    requiresConfirmation: true as const
  };
}
