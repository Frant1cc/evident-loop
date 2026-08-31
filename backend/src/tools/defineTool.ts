import { z } from 'zod';

import type { JsonSchema, ToolModule } from './contracts.js';

export type DefineToolOptions = Omit<ToolModule, 'definition' | 'inputSchema'> & {
  name: string;
  description: string;
  inputSchema: z.ZodType;
};

/**
 * Defines a built-in tool from one Zod schema.
 *
 * The same schema is used to produce the model-facing JSON Schema and to validate
 * arguments immediately before execution. Keeping both operations here prevents
 * catalog metadata and executor validation from drifting apart.
 */
export function defineTool({
  name,
  description,
  inputSchema,
  ...module
}: DefineToolOptions): ToolModule {
  return {
    ...module,
    inputSchema,
    source: module.source ?? 'builtin',
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: toToolJsonSchema(inputSchema)
      }
    }
  };
}

function toToolJsonSchema(inputSchema: z.ZodType): JsonSchema {
  const generated = z.toJSONSchema(inputSchema) as JsonSchema & { $schema?: string };
  const { $schema: _schema, ...parameters } = generated;
  return parameters;
}
