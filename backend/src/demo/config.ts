export type DemoConfig = {
  visitorDailyLimit: number;
  ipDailyLimit: number;
  globalDailyLimit: number;
  globalConcurrency: number;
  maxMessageChars: number;
  maxRunMs: number;
  maxLlmCalls: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  cookieSecure: boolean;
  trustProxy: string | false;
};

export function isPublicDemoEnabled() {
  return process.env.PUBLIC_DEMO_ENABLED === 'true';
}

export function getDemoConfig(): DemoConfig {
  const positive = (name: string, fallback: number, maximum: number) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const trustProxy = process.env.DEMO_TRUST_PROXY?.trim() || false;
  if (trustProxy && /^(true|false|\d+)$/i.test(trustProxy)) throw new Error('DEMO_TRUST_PROXY must name explicit trusted proxy addresses or subnets');
  const secure = process.env.DEMO_COOKIE_SECURE;
  if (secure !== undefined && !['true', 'false', ''].includes(secure)) throw new Error('Invalid DEMO_COOKIE_SECURE');
  return {
    visitorDailyLimit: positive('DEMO_VISITOR_DAILY_LIMIT', 10, 100),
    ipDailyLimit: positive('DEMO_IP_DAILY_LIMIT', 10, 1_000),
    globalDailyLimit: positive('DEMO_GLOBAL_DAILY_LIMIT', 100, 10_000),
    globalConcurrency: positive('DEMO_GLOBAL_CONCURRENCY', 3, 20),
    maxMessageChars: positive('DEMO_MAX_MESSAGE_CHARS', 2_000, 8_000),
    maxRunMs: positive('DEMO_MAX_RUN_SECONDS', 120, 300) * 1_000,
    maxLlmCalls: positive('DEMO_MAX_LLM_CALLS', 6, 12),
    maxOutputTokens: positive('DEMO_MAX_OUTPUT_TOKENS', 2_048, 4_096),
    maxToolCalls: positive('DEMO_MAX_TOOL_CALLS', 4, 8),
    cookieSecure: secure !== 'false',
    trustProxy
  };
}

export class DemoAccessError extends Error {
  constructor(message: string, readonly status = 429, readonly retryAfter = 60) {
    super(message);
  }
}

export function demoDay(now: number) {
  const day = new Date(now + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const resetsAt = Date.parse(`${day}T00:00:00+08:00`) + 24 * 60 * 60 * 1_000;
  return { day, resetsAt, retryAfter: Math.max(1, Math.ceil((resetsAt - now) / 1_000)) };
}
