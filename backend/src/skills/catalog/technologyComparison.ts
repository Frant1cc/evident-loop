import type { OfficialResearchSkill } from '../contracts.js';

export const technologyComparisonV1: OfficialResearchSkill = {
  id: 'technology-comparison',
  version: '1.0.0',
  label: '技术方案对比',
  description: '从统一维度比较多个技术方案，并给出有证据边界的选型建议。',
  tools: {
    recommended: ['search_knowledge', 'read_document', 'retrieve_web_evidence'],
    required: ['retrieve_web_evidence']
  },
  instructions: `
先识别比较对象、使用场景、硬约束和评价维度。
使用相同维度比较所有候选方案，避免为不同候选使用不同标准。
优先收集一手资料和可追溯证据。
明确区分事实、推断、建议和证据缺口。
没有直接证据支持的优缺点不得写成确定事实。
最终回答包含：结论摘要、比较维度、候选分析、关键取舍、风险、适用条件和证据限制。
`.trim()
};
