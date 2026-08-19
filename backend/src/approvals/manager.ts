import { randomUUID } from 'node:crypto';

import { ToolExecutionError } from '../tools/contracts.js';
import type {
  ApprovalAuthorizationRequest,
  ApprovalManager,
  ApprovalManagerOptions,
  ApprovalStore,
  ToolApprovalDecision,
  ToolApprovalDto,
  ToolApprovalRecord,
  ToolApprovalScope,
  ToolApprovalStatus
} from './contracts.js';
import { ApprovalDecisionConflictError, ApprovalNotFoundError } from './contracts.js';
import { createApprovalStore } from './store.js';

type ApprovalContext = {
  request: ApprovalAuthorizationRequest;
  resolve: () => void;
  reject: (error: unknown) => void;
  resolution: Promise<void>;
  settled: boolean;
  onAbort?: () => void;
  terminalError?: ToolExecutionError;
};

/**
 * Approval is deliberately a narrow interceptor: it decides whether a provider
 * tool may cross into its module executor, while ToolRuntime remains the final
 * authorization/schema/availability gate immediately before execution.
 */
export function createApprovalManager(options: ApprovalManagerOptions = {}): ApprovalManager {
  const store: ApprovalStore = options.store ?? createApprovalStore();
  const now = options.now ?? (() => new Date());
  const contexts = new Map<string, ApprovalContext>();

  store.ensureSchema();
  // A process cannot safely resume an in-flight remote call. Pending rows from
  // a previous process therefore become terminal before any API can expose them.
  store.expirePending(now().toISOString());

  const toDto = (record: ToolApprovalRecord): ToolApprovalDto => ({
    ...record,
    arguments: redactToolArguments(record.arguments)
  });

  const settle = (record: ToolApprovalRecord, terminalError?: ToolExecutionError) => {
    const context = contexts.get(record.id);
    if (!context || context.settled) return;

    context.settled = true;
    context.terminalError = terminalError;
    if (context.request.context?.signal && context.onAbort) {
      context.request.context.signal.removeEventListener('abort', context.onAbort);
    }

    // The callback is part of the terminal transition. It is deliberately
    // invoked once for every terminal state, including rejection/cancellation,
    // so Research and Task streams cannot miss a resolved event.
    const notification = Promise.resolve()
      .then(() => context.request.onResolved?.(toDto(record)))
      .catch(() => undefined)
      .then(() => {
        if (record.status === 'approved') {
          context.resolve();
          return;
        }
        context.reject(terminalError ?? approvalErrorForStatus(record.status, record.toolName));
      });
    context.resolution = notification;
    // A decision can be made by an HTTP caller before the authorization waiter
    // reaches `await`; avoid an unhandled rejection in that short interval.
    void notification.catch(() => undefined);
    void notification.then(
      () => contexts.delete(record.id),
      () => contexts.delete(record.id)
    );
  };

  const invalidatePending = (record: ToolApprovalRecord, error: unknown) => {
    const terminalError = asToolExecutionError(error);
    const invalidated = store.transition(
      record.id,
      'pending',
      'invalidated',
      now().toISOString()
    );
    if (invalidated) settle(invalidated, terminalError);
    return invalidated;
  };

  const invalidateApproved = (record: ToolApprovalRecord, error: unknown) => {
    const terminalError = asToolExecutionError(error);
    const invalidated = store.transition(
      record.id,
      'approved',
      'invalidated',
      now().toISOString()
    );
    if (invalidated) settle(invalidated, terminalError);
    return invalidated;
  };

  const createContext = (
    record: ToolApprovalRecord,
    request: ApprovalAuthorizationRequest
  ): ApprovalContext => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const resolution = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const context: ApprovalContext = {
      request,
      resolve,
      reject,
      resolution,
      settled: false
    };
    // Register before installing the signal listener. An already-aborted
    // signal can synchronously transition the row and call settle().
    contexts.set(record.id, context);
    // This catch is only for terminal decisions made before a waiter attaches.
    void resolution.catch(() => undefined);
    const signal = request.context?.signal;
    if (signal) {
      const onAbort = () => {
        const cancelled = store.transition(
          record.id,
          'pending',
          'cancelled',
          now().toISOString()
        );
        if (cancelled) {
          settle(cancelled);
          return;
        }
        // If another terminal transition won the race, the resolution promise
        // already carries the winner's structured result.
      };
      context.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return context;
  };

  const decide = (id: string, decision: ToolApprovalDecision): ToolApprovalDto => {
    const existing = store.get(id);
    if (!existing) throw new ApprovalNotFoundError(id);
    if (existing.status !== 'pending') throw new ApprovalDecisionConflictError();

    const context = contexts.get(id);
    if (decision === 'approve') {
      // A live request/snapshot is required. Approving a row restored from a
      // previous process would otherwise turn a durable record into an
      // authorization bypass.
      if (!context) {
        const invalidated = invalidatePending(existing, new ToolExecutionError({
          code: 'unavailable',
          message: `Approval request is no longer active: ${existing.toolName}`,
          retryable: true,
          reason: 'The owning process no longer has the associated runtime snapshot.'
        }));
        throw new ApprovalDecisionConflictError(
          invalidated ? 'Tool approval request is no longer active' : 'Tool approval is no longer pending'
        );
      }

      try {
        // Pre-approval hard gate: enabled/connected/active status, authorization,
        // definition hash, schema, and current provider metadata must still fit
        // the exact request that created this row.
        validateCurrentRuntime(context.request);
      } catch (error) {
        invalidatePending(existing, error);
        throw new ApprovalDecisionConflictError(
          `Tool approval became invalid: ${error instanceof Error ? error.message : 'runtime changed'}`
        );
      }
    }

    const status: Extract<ToolApprovalStatus, 'approved' | 'rejected'> = decision === 'approve'
      ? 'approved'
      : 'rejected';
    const decided = store.decide(id, status, now().toISOString());
    if (!decided) throw new ApprovalDecisionConflictError();

    if (decision === 'approve') {
      try {
        // Keep a second check in the decision path. It closes the common
        // enabled/schema drift window between the precheck and the atomic row
        // update; authorize() performs the final check immediately before the
        // real executor as well.
        validateCurrentRuntime(context!.request);
      } catch (error) {
        const invalidated = invalidateApproved(decided, error);
        throw new ApprovalDecisionConflictError(
          invalidated
            ? `Tool approval became invalid: ${error instanceof Error ? error.message : 'runtime changed'}`
            : 'Tool approval is no longer pending'
        );
      }
    }

    settle(decided);
    return toDto(decided);
  };

  const authorize = async (request: ApprovalAuthorizationRequest): Promise<void> => {
    throwIfAborted(request.context?.signal);
    const module = request.snapshot.modules.get(request.toolCall.name);
    // Built-ins and unknown tools never create approval rows. Unknown,
    // unauthorized, and unavailable calls remain ToolRuntime's responsibility.
    if (!module || module.source !== 'mcp') return;
    if (module.annotations?.readOnlyHint === true) {
      validateCurrentRuntime(request);
      return;
    }

    // Do not ask the user to approve a call which is already unavailable.
    validateCurrentRuntime(request);
    const definitionHash = request.snapshot.definitionHashes.get(request.toolCall.name);
    if (!definitionHash) {
      throw new ToolExecutionError({
        code: 'schema_changed',
        message: `Tool schema is missing from this snapshot: ${request.toolCall.name}`,
        retryable: true
      });
    }

    const toolCallId = request.toolCall.id ?? randomUUID();
    const existing = store.findPending(request.scope, toolCallId);
    const record = existing ?? store.create({
      scope: request.scope,
      toolCallId,
      toolName: module.definition.function.name,
      modelName: module.definition.function.name,
      label: module.label,
      source: module.source,
      ...(module.sourceInfo?.serverId ? { serverId: module.sourceInfo.serverId } : {}),
      ...(module.sourceInfo?.serverName ? { serverName: module.sourceInfo.serverName } : {}),
      ...(module.sourceInfo?.remoteName ? { remoteName: module.sourceInfo.remoteName } : {}),
      readOnly: false,
      arguments: request.toolCall.arguments,
      definitionHash,
      requestedAt: now().toISOString()
    });

    let context = contexts.get(record.id);
    if (!context && record.status === 'pending') context = createContext(record, request);

    if (record.status === 'pending' && context) {
      if (!existing) await request.onRequested?.(toDto(record));
      // The decision may have won while onRequested was awaiting an SSE/event
      // callback. The context promise is safe to await in either ordering.
      await context.resolution;
    } else if (record.status === 'approved') {
      // A completed in-process approval can be observed by a retrying caller;
      // do not emit a duplicate resolved event, but still re-gate the call.
      if (context) await context.resolution;
    } else {
      if (context) await context.resolution;
      throw approvalErrorForStatus(record.status, record.toolName);
    }

    const resolved = store.get(record.id);
    if (!resolved || resolved.status !== 'approved') {
      throw approvalErrorForStatus(resolved?.status ?? 'invalidated', record.toolName);
    }
    throwIfAborted(request.context?.signal);
    try {
      // Final gate immediately before execute. The runtime execute method also
      // validates the immutable snapshot, closing the last check/execute race.
      validateCurrentRuntime(request);
    } catch (error) {
      invalidateApproved(resolved, error);
      throw error;
    }
  };

  const cancelScope = (scope: ToolApprovalScope): ToolApprovalDto[] => {
    const cancelled: ToolApprovalDto[] = [];
    for (const record of store.list(scope).filter((item) => item.status === 'pending')) {
      const next = store.transition(record.id, 'pending', 'cancelled', now().toISOString());
      if (!next) continue;
      settle(next);
      cancelled.push(toDto(next));
    }
    return cancelled;
  };

  const expirePending = () => {
    const pending = store.list().filter((record) => record.status === 'pending');
    const count = store.expirePending(now().toISOString());
    for (const record of pending) {
      const expired = store.get(record.id);
      if (expired?.status === 'expired') settle(expired);
    }
    return count;
  };

  return {
    authorize,
    execute: async (request) => {
      await authorize(request);
      return request.runtime.execute(request.snapshot, request.toolCall, request.context);
    },
    get: (id) => {
      const record = store.get(id);
      return record ? toDto(record) : undefined;
    },
    list: (scope) => store.list(scope).map(toDto),
    decide,
    cancelScope,
    expirePending
  };
}

