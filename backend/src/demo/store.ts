import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import { DemoAccessError, demoDay, type DemoConfig } from './config.js';

const sessionTtlMs = 7 * 24 * 60 * 60 * 1_000;
export { sessionTtlMs };

export function usage(period: string, bucket: string, subject: string): number {
  return (sqlite.prepare('SELECT count FROM demo_usage WHERE period = ? AND bucket = ? AND subject = ?')
    .get(period, bucket, subject) as { count: number } | undefined)?.count ?? 0;
}

function increment(period: string, bucket: string, subject: string) {
  sqlite.prepare(`INSERT INTO demo_usage (period, bucket, subject, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (period, bucket, subject) DO UPDATE SET count = count + 1`).run(period, bucket, subject);
}

export function hashClientIp(ip: string) {
  sqlite.prepare("INSERT OR IGNORE INTO demo_settings (key, value) VALUES ('ip_hash_key', ?)")
    .run(randomBytes(32).toString('hex'));
  const key = (sqlite.prepare("SELECT value FROM demo_settings WHERE key = 'ip_hash_key'").get() as { value: string }).value;
  return createHmac('sha256', key).update(ip.replace(/^::ffff:/, '')).digest('hex');
}

export function consumeDemoRequest(ip: string, now: number) {
  sqlite.transaction(() => {
    const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
    if (usage(minute, 'request_ip', ip) >= 120 || usage(minute, 'request_global', '*') >= 1_200) {
      throw new DemoAccessError('访问过于频繁，请稍后再试。');
    }
    increment(minute, 'request_ip', ip);
    increment(minute, 'request_global', '*');
  })();
}

export function resolveDemoVisitor(token: string | undefined, ip: string, now: number) {
  return sqlite.transaction(() => {
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const id = createHash('sha256').update(token).digest('hex');
      const visitor = sqlite.prepare('SELECT id FROM demo_visitors WHERE id = ? AND expires_at > ?')
        .get(id, new Date(now).toISOString()) as { id: string } | undefined;
      if (visitor) return { id: visitor.id };
    }
    const { day, retryAfter } = demoDay(now);
    if (usage(day, 'session_ip', ip) >= 20 || usage(day, 'session_global', '*') >= 1_000) {
      throw new DemoAccessError('今日新访客体验名额已用完，请明天再来。', 429, retryAfter);
    }
    const nextToken = randomBytes(32).toString('hex');
    const id = createHash('sha256').update(nextToken).digest('hex');
    sqlite.prepare('INSERT INTO demo_visitors (id, created_at, expires_at) VALUES (?, ?, ?)')
      .run(id, new Date(now).toISOString(), new Date(now + sessionTtlMs).toISOString());
    increment(day, 'session_ip', ip);
    increment(day, 'session_global', '*');
    return { id, token: nextToken };
  })();
}

export function ownsConversation(visitorId: string, conversationId: string) {
  return Boolean(sqlite.prepare('SELECT 1 FROM demo_conversation_owners WHERE conversation_id = ? AND visitor_id = ?')
    .get(conversationId, visitorId));
}

export function ownedConversationIds(visitorId: string) {
  return new Set((sqlite.prepare('SELECT conversation_id FROM demo_conversation_owners WHERE visitor_id = ?')
    .all(visitorId) as Array<{ conversation_id: string }>).map((row) => row.conversation_id));
}

export function ownsNote(visitorId: string, id: string) {
  return Boolean(sqlite.prepare(`SELECT 1 FROM research_notes n JOIN demo_conversation_owners o ON o.conversation_id = n.conversation_id
    WHERE n.id = ? AND o.visitor_id = ?`).get(id, visitorId));
}

export function ownsRun(visitorId: string, id: string) {
  return Boolean(sqlite.prepare(`SELECT 1 FROM research_runs r JOIN demo_conversation_owners o ON o.conversation_id = r.conversation_id
    WHERE r.id = ? AND o.visitor_id = ?`).get(id, visitorId));
}

export function createOwnedConversation<T extends { id: string }>(visitorId: string, create: () => T): T {
  return sqlite.transaction(() => {
    if (ownedConversationIds(visitorId).size >= 10) throw new DemoAccessError('最多保留 10 个体验会话，请先删除不需要的会话。');
    const conversation = create();
    sqlite.prepare('INSERT INTO demo_conversation_owners (conversation_id, visitor_id) VALUES (?, ?)').run(conversation.id, visitorId);
    return conversation;
  })();
}

export function reserveDemoRun(visitorId: string, ip: string, config: DemoConfig, now: number) {
  return sqlite.transaction(() => {
    const { day, retryAfter } = demoDay(now);
    for (const [bucket, subject, limit, message] of [
      ['research_visitor', visitorId, config.visitorDailyLimit, '今日体验次数已用完，明天再来试试。'],
      ['research_ip', ip, config.ipDailyLimit, '当前网络今日体验次数已用完，请明天再来。'],
      ['research_global', '*', config.globalDailyLimit, '今日全站体验额度已用完，请明天再来。']
    ] as const) {
      if (usage(day, bucket, subject) >= limit) throw new DemoAccessError(message, 429, retryAfter);
    }
    const active = sqlite.prepare("SELECT visitor_id FROM demo_operations WHERE status = 'active'").all() as Array<{ visitor_id: string }>;
    if (active.some((row) => row.visitor_id === visitorId)) throw new DemoAccessError('你已有一个研究正在运行，请等待完成或停止后再试。');
    if (active.length >= config.globalConcurrency) throw new DemoAccessError('体验人数较多，请稍后再试。');
    increment(day, 'research_visitor', visitorId);
    increment(day, 'research_ip', ip);
    increment(day, 'research_global', '*');
    const id = randomUUID();
    sqlite.prepare("INSERT INTO demo_operations (id, visitor_id, status, created_at) VALUES (?, ?, 'active', ?)")
      .run(id, visitorId, new Date(now).toISOString());
    return id;
  })();
}

export function bindDemoRun(id: string, runId: string) {
  sqlite.prepare('UPDATE demo_operations SET run_id = ? WHERE id = ?').run(runId, id);
}

export function finishDemoRun(id: string, now: number) {
  sqlite.prepare("UPDATE demo_operations SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'active'")
    .run(new Date(now).toISOString(), id);
}

export function recoverDemoOperations(now: number) {
  sqlite.prepare("UPDATE demo_operations SET status = 'finished', finished_at = ? WHERE status = 'active'")
    .run(new Date(now).toISOString());
}

export function pruneDemoMetadata(now = Date.now()) {
  const cutoff = new Date(now - sessionTtlMs).toISOString();
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM demo_visitors WHERE expires_at <= ? AND NOT EXISTS
      (SELECT 1 FROM demo_conversation_owners o WHERE o.visitor_id = demo_visitors.id)`).run(new Date(now).toISOString());
    sqlite.prepare("DELETE FROM demo_operations WHERE status = 'finished' AND finished_at < ?").run(cutoff);
    sqlite.prepare('DELETE FROM demo_usage WHERE period < ?').run(cutoff.slice(0, 10));
  })();
}
