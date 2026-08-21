import { z } from 'zod';

import type { ArtifactApplication } from '../modules/artifacts/index.js';
import { defineTool } from './defineTool.js';
import type { ToolContext, ToolModule } from './contracts.js';
import { ToolExecutionError } from './contracts.js';

const artifactGenerationInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  audience: z.string().trim().min(1).max(300).optional(),
  theme: z.enum(['research', 'technical', 'business']).optional(),
  targetSlideCount: z.number().int().min(8).max(15).optional(),
  targetPageCount: z.number().int().min(6).max(20).optional(),
  branding: z.object({
    primaryColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
    logoUrl: z.string().url().refine((value) => value.startsWith('https://'), 'logoUrl must use HTTPS').optional(),
    titleFont: z.string().trim().min(1).max(120).optional(),
    bodyFont: z.string().trim().min(1).max(120).optional()
  }).strict().optional()
}).strict();

export function createStartArtifactGenerationTool(application: ArtifactApplication): ToolModule {
  return defineTool({
    label: '按需启动 Artifact Agent 草稿',
    name: 'start_artifact_generation',
    description: 'Start the on-demand logical Artifact Agent from a frozen research snapshot. Its explicit internal pipeline is plan -> consented asset resolution -> PPTX/PDF render -> per-page QA; this call only creates an editable draft and the user must confirm before rendering. It is not a ToolRuntime. Never pass shell commands, local paths, arbitrary URLs, or tool traces.',
    inputSchema: artifactGenerationInputSchema,
    annotations: { readOnlyHint: false },
    execute: (args, context) => startArtifactGeneration(application, args, context)
  });
}

async function startArtifactGeneration(application: ArtifactApplication, args: unknown, context?: ToolContext) {
  const input = artifactGenerationInputSchema.parse(args);
  const conversationId = context?.conversationId;
  if (!conversationId) {
    throw new ToolExecutionError({
      code: 'unauthorized',
      message: 'Artifact generation requires the current research conversation scope',
      retryable: false,
      reason: 'missing_conversation_scope'
    });
  }
  const researchRunId = typeof context.toolScope === 'object' && context.toolScope
    ? context.toolScope.runId
    : undefined;
  if (typeof context.toolScope === 'object' && context.toolScope?.conversationId
    && context.toolScope.conversationId !== conversationId) {
    throw new ToolExecutionError({
      code: 'unauthorized',
      message: 'Artifact generation scope does not match the current research conversation',
      retryable: false,
      reason: 'conversation_scope_mismatch'
    });
  }
  const result = await application.requestDraft(conversationId, {
    ...(input.title ? { title: input.title } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.targetSlideCount ? { targetSlideCount: input.targetSlideCount } : {}),
    ...(input.targetPageCount ? { targetPageCount: input.targetPageCount } : {}),
    ...(input.branding ? { branding: input.branding } : {})
  }, context.signal, { researchRunId });
  if (result.queued) {
    return {
      status: 'queued_until_research_complete',
      conversationId: result.conversationId,
      requestId: result.requestId,
      requiresConfirmation: true,
      message: result.message
    };
  }
  const draft = result.generation;
  return {
    generationId: draft.id,
    status: draft.status,
    version: draft.version,
    snapshotDigest: draft.snapshotDigest,
    title: draft.spec.title,
    audience: draft.spec.audience,
    theme: draft.spec.theme,
    slideCount: draft.spec.presentation.slides.length,
    pdfSectionCount: draft.spec.pdf.sections.length,
    requiresConfirmation: true,
    message: 'Artifact draft created. Present the editable outline to the user and wait for confirmation before rendering.'
  };
}
