import { createHash } from 'node:crypto';

import type {
  ToolCall,
  ToolCatalog,
  ToolContext,
  ToolModule,
  ToolPolicy,
  ToolRuntime,
  ToolScope,
  ToolSnapshot
} from './contracts.js';
import { ToolExecutionError } from './contracts.js';
import { toolCatalog } from './registry.js';

/**
 * Creates the in-memory tool runtime used by all agent surfaces.
 *
 * A snapshot is a cheap read of the current registry. It contains the exact
 * definitions offered to one model turn, while execution checks that snapshot
 * again so a guessed, hidden, removed, or changed tool cannot run.
 */
export function createToolRuntime(catalog: ToolCatalog): ToolRuntime {
  let version = 0;
  let catalogFingerprint = '';

  const listModules = () => [...catalog.values()];

  const getSnapshot = (policy: ToolPolicy = { mode: 'all' }, scope?: ToolScope): ToolSnapshot => {
    const snapshotPolicy = freezePolicy(policy);
    // Map insertion order is the registry's deterministic order. Dynamic adapters
    // can therefore append newly discovered tools without reordering existing ones.
    const entries = [...catalog.entries()];
    const nextFingerprint = hashValue(entries.map(([name, module]) => [
      name,
      module.definition,
      module.annotations,
      module.exposedToModel !== false,
      module.source ?? 'builtin'
    ]));

    if (nextFingerprint !== catalogFingerprint) {
      catalogFingerprint = nextFingerprint;
      version += 1;
    }

    const selectedNames = snapshotPolicy.mode === 'selected' ? new Set(snapshotPolicy.names) : undefined;
    const selectedEntries = snapshotPolicy.mode === 'none'
      ? []
      : entries.filter(([, module]) => module.exposedToModel !== false)
        .filter(([name]) => !selectedNames || selectedNames.has(name));
    const modules = createReadonlyMap(selectedEntries);
    const definitions = selectedEntries.map(([, module]) => module.definition);
    const definitionHashes = new Map(
      selectedEntries.map(([name, module]) => [name, hashValue(module.definition)] as const)
    );

    return Object.freeze({
      version,
      ...(scope === undefined ? {} : { scope }),
      policy: snapshotPolicy,
      definitions: Object.freeze([...definitions]),
      toolNames: createReadonlySet(modules.keys()),
      definitionHashes: createReadonlyMap(definitionHashes),
      modules
    });
  };

  const prepareToolCall = (snapshot: ToolSnapshot, toolCall: ToolCall) => {
    const name = toolCall.name;
    const snapshotModule = snapshot.modules.get(name);
    const currentModule = catalog.get(name);

    if (!snapshotModule) {
      if (currentModule) {
        throw new ToolExecutionError({
          code: 'unauthorized',
          message: `Tool is not authorized in this snapshot: ${name}`,
          retryable: false,
          reason: 'The tool is hidden or was excluded by ToolPolicy.'
        });
      }
      throw new ToolExecutionError({
        code: 'unknown_tool',
        message: `Unknown tool: ${name}`,
        retryable: false,
        reason: 'The tool is not registered.'
      });
    }

    if (!currentModule) {
      throw new ToolExecutionError({
        code: 'unavailable',
        message: `Tool is no longer available: ${name}`,
        retryable: true,
        reason: 'The tool disappeared after this snapshot was created.'
      });
    }

    const expectedHash = snapshot.definitionHashes.get(name);
    if (!expectedHash || expectedHash !== hashValue(currentModule.definition)) {
      throw new ToolExecutionError({
        code: 'schema_changed',
        message: `Tool schema changed after this snapshot was created: ${name}`,
        retryable: true,
        reason: 'Refresh the tool snapshot before retrying.'
      });
    }

    const availability = resolveAvailability(currentModule);
    if (availability.status !== 'available') {
      throw new ToolExecutionError({
        code: 'unavailable',
        message: availability.reason ?? `Tool is unavailable: ${name}`,
        retryable: availability.retryable ?? true,
        reason: availability.reason
      });
    }

    const parsedArguments = parseToolArguments(snapshotModule, toolCall.arguments);

    return { module: snapshotModule, arguments: parsedArguments };
  };

  const executeSnapshot = async (
    snapshot: ToolSnapshot,
    toolCall: ToolCall,
    context?: ToolContext
  ): Promise<unknown> => {
    const { module, arguments: parsedArguments } = prepareToolCall(snapshot, toolCall);

    try {
      return await module.execute(parsedArguments, context);
    } catch (error) {
      if (error instanceof ToolExecutionError) throw error;
      const message = error instanceof Error ? error.message : 'Tool call failed';
      throw new ToolExecutionError({
        code: 'execution_failed',
        message,
        retryable: false,
        reason: error instanceof Error ? error.name : undefined
      });
    }
  };

  const execute = async (
    snapshotOrName: ToolSnapshot | string,
    toolCallOrArguments: ToolCall | unknown,
    context?: ToolContext
  ) => {
    if (typeof snapshotOrName === 'string') {
      return executeSnapshot(
        getSnapshot({ mode: 'all' }),
        { name: snapshotOrName, arguments: toolCallOrArguments },
        context
      );
    }
    return executeSnapshot(snapshotOrName, toolCallOrArguments as ToolCall, context);
  };

  const runtime: ToolRuntime = {
    listModules,
    listCatalog: listModules,
    getSnapshot,
    getDefinitions: (policy = { mode: 'all' }) => [...getSnapshot(policy).definitions],
    execute,
    validate: (snapshot, toolCall) => prepareToolCall(snapshot, toolCall).arguments,
    register: (module: ToolModule) => {
      if (!(catalog instanceof Map)) {
        throw new Error('This tool catalog is read-only');
      }
      const name = module.definition.function.name;
      if (catalog.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
      catalog.set(name, module);
    },
    upsert: (module: ToolModule) => {
      if (!(catalog instanceof Map)) {
        throw new Error('This tool catalog is read-only');
      }
      catalog.set(module.definition.function.name, module);
    },
    unregister: (name: string) => {
      if (!(catalog instanceof Map)) {
        throw new Error('This tool catalog is read-only');
      }
      catalog.delete(name);
    }
  };

  return runtime;
}

function parseToolArguments(module: ToolModule, args: unknown): unknown {
  if (!module.inputSchema) return args;

  const parsed = module.inputSchema.safeParse(args);
  if (parsed.success) return parsed.data;

  const reason = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new ToolExecutionError({
    code: 'invalid_arguments',
    message: `Invalid arguments for ${module.definition.function.name}`,
    retryable: false,
    reason
  });
}

function resolveAvailability(module: ToolModule) {
  if (!module.availability) return { status: 'available' as const };
  return typeof module.availability === 'function' ? module.availability() : module.availability;
}

function freezePolicy(policy: ToolPolicy): ToolPolicy {
  if (policy.mode === 'selected') {
    const names = Object.freeze([...policy.names]);
    return Object.freeze({
      mode: 'selected' as const,
      names: names as unknown as string[]
    }) as ToolPolicy;
  }
  return Object.freeze({ mode: policy.mode });
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

function createReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries);
  return {
    get: map.get.bind(map),
    has: map.has.bind(map),
    keys: map.keys.bind(map),
    values: map.values.bind(map),
    entries: map.entries.bind(map),
    forEach: map.forEach.bind(map),
    get size() {
      return map.size;
    },
    [Symbol.iterator]: map[Symbol.iterator].bind(map)
  };
}

function createReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  return {
    has: set.has.bind(set),
    keys: set.keys.bind(set),
    values: set.values.bind(set),
    entries: set.entries.bind(set),
    forEach: set.forEach.bind(set),
    get size() {
      return set.size;
    },
    [Symbol.iterator]: set[Symbol.iterator].bind(set)
  };
}

export const builtInToolRuntime = createToolRuntime(toolCatalog);
