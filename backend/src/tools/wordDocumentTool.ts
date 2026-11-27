/**
 * Word document intent detection.
 * Phase 1: generateWordDocument removed. Use start_document_generation instead.
 */

export function isExplicitWordDocumentRequest(message: string) {
  const normalized = message.toLowerCase();
  const mentionsWord = /\bdocx\b|\bword\b|微软\s*word/.test(normalized);
  const requestsArtifact =
    /(生成|创建|制作|导出|下载|保存|整理成|转成|输出|提供)/.test(normalized) ||
    /\b(generate|create|export|download|save|produce|make|convert)\b/.test(normalized);
  return mentionsWord && requestsArtifact;
}

/**
 * Returns true if the message is an explicit request for any document output
 * (Word, DOCX, PDF report, PPT, PPTX, slides). Used to set the required tool
 * name in the agent loop so the model is nudged to call start_document_generation.
 */
export function isExplicitDocumentRequest(message: string) {
  const normalized = message.toLowerCase();
  const mentionsDocument =
    /\b(?:docx?|word|pdf|pptx?|slides?|presentation|powerpoint)\b|幻灯片|演示文稿|长篇文档|长篇报告/.test(normalized);
  const requestsArtifact =
    /(生成|创建|制作|导出|下载|保存|整理成|转成|输出|提供|做成|转换|产出)/.test(normalized) ||
    /\b(generate|create|export|download|save|produce|make|convert)\b/.test(normalized);
  return mentionsDocument && requestsArtifact;
}
