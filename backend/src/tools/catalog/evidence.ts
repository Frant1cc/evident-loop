import { z } from 'zod';

import { readEvidence } from '../evidenceTool.js';
import { defineTool } from '../defineTool.js';

const readEvidenceSchema = z.object({
  citationKey: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  maxChars: z.number().int().min(1).max(24_000).optional()
});

export const evidenceToolModules = [
  defineTool({
    label: '回查证据',
    name: 'read_evidence',
    description:
      '读取本会话已检索过的证据完整正文。仅查询，不会发起新的检索。'
      + '按引用编号（如 "S1"）或 sourceId 寻址。需要回顾某条已检索证据的原文时调用本工具。'
      + 'maxChars 默认 8000，最大 24000；返回 truncated=true 时表示正文被截断，可再次调用并传入更大值。',
    inputSchema: readEvidenceSchema,
    execute: (args, context) => readEvidence(args, context)
  })
];
