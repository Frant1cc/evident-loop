export type ArtifactFormat = 'pptx' | 'pdf';

export const ARTIFACT_FORMATS = ['pptx', 'pdf'] as const;

const PPTX_PATTERN = /\bpptx?\b|幻灯片|演示文稿|幻灯|powerpoint/i;
const PDF_PATTERN = /\bpdf\b|长篇报告/i;

export function inferArtifactFormats(text: string): ArtifactFormat[] | undefined {
  const wantsPptx = PPTX_PATTERN.test(text);
  const wantsPdf = PDF_PATTERN.test(text);
  const formats = ARTIFACT_FORMATS.filter((format) => (format === 'pptx' ? wantsPptx : wantsPdf));
  return formats.length ? formats : undefined;
}

export function formatLabels(formats: ArtifactFormat[]) {
  const labels = formats.map((format) => (format === 'pptx' ? 'PPTX' : 'PDF'));
  if (labels.length === 0) return '文件';
  if (labels.length === 1) return labels[0];
  return labels.join(' 与 ');
}
