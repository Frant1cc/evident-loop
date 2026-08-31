import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { defineTool } from './defineTool.js';
import { createToolCatalog } from './registry.js';
import { createToolRuntime } from './runtime.js';
import { ToolExecutionError } from './contracts.js';

test('defineTool derives the OpenAI schema and validates the same Zod input before execution', async () => {
  const observed: unknown[] = [];
  const tool = defineTool({
    label: 'Echo',
    name: 'echo',
    description: 'Echo a value.',
    inputSchema: z.object({ value: z.string().trim().min(1) }),
    execute: (args) => {
      observed.push(args);
      return args;
    }
  });
  const runtime = createToolRuntime(createToolCatalog([tool]));
  const snapshot = runtime.getSnapshot();

  assert.deepEqual(snapshot.definitions[0]?.function.parameters, {
    type: 'object',
    properties: { value: { type: 'string', minLength: 1 } },
    required: ['value'],
    additionalProperties: false
  });
  await runtime.execute(snapshot, { name: 'echo', arguments: { value: '  ok ' } });
  assert.deepEqual(observed, [{ value: 'ok' }]);
  await assert.rejects(
    runtime.execute(snapshot, { name: 'echo', arguments: { value: '' } }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'invalid_arguments'
  );
});

test('snapshot policy is a hard execution gate for hidden and unselected tools', async () => {
  let executions = 0;
  const runtime = createToolRuntime(createToolCatalog([
    defineTool({
      label: 'Hidden',
      name: 'hidden',
      description: 'Never exposed.',
      inputSchema: z.object({}),
      exposedToModel: false,
      execute: () => {
        executions += 1;
        return 'hidden';
      }
    }),
    defineTool({
      label: 'Visible',
      name: 'visible',
      description: 'Visible tool.',
      inputSchema: z.object({}),
      execute: () => {
        executions += 1;
        return 'visible';
      }
    })
  ]));

  const snapshot = runtime.getSnapshot({ mode: 'selected', names: ['visible'] });
  assert.deepEqual([...snapshot.toolNames], ['visible']);
  await assert.rejects(
    runtime.execute(snapshot, { name: 'hidden', arguments: {} }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'unauthorized'
  );
  await assert.rejects(
    runtime.execute(snapshot, { name: 'missing', arguments: {} }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'unknown_tool'
  );
  assert.equal(executions, 0);
});

test('registry changes appear in the next snapshot and stale snapshots reject schema changes', async () => {
  const first = defineTool({
    label: 'First',
    name: 'first',
    description: 'First version.',
    inputSchema: z.object({ value: z.string() }),
    execute: () => 'ok'
  });
  const runtime = createToolRuntime(createToolCatalog([first]));
  const before = runtime.getSnapshot();

  runtime.register?.(defineTool({
    label: 'Second',
    name: 'second',
    description: 'Second tool.',
    inputSchema: z.object({}),
    execute: () => 'second'
  }));
  const after = runtime.getSnapshot();
  assert.ok(after.version > before.version);
  assert.deepEqual([...after.toolNames], ['first', 'second']);

  first.definition.function.description = 'Changed after snapshot';
  await assert.rejects(
    runtime.execute(before, { name: 'first', arguments: { value: 'ok' } }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'schema_changed'
  );
});

test('unavailable tools retain their schema but fail at execution time', async () => {
  const tool = defineTool({
    label: 'Unavailable',
    name: 'temporarily_unavailable',
    description: 'Retained definition.',
    inputSchema: z.object({}),
    availability: { status: 'unavailable', reason: 'disabled for this user' },
    execute: () => 'must not run'
  });
  const runtime = createToolRuntime(createToolCatalog([tool]));
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.definitions.length, 1);
  await assert.rejects(
    runtime.execute(snapshot, { name: 'temporarily_unavailable', arguments: {} }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'unavailable'
  );
});