function validateCurrentRuntime(request: ApprovalAuthorizationRequest) {
  const current = request.runtime.getSnapshot({ mode: 'all' }, request.snapshot.scope);
  const snapshotModule = request.snapshot.modules.get(request.toolCall.name);
  const currentModule = current.modules.get(request.toolCall.name);
  if (!currentModule) {
    throw new ToolExecutionError({
      code: 'unavailable',
      message: `Tool is no longer available: ${request.toolCall.name}`,
      retryable: true,
      reason: 'The tool disappeared after this snapshot was created.'
    });
  }
  if (
    !snapshotModule
    || currentModule.source !== snapshotModule.source
    || stableStringify(currentModule.annotations) !== stableStringify(snapshotModule.annotations)
    || stableStringify(currentModule.sourceInfo) !== stableStringify(snapshotModule.sourceInfo)
  ) {
    throw new ToolExecutionError({
      code: 'schema_changed',
      message: `Tool metadata changed after this snapshot was created: ${request.toolCall.name}`,
      retryable: true,
      reason: 'Refresh the tool snapshot before retrying.'
    });
  }
  if (request.runtime.validate) {
    request.runtime.validate(request.snapshot, request.toolCall);
  }

  const expectedHash = request.snapshot.definitionHashes.get(request.toolCall.name);
  const currentHash = current.definitionHashes.get(request.toolCall.name);
  if (!expectedHash || expectedHash !== currentHash) {
    throw new ToolExecutionError({
      code: 'schema_changed',
      message: `Tool schema changed after this snapshot was created: ${request.toolCall.name}`,
      retryable: true,
      reason: 'Refresh the tool snapshot before retrying.'
    });
  }
  const availability = typeof currentModule.availability === 'function'
    ? currentModule.availability()
    : currentModule.availability;
  if (availability?.status === 'unavailable') {
    throw new ToolExecutionError({
      code: 'unavailable',
      message: availability.reason ?? `Tool is unavailable: ${request.toolCall.name}`,
      retryable: availability.retryable ?? true,
      reason: availability.reason
    });
  }
  if (currentModule.inputSchema) {
    const parsed = currentModule.inputSchema.safeParse(request.toolCall.arguments);
    if (!parsed.success) {
      throw new ToolExecutionError({
        code: 'invalid_arguments',
        message: `Invalid arguments for ${request.toolCall.name}`,
        retryable: false
      });
    }
  }
}

