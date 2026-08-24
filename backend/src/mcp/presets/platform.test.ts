import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resolveNpxCommand, validateCommandSafety } from './platform.js';

test('resolves npx.cmd on Windows', () => {
  const { command, args } = resolveNpxCommand('win32', '@upstash/context7-mcp', '0.1.5');
  assert.equal(command, 'npx.cmd');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@0.1.5']);
});

test('resolves npx on macOS', () => {
  const { command, args } = resolveNpxCommand('darwin', '@upstash/context7-mcp', '0.1.5');
  assert.equal(command, 'npx');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@0.1.5']);
});

test('resolves npx on Linux', () => {
  const { command, args } = resolveNpxCommand('linux', '@upstash/context7-mcp', '0.1.5');
  assert.equal(command, 'npx');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@0.1.5']);
});

test('validates safe commands', () => {
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@upstash/context7-mcp@0.1.5']));
  assert.doesNotThrow(() => validateCommandSafety('npx.cmd', ['--yes', '@upstash/context7-mcp@0.1.5']));
});

test('rejects unsafe commands', () => {
  assert.throws(() => validateCommandSafety('bash', ['--yes', '@upstash/context7-mcp@0.1.5']), /Unsafe command/);
  assert.throws(() => validateCommandSafety('sh', ['--yes', '@upstash/context7-mcp@0.1.5']), /Unsafe command/);
  assert.throws(() => validateCommandSafety('cmd', ['--yes', '@upstash/context7-mcp@0.1.5']), /Unsafe command/);
});

test('rejects dangerous argument characters', () => {
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package; rm -rf /']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package && echo']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package | cat']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package`whoami`']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package$(whoami)']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['--yes', 'package{}']), /Unsafe argument/);
});

test('allows safe package names with @scope and version', () => {
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@org/package@1.0.0']));
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', 'package@latest']));
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@org/package-name@1.0.0-beta.1']));
});
