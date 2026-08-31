import { spawnSync } from 'node:child_process';

/**
 * 解析跨平台 npx 命令
 */
export function resolveNpxCommand(
  platform: NodeJS.Platform,
  packageName: string,
  packageVersion: string,
  npxMajorVersion: number
): { command: string; args: string[] } {
  // Windows 需要 .cmd 后缀
  const command = platform === 'win32' ? 'npx.cmd' : 'npx';

  // npm 7+ npx prompts before installing and supports --yes. npm 6 npx does
  // not support that flag and installs directly, so its invocation omits it.
  const args = [
    ...(npxMajorVersion >= 7 ? ['--yes'] : []),
    `${packageName}@${packageVersion}`
  ];

  return { command, args };
}

export function detectNpxMajorVersion(platform: NodeJS.Platform = process.platform): number {
  const command = platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('npx is required to enable managed MCP presets');
  }
  const major = Number.parseInt(result.stdout.trim().split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`Unable to determine npx version: ${result.stdout.trim() || 'empty output'}`);
  }
  return major;
}

/**
 * 验证命令安全性
 */
export function validateCommandSafety(command: string, args: string[]): void {
  const allowedCommands = ['npx', 'npx.cmd'];
  if (!allowedCommands.includes(command)) {
    throw new Error(`Unsafe command: ${command}`);
  }

  for (const arg of args) {
    if (/[;&|`$(){}]/.test(arg)) {
      throw new Error(`Unsafe argument: ${arg}`);
    }
  }
}