function asToolExecutionError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  return new ToolExecutionError({
    code: 'unavailable',
    message: error instanceof Error ? error.message : 'Tool approval became invalid',
    retryable: true
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

function approvalErrorForStatus(status: ToolApprovalStatus, toolName: string) {
  if (status === 'rejected') {
    return new ToolExecutionError({
      code: 'tool_rejected',
      message: `Tool approval rejected: ${toolName}`,
      retryable: true,
      reason: 'The user rejected this tool call.'
    });
  }
  if (status === 'cancelled') {
    return new ToolExecutionError({
      code: 'cancelled',
      message: `Tool approval cancelled: ${toolName}`,
      retryable: true,
      reason: 'The owning research run, agent task, or request was cancelled.'
    });
  }
  return new ToolExecutionError({
    code: 'unavailable',
    message: `Tool approval is ${status}: ${toolName}`,
    retryable: true,
    reason: `Approval status is ${status}.`
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new ToolExecutionError({
    code: 'cancelled',
    message: 'Tool approval request was cancelled',
    retryable: true,
    reason: 'The owning request was cancelled.'
  });
}

const sensitiveKey = /(api[-_]?key|authorization|cookie|credential|password|passwd|secret|token|private[-_]?key)/i;

export function redactToolArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactToolArguments);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    sensitiveKey.test(key) ? '[redacted]' : redactToolArguments(nested)
  ]));
}
