import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { detectNpxMajorVersion, resolveNpxCommand, validateCommandSafety } from './platform.js';

test('resolves npx.cmd on Windows', () => {
  const { command, args } = resolveNpxCommand('win32', '@upstash/context7-mcp', '4.0.3', 10);
  assert.equal(command, 'npx.cmd');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@4.0.3']);
});

test('resolves npx on macOS', () => {
  const { command, args } = resolveNpxCommand('darwin', '@upstash/context7-mcp', '4.0.3', 10);
  assert.equal(command, 'npx');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@4.0.3']);
});

test('resolves npx on Linux', () => {
  const { command, args } = resolveNpxCommand('linux', '@upstash/context7-mcp', '4.0.3', 10);
  assert.equal(command, 'npx');
  assert.deepEqual(args, ['--yes', '@upstash/context7-mcp@4.0.3']);
});

test('omits --yes for npm 6 npx, which does not support that option', () => {
  const { args } = resolveNpxCommand('darwin', '@upstash/context7-mcp', '4.0.3', 6);
  assert.deepEqual(args, ['@upstash/context7-mcp@4.0.3']);
});

test('detects the installed npx major version', () => {
  assert.ok(detectNpxMajorVersion() >= 1);
});

test('validates safe commands', () => {
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@upstash/context7-mcp@4.0.3']));
  assert.doesNotThrow(() => validateCommandSafety('npx.cmd', ['--yes', '@upstash/context7-mcp@4.0.3']));
});

test('rejects unsafe commands', () => {
  assert.throws(() => validateCommandSafety('bash', ['--yes', '@upstash/context7-mcp@4.0.3']), /Unsafe command/);
  assert.throws(() => validateCommandSafety('sh', ['--yes', '@upstash/context7-mcp@4.0.3']), /Unsafe command/);
  assert.throws(() => validateCommandSafety('cmd', ['--yes', '@upstash/context7-mcp@4.0.3']), /Unsafe command/);
});

test('rejects dangerous argument characters', () => {
  assert.throws(() => validateCommandSafety('npx', ['package; rm -rf /']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['package && echo']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['package | cat']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['package`whoami`']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['package$(whoami)']), /Unsafe argument/);
  assert.throws(() => validateCommandSafety('npx', ['package{}']), /Unsafe argument/);
});

test('allows safe package names with @scope and version', () => {
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@org/package@1.0.0']));
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', 'package@latest']));
  assert.doesNotThrow(() => validateCommandSafety('npx', ['--yes', '@org/package-name@1.0.0-beta.1']));
});
