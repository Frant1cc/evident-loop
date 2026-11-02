import { sqlite } from '../../db.js';
import type { LlmProvider } from '../../llm/contracts.js';
import type { ToolRuntime } from '../../tools/contracts.js';
import type { ResearchApplication } from '../research/index.js';
import { createDemoRunBudget } from '../../demo/budget.js';
import { DemoAccessError, demoDay, type DemoConfig } from '../../demo/config.js';
import {
  bindDemoRun, consumeDemoRequest, createOwnedConversation, finishDemoRun, hashClientIp,
  ownedConversationIds, ownsConversation, ownsNote, ownsRun, recoverDemoOperations, resolveDemoVisitor,
  reserveDemoRun, usage
} from '../../demo/store.js';

export function createPublicDemoApplication(options: {
  config: DemoConfig;
  llm?: LlmProvider;
  tools: ToolRuntime;
  now?: () => number;
}) {
  const { config } = options;
  const now = options.now ?? Date.now;
  const notFound = () => { throw new DemoAccessError('Research conversation not found', 404); };
  const validateContent = (content: string) => {
    if (!content.trim() || content.length > config.maxMessageChars) {
      throw new DemoAccessError(`请输入 1～${config.maxMessageChars} 字的问题。`, 400);
    }
  };
  return {
    config,
    openSession: (token: string | undefined, address: string) => {
      const ip = hashClientIp(address);
      consumeDemoRequest(ip, now());
      return { ...resolveDemoVisitor(token, ip, now()), ip };
    },
    status: (visitorId: string) => {
      const { day, resetsAt } = demoDay(now());
      return {
        enabled: true as const,
        dailyLimit: config.visitorDailyLimit,
        remaining: Math.max(0, config.visitorDailyLimit - usage(day, 'research_visitor', visitorId)),
        resetsAt: new Date(resetsAt).toISOString(),
        maxMessageChars: config.maxMessageChars
      };
    },
    recoverInterrupted: () => recoverDemoOperations(now()),
    scopeResearch: (base: ResearchApplication, visitorId: string, ip: string): ResearchApplication => ({
      ...base,
      listConversations: () => {
        const ids = ownedConversationIds(visitorId);
        return base.listConversations().filter((conversation) => ids.has(conversation.id));
      },
      createConversation: () => createOwnedConversation(visitorId, base.createConversation),
      getConversation: (id) => ownsConversation(visitorId, id) ? base.getConversation(id) : undefined,
      deleteConversation: (id) => ownsConversation(visitorId, id) ? base.deleteConversation(id) : false,
      createNote: (id, content) => {
        if (!ownsConversation(visitorId, id)) return undefined;
        validateContent(content);
        const count = (sqlite.prepare('SELECT COUNT(*) AS count FROM research_notes WHERE conversation_id = ?').get(id) as { count: number }).count;
        if (count >= 20) throw new DemoAccessError('每个体验会话最多保留 20 条笔记。');
        return base.createNote(id, content);
      },
      updateNote: (id, content) => {
        if (!ownsNote(visitorId, id)) return undefined;
        validateContent(content);
        return base.updateNote(id, content);
      },
      deleteNote: (id) => ownsNote(visitorId, id) ? base.deleteNote(id) : false,
      startMessage: (id, content, policy, skillId) => {
        if (!ownsConversation(visitorId, id)) return notFound();
        validateContent(content);
        if (base.getConversation(id)?.activeRun) throw new DemoAccessError('当前会话已有研究正在运行。', 409);
        if (skillId && !base.listSkills().some((skill) => skill.id === skillId)) throw new DemoAccessError('未知研究技能。', 400);
        if (!options.llm) throw new DemoAccessError('体验服务暂未配置，请稍后再试。', 503);
        const reservation = reserveDemoRun(visitorId, ip, config, now());
        const budget = createDemoRunBudget(options.llm, options.tools, config, () => finishDemoRun(reservation, now()));
        try {
          const started = base.startMessage(id, content, policy, skillId, budget);
          bindDemoRun(reservation, started.run.id);
          return started;
        } catch (error) {
          budget.onSettled();
          throw error;
        }
      },
      startMessageWithAttachment: async () => { throw new DemoAccessError('公开试用暂不支持文件上传。', 403); },
      getRun: (id) => ownsRun(visitorId, id) ? base.getRun(id) : undefined,
      getRunSnapshot: (id) => ownsRun(visitorId, id) ? base.getRunSnapshot(id) : undefined,
      subscribeToRun: (id, listener) => ownsRun(visitorId, id) ? base.subscribeToRun(id, listener) : () => {},
      getStreamEventsAfter: (id, cursor) => ownsRun(visitorId, id) ? base.getStreamEventsAfter(id, cursor) : [],
      getStreamMaxSequence: (id) => ownsRun(visitorId, id) ? base.getStreamMaxSequence(id) : 0,
      cancelRun: (id) => ownsRun(visitorId, id) ? base.cancelRun(id) : undefined
    })
  };
}

export type PublicDemoApplication = ReturnType<typeof createPublicDemoApplication>;
