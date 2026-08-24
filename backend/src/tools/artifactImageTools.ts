import { z } from 'zod';

import type { ArtifactApplication } from '../modules/artifacts/index.js';
import { defineTool } from './defineTool.js';
import type { ToolContext, ToolModule } from './contracts.js';
import { ToolExecutionError } from './contracts.js';

const fetchSourceImageSchema = z.object({
  generationId: z.string().trim().uuid(),
  imageUrl: z.string().trim().url(),
  originalPageUrl: z.string().trim().url().optional(),
  sourceId: z.string().trim().max(120).optional(),
  consentId: z.string().trim().uuid()
}).strict();

export function createArtifactImageTools(application: ArtifactApplication): ToolModule[] {
  return [
    defineTool({
      label: '获取来源图片',
      name: 'fetch_source_image',
      description: 'Fetch a user-confirmed HTTPS source-page image for an artifact. The server enforces SSRF, redirect, MIME, byte, and pixel limits and stores page/image URL plus license confirmation provenance. Never pass local paths or arbitrary non-HTTPS URLs.',
      inputSchema: fetchSourceImageSchema,
      annotations: { readOnlyHint: false },
      execute: (args, context) => fetchImage(application, args, context)
    })
  ];
}

async function fetchImage(application: ArtifactApplication, args: unknown, context?: ToolContext) {
  const input = fetchSourceImageSchema.parse(args);
  const conversationId = requireConversationScope(input.generationId, context);
  application.assertGenerationConversation(input.generationId, conversationId);
  return application.fetchSourceImage(input, { signal: context?.signal }, conversationId);
}

function requireConversationScope(_generationId: string, context?: ToolContext) {
  if (!context?.conversationId) {
    throw new ToolExecutionError({
      code: 'unauthorized',
      message: 'Artifact image tools require a research conversation scope',
      retryable: false,
      reason: 'missing_conversation_scope'
    });
  }
  return context.conversationId;
}
