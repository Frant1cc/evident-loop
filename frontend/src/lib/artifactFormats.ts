export type ArtifactFormat = 'pptx' | 'pdf' | 'docx';

export const ARTIFACT_FORMATS = ['pptx', 'pdf', 'docx'] as const;

const PPTX_PATTERN = /\bpptx?\b|幻灯片|演示文稿|幻灯|powerpoint/i;
const PDF_PATTERN = /\bpdf\b|长篇报告/i;
const DOCX_PATTERN = /\bdocx?\b|word|文档|报告/i;

export function inferArtifactFormats(text: string): ArtifactFormat[] | undefined {
  const wantsPptx = PPTX_PATTERN.test(text);
  const wantsPdf = PDF_PATTERN.test(text);
  const wantsDocx = DOCX_PATTERN.test(text);
  const formats = ARTIFACT_FORMATS.filter((format) => {
    if (format === 'pptx') return wantsPptx;
    if (format === 'pdf') return wantsPdf;
    if (format === 'docx') return wantsDocx;
    return false;
  });
  return formats.length ? formats : undefined;
}

export function formatLabels(formats: ArtifactFormat[]) {
  const labels = formats.map((format) => format.toUpperCase());
  if (labels.length === 0) return '文件';
  if (labels.length === 1) return labels[0];
  return labels.join(' 与 ');
}
