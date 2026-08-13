export class KnowledgeImportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'KnowledgeImportError';
    this.status = status;
  }
}

export function unsupportedFormatError() {
  return new KnowledgeImportError('支持上传 Markdown、TXT、DOCX 和文本型 PDF。', 415);
}

export function fileTooLargeError(limitBytes = 20_000_000) {
  const megabytes = Math.round(limitBytes / 1_000_000);
  return new KnowledgeImportError(`文件不能超过 ${megabytes} MB。`, 413);
}

export function emptyDocumentError() {
  return new KnowledgeImportError('文件中没有可导入的文本内容。', 422);
}

export function scannedPdfError() {
  return new KnowledgeImportError('未检测到可提取文本。当前版本暂不支持扫描 PDF OCR。', 422);
}

export function encryptedPdfError() {
  return new KnowledgeImportError('PDF 已加密，请解除密码保护后重新上传。', 422);
}

export function corruptDocxError() {
  return new KnowledgeImportError('无法读取 Word 文件，请确认文件未损坏。', 422);
}

export function pathConflictError() {
  return new KnowledgeImportError('知识库中已存在同名文件，请修改名称后重试。', 409);
}

export function notEditableError() {
  return new KnowledgeImportError('导入文件的提取内容为只读，不能直接编辑。', 409);
}

export function extractedContentTooLargeError() {
  return new KnowledgeImportError('提取后的文本超过大小限制。', 413);
}
