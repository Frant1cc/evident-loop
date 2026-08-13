const defaultMaxUploadBytes = 20_000_000;
const defaultMaxExtractedBytes = 5_000_000;
const defaultMaxPdfPages = 500;

export function getKnowledgeMaxUploadBytes() {
  return readPositiveInt('KNOWLEDGE_MAX_UPLOAD_BYTES', defaultMaxUploadBytes);
}

export function getKnowledgeMaxExtractedBytes() {
  return readPositiveInt('KNOWLEDGE_MAX_EXTRACTED_BYTES', defaultMaxExtractedBytes);
}

export function getKnowledgeMaxPdfPages() {
  return readPositiveInt('KNOWLEDGE_MAX_PDF_PAGES', defaultMaxPdfPages);
}

export function getKnowledgeFilesDir() {
  return process.env.KNOWLEDGE_FILES_DIR?.trim() || undefined;
}

function readPositiveInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
