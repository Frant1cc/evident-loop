import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';

type SchemaResult = {
  valid: boolean;
  schemaValid: boolean;
  reason?: string;
};

type CachedSchema = {
  validate?: ValidateFunction;
  reason?: string;
};

/**
 * Compiles remote JSON schemas at the MCP boundary. Ajv types and diagnostics
 * stay inside this module; the tool runtime only sees a boolean and a reason.
 */
export class McpSchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly ajv2020 = new Ajv2020({ allErrors: true, strict: false });
  private readonly cache = new Map<string, CachedSchema>();

  compile(modelName: string, schema: unknown): SchemaResult {
    const key = `${modelName}:${hashSchema(schema)}`;
    const cached = this.cache.get(key);
    if (cached) return { valid: Boolean(cached.validate), schemaValid: Boolean(cached.validate), ...(cached.reason ? { reason: cached.reason } : {}) };
    try {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error('inputSchema must be a JSON object');
      }
      const declaredType = (schema as { type?: unknown }).type;
      if (declaredType !== undefined && declaredType !== 'object') {
        throw new Error('inputSchema.type must be object');
      }
      const validate = this.compileWithDraftFallback(schema as object);
      this.cache.set(key, { validate });
      return { valid: true, schemaValid: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'inputSchema could not be compiled';
      this.cache.set(key, { reason });
      return { valid: false, schemaValid: false, reason };
    }
  }

  private compileWithDraftFallback(schema: object): ValidateFunction {
    try {
      return this.ajv.compile(schema);
    } catch (firstError) {
      try {
        return this.ajv2020.compile(schema);
      } catch {
        throw firstError;
      }
    }
  }

  validate(modelName: string, schema: unknown, args: unknown): SchemaResult {
    const key = `${modelName}:${hashSchema(schema)}`;
    let compiled = this.cache.get(key);
    if (!compiled) {
      this.compile(modelName, schema);
      compiled = this.cache.get(key);
    }
    if (!compiled?.validate) {
      return {
        valid: false,
        schemaValid: false,
        ...(compiled?.reason ? { reason: compiled.reason } : {})
      };
    }
    const valid = compiled.validate(args);
    if (valid) return { valid: true, schemaValid: true };
    const reason = this.ajv.errorsText(compiled.validate.errors, { separator: '; ' }) || 'arguments do not match inputSchema';
    return { valid: false, schemaValid: true, reason };
  }
}

function hashSchema(value: unknown): string {
  return createHash('sha256').update(stableStringify(value) ?? 'undefined').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}
