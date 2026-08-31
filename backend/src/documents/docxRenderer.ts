import { createHash } from 'node:crypto';

import { renderWordDocument } from './renderer.js';
import { resolveDocumentSpec } from './presets.js';
import type { DocumentBlock } from './types.js';
import type {
  DocumentGenerationSpec,
  LongformDeliverable,
  LongformBlock,
  DocumentBranding,
  DocumentTheme
} from '../artifacts/generation/types.js';

export type DocxRendererResult = {
  buffer: Buffer;
  fileName: string;
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  renderedSpec: DocumentGenerationSpec;
  diagnostics?: string[];
};

/**
 * Map a LongformBlock (Phase 1 unified type) to a DocumentBlock (existing
 * docx renderer type). Citation keys are appended as a compact source line
 * after the block so DOCX and PDF share the same citation key and order.
 */
function longformBlockToDocumentBlock(block: LongformBlock): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  if (block.type === 'heading') {
    blocks.push({ type: 'heading', level: block.level, text: block.text });
    if (block.citations.length) {
      blocks.push({ type: 'paragraph', text: `来源：${block.citations.join('、')}`, alignment: 'left' });
    }
    return blocks;
  }

  if (block.type === 'paragraph') {
    blocks.push({
      type: 'paragraph',
      text: block.text,
      alignment: block.alignment
    });
    if (block.citations.length) {
      blocks.push({ type: 'paragraph', text: `来源：${block.citations.join('、')}`, alignment: 'left' });
    }
    return blocks;
  }

  if (block.type === 'bulletList') {
    blocks.push({ type: 'bulletList', items: block.items });
    if (block.citations.length) {
      blocks.push({ type: 'paragraph', text: `来源：${block.citations.join('、')}`, alignment: 'left' });
    }
    return blocks;
  }

  if (block.type === 'numberedList') {
    blocks.push({ type: 'numberedList', items: block.items });
    if (block.citations.length) {
      blocks.push({ type: 'paragraph', text: `来源：${block.citations.join('、')}`, alignment: 'left' });
    }
    return blocks;
  }

  if (block.type === 'table') {
    blocks.push({ type: 'table', headers: block.headers, rows: block.rows });
    if (block.citations.length) {
      blocks.push({ type: 'paragraph', text: `来源：${block.citations.join('、')}`, alignment: 'left' });
    }
    return blocks;
  }

  // pageBreak
  blocks.push({ type: 'pageBreak' });
  return blocks;
}

function themeToPreset(theme: DocumentTheme): 'research-report' | 'technical-report' | 'business-report' {
  if (theme === 'technical') return 'technical-report';
  if (theme === 'business') return 'business-report';
  return 'research-report';
}

function safeFileStem(value: string) {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().slice(0, 120);
  return normalized || 'research-document';
}

/**
 * Adapt a DocumentGenerationSpec + LongformDeliverable into the existing
 * renderWordDocument pipeline. Preserves block order, list item order,
 * table structure, and citation keys from the deliverable.
 */
export async function renderDocx(
  generation: DocumentGenerationSpec,
  deliverable: LongformDeliverable
): Promise<DocxRendererResult> {
  const preset = themeToPreset(generation.theme);
  const branding: DocumentBranding = generation.branding;

  const docBlocks: DocumentBlock[] = deliverable.blocks.flatMap(longformBlockToDocumentBlock);

  const spec = resolveDocumentSpec({
    title: generation.title,
    subtitle: deliverable.subtitle,
    author: deliverable.author,
    blocks: docBlocks,
    format: {
      preset,
      pageSize: deliverable.page.size,
      orientation: deliverable.page.orientation,
      margins: deliverable.page.margins,
      titleFont: branding.titleFont,
      bodyFont: branding.bodyFont,
      primaryColor: branding.primaryColor,
      showHeader: deliverable.page.showHeader,
      headerText: deliverable.page.headerText,
      footerText: deliverable.page.footerText,
      showPageNumber: deliverable.page.showPageNumber
    }
  });

  const buffer = Buffer.from(await renderWordDocument(spec));
  const fileName = `${safeFileStem(generation.title)}.docx`;

  return {
    buffer,
    fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    renderedSpec: generation
  };
}

/**
 * Validate a rendered DOCX buffer for basic OOXML integrity.
 * Returns an array of diagnostic strings; empty means the file passed.
 */
export async function inspectDocxBuffer(
  buffer: Buffer,
  generation: DocumentGenerationSpec,
  deliverable: LongformDeliverable,
  renderedSpecDigest: string | undefined,
  expectedDigest: string | undefined,
  maxFileBytes = 50 * 1024 * 1024
): Promise<string[]> {
  const diagnostics: string[] = [];

  if (buffer.byteLength === 0) {
    diagnostics.push('DOCX renderer returned an empty file');
    return diagnostics;
  }

  // Must be a ZIP (OOXML)
  if (!buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
    diagnostics.push('DOCX output is not a valid ZIP/OOXML package');
    return diagnostics;
  }

  if (buffer.byteLength > maxFileBytes) {
    diagnostics.push(`DOCX file size ${buffer.byteLength} exceeds limit of ${maxFileBytes} bytes`);
  }

  // Check for [Content_Types].xml and word/document.xml inside the ZIP
  let AdmZip: any;
  try {
    const load = Function('moduleName', 'return import(moduleName)') as (moduleName: string) => Promise<any>;
    const mod = await load('adm-zip').catch(() => null);
    if (mod) AdmZip = mod.default ?? mod;
  } catch {
    AdmZip = null;
  }

  if (AdmZip) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries().map((entry: any) => entry.entryName as string);
      if (!entries.includes('[Content_Types].xml')) {
        diagnostics.push('DOCX output is missing [Content_Types].xml');
      }
      if (!entries.includes('word/document.xml')) {
        diagnostics.push('DOCX output is missing word/document.xml');
      }
      if (diagnostics.length === 0) {
        const docXml = zip.readAsText('word/document.xml');
        if (!docXml.includes(escapeXmlText(generation.title))) {
          diagnostics.push(`DOCX document.xml does not include the title: ${generation.title}`);
        }
      }
    } catch (error) {
      diagnostics.push(`DOCX ZIP inspection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // At least one non-pageBreak block must be rendered
  const hasContent = deliverable.blocks.some((block) => block.type !== 'pageBreak');
  if (!hasContent) {
    diagnostics.push('DOCX deliverable has no renderable blocks (only pageBreaks)');
  }

  // Rendered spec digest check
  if (renderedSpecDigest !== undefined && expectedDigest !== undefined && renderedSpecDigest !== expectedDigest) {
    diagnostics.push('DOCX rendered spec digest does not match the expected digest');
  }

  return diagnostics;
}

function escapeXmlText(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[character] ?? character));
}

export function digestDocxSpec(spec: DocumentGenerationSpec) {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
