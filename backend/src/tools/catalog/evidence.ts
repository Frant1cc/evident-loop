import { readEvidence } from '../evidenceTool.js';
import type { ToolModule } from '../contracts.js';

export const evidenceToolModules: ToolModule[] = [
  {
    label: '回查证据',
    definition: {
      type: 'function',
      function: {
        name: 'read_evidence',
        description:
          '读取本会话已检索过的证据完整正文。仅查询，不会发起新的检索。'
          + '按引用编号（如 "S1"）或 sourceId 寻址。需要回顾某条已检索证据的原文时调用本工具。'
          + 'maxChars 默认 8000，最大 24000；返回 truncated=true 时表示正文被截断，可再次调用并传入更大值。',
        parameters: {
          type: 'object',
          properties: {
            citationKey: {
              type: 'string',
              description: '引用编号，例如 "S1"、"S7"。与 sourceId 二选一。'
            },
            sourceId: {
              type: 'string',
              description: '已检索证据在系统清单中暴露的 sourceId。与 citationKey 二选一。'
            },
            maxChars: {
              type: 'integer',
              minimum: 1,
              maximum: 24000,
              description: '返回正文的最大字符数。默认 8000。'
            }
          },
          // citationKey and sourceId are required via runtime validation in evidenceTool.ts;
          // declaring either here would force the model into a particular shape.
          required: []
        }
      }
    },
    execute: (args, context) => readEvidence(args, context)
  }
];
