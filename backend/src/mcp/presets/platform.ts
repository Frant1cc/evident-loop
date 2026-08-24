/**
 * 解析跨平台 npx 命令
 */
export function resolveNpxCommand(
  platform: NodeJS.Platform,
  packageName: string,
  packageVersion: string
): { command: string; args: string[] } {
  // Windows 需要 .cmd 后缀
  const command = platform === 'win32' ? 'npx.cmd' : 'npx';

  // 固定版本，禁止隐式安装最新版
  const args = ['--yes', `${packageName}@${packageVersion}`];

  return { command, args };
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
