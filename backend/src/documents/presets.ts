import type { DocumentPreset, DocumentPresetName, DocumentSpecInput, ResolvedDocumentSpec } from './types.js';

const presets: Record<DocumentPresetName, DocumentPreset> = {
  'research-report': {
    name: 'research-report',
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
    titleFont: 'Hiragino Sans GB',
    titleFontSize: 22,
    headingFont: 'Hiragino Sans GB',
    headingSizes: [16, 14, 12],
    bodyFont: 'STSong',
    bodyFontSize: 12,
    lineSpacing: 1.5,
    primaryColor: '1F4E78',
    tableHeaderColor: 'DCE6F1',
    showHeader: true,
    showPageNumber: true,
    compact: false
  },
  'technical-report': {
    name: 'technical-report',
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { top: 22, right: 22, bottom: 22, left: 22 },
    titleFont: 'Hiragino Sans GB',
    titleFontSize: 20,
    headingFont: 'Hiragino Sans GB',
    headingSizes: [16, 13, 11],
    bodyFont: 'Hiragino Sans GB',
    bodyFontSize: 11,
    lineSpacing: 1.35,
    primaryColor: '185C66',
    tableHeaderColor: 'DCEBED',
    showHeader: true,
    showPageNumber: true,
    compact: true
  },
  'business-report': {
    name: 'business-report',
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { top: 22, right: 24, bottom: 22, left: 24 },
    titleFont: 'Hiragino Sans GB',
    titleFontSize: 22,
    headingFont: 'Hiragino Sans GB',
    headingSizes: [16, 13, 11],
    bodyFont: 'Hiragino Sans GB',
    bodyFontSize: 11,
    lineSpacing: 1.3,
    primaryColor: '315C4C',
    tableHeaderColor: 'DDE8E3',
    showHeader: true,
    showPageNumber: true,
    compact: true
  },
  simple: {
    name: 'simple',
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
    titleFont: 'Hiragino Sans GB',
    titleFontSize: 18,
    headingFont: 'Hiragino Sans GB',
    headingSizes: [15, 13, 11],
    bodyFont: 'STSong',
    bodyFontSize: 11,
    lineSpacing: 1.5,
    primaryColor: '222222',
    tableHeaderColor: 'EDEDED',
    showHeader: false,
    showPageNumber: true,
    compact: false
  }
};

export function getDocumentPreset(name: DocumentPresetName) {
  return presets[name];
}

export function resolveDocumentSpec(input: DocumentSpecInput): ResolvedDocumentSpec {
  const overrides = input.format ?? {};
  const preset = getDocumentPreset(overrides.preset ?? 'simple');

  return {
    title: input.title,
    subtitle: input.subtitle,
    author: input.author,
    blocks: input.blocks,
    fileName: ensureDocxExtension(input.fileName?.trim() || input.title),
    format: {
      ...preset,
      pageSize: overrides.pageSize ?? preset.pageSize,
      orientation: overrides.orientation ?? preset.orientation,
      margins: {
        ...preset.margins,
        ...overrides.margins
      },
      titleFont: overrides.titleFont ?? preset.titleFont,
      titleFontSize: overrides.titleFontSize ?? preset.titleFontSize,
      headingFont: overrides.headingFont ?? preset.headingFont,
      bodyFont: overrides.bodyFont ?? preset.bodyFont,
      bodyFontSize: overrides.bodyFontSize ?? preset.bodyFontSize,
      lineSpacing: overrides.lineSpacing ?? preset.lineSpacing,
      primaryColor: normalizeHexColor(overrides.primaryColor ?? preset.primaryColor),
      showHeader: overrides.showHeader ?? preset.showHeader,
      showPageNumber: overrides.showPageNumber ?? preset.showPageNumber,
      headerText: overrides.headerText?.trim() || undefined,
      footerText: overrides.footerText?.trim() || undefined
    }
  };
}

function ensureDocxExtension(fileName: string) {
  return fileName.toLowerCase().endsWith('.docx') ? fileName : `${fileName}.docx`;
}

function normalizeHexColor(color: string) {
  return color.replace(/^#/, '').toUpperCase();
}
