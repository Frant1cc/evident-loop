import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { promisify } from 'node:util';

import type { ArtifactFormat, ArtifactSpec, QualityReport, RendererResult, ResearchSnapshot } from './types.js';
import { RendererUnavailableError } from './errors.js';

const execFileAsync = promisify(execFile);

export type ArtifactCommandRunner = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

export type ArtifactQualityAdapter = {
  inspect: (
    format: ArtifactFormat,
    result: RendererResult,
    spec: ArtifactSpec,
    snapshot: ResearchSnapshot,
    signal?: AbortSignal
  ) => Promise<QualityReport>;
};

export type ExternalQualityAdapterOptions = {
  libreOfficeBin?: string;
  pdfInfoBin?: string;
  pdfToPpmBin?: string;
  pdfToTextBin?: string;
  pdfFontsBin?: string;
  commandRunner?: ArtifactCommandRunner;
  timeoutMs?: number;
};

/**
 * Short-lived, argument-array-only QA adapter. It never starts a daemon and
 * never accepts a model-provided command/path. Missing binaries are reported
 * as renderer_unavailable so the generation cannot be marked completed.
 */
export function createExternalArtifactQualityAdapter(options: ExternalQualityAdapterOptions = {}): ArtifactQualityAdapter {
  const run = options.commandRunner ?? runCommand;
  const timeout = options.timeoutMs ?? 30_000;
  const libreOffice = options.libreOfficeBin ?? process.env.LIBREOFFICE_BIN ?? 'soffice';
  const pdfInfo = options.pdfInfoBin ?? process.env.POPPLER_PDFINFO_BIN ?? 'pdfinfo';
  const pdfToPpm = options.pdfToPpmBin ?? process.env.POPPLER_PDFTOPPM_BIN ?? 'pdftoppm';
  const pdfToText = options.pdfToTextBin ?? process.env.POPPLER_PDFTOTEXT_BIN ?? 'pdftotext';
  const pdfFonts = options.pdfFontsBin ?? process.env.POPPLER_PDFFONTS_BIN ?? 'pdffonts';

  return {
    async inspect(format, result, spec, _snapshot, signal) {
      throwIfAborted(signal);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'evident-loop-artifact-'));
      try {
        const inputName = format === 'pptx' ? 'presentation.pptx' : 'report.pdf';
        const inputPath = path.join(directory, inputName);
        await writeFile(inputPath, result.buffer, { flag: 'wx' });
        let pdfPath = inputPath;
        if (format === 'pptx') {
          await run(libreOffice, ['--headless', '--convert-to', 'pdf', '--outdir', directory, inputPath], { cwd: directory, timeout });
          pdfPath = path.join(directory, 'presentation.pdf');
        }
        const pdfInfoOutput = await run(pdfInfo, [pdfPath], { cwd: directory, timeout });
        const pages = parsePageCount(pdfInfoOutput.stdout);
        const diagnostics: string[] = [];
        if (!pages) diagnostics.push('QA could not determine the rendered page count');
        if (pages === 0) diagnostics.push('QA detected an empty rendered document');
        if (format === 'pptx') {
          const expectedSlides = spec.presentation.targetSlideCount;
          if (pages && pages !== expectedSlides) diagnostics.push(`Rendered slide count ${pages} differs from target ${expectedSlides}`);
        } else if (pages && pages !== spec.pdf.targetPageCount) {
          diagnostics.push(`Rendered PDF page count ${pages} differs from persisted target ${spec.pdf.targetPageCount}`);
        }
        if (pages && (pages < 6 || pages > 20)) {
          diagnostics.push(`Rendered PDF page count ${pages} is outside the allowed range 6-20`);
        }
        const textOutput = await run(pdfToText, ['-layout', pdfPath, '-'], { cwd: directory, timeout });
        if (!textOutput.stdout.replace(/\f/g, '').trim()) {
          diagnostics.push('QA detected no extractable text; inspect for empty pages or text overflow');
        }
        const pageText: string[] = [];
        for (let page = 1; page <= (pages ?? 0); page += 1) {
          const pageOutput = await run(pdfToText, ['-f', String(page), '-l', String(page), '-layout', pdfPath, '-'], { cwd: directory, timeout });
          pageText.push(pageOutput.stdout);
          if (!pageOutput.stdout.replace(/\f/g, '').trim()) {
            diagnostics.push(`QA detected an empty rendered page ${page}`);
          }
        }
        const allText = `${textOutput.stdout}\n${pageText.join('\n')}\n${textOutput.stderr}`;
        const overflow = detectPossibleOverflow(allText);
        if (overflow) {
          diagnostics.push(`QA heuristic detected possible text clipping/overflow (${overflow}); overlap detection is not exhaustive`);
        }
        const fontsOutput = await run(pdfFonts, [pdfPath], { cwd: directory, timeout });
        const fontRows = parseFontRows(fontsOutput.stdout);
        if (!fontRows.length) diagnostics.push('QA could not resolve any PDF fonts; font substitution cannot be verified');
        if (fontRows.some((row) => /unknown|substitut|not embedded/i.test(row) || !isEmbeddedFontRow(row, fontsOutput.stdout))) {
          diagnostics.push('QA detected possible font substitution or a missing embedded font');
        }
        throwIfAborted(signal);
        const previewBase = path.join(directory, 'preview');
        await run(pdfToPpm, ['-png', '-f', '1', '-l', String(pages ?? 1), pdfPath, previewBase], { cwd: directory, timeout });
        const raster = await readPreview(directory, previewBase, pages ?? 0);
        if (raster.pageCount !== (pages ?? 0)) {
          diagnostics.push(`QA rasterized ${raster.pageCount} PNG pages but expected ${pages ?? 0}; every rendered page must have its own PNG`);
        }
        return {
          ok: diagnostics.length === 0,
          diagnostics,
          ...(format === 'pptx' && raster.preview ? { preview: raster.preview, previewContentType: 'image/png' } : {})
        };
      } catch (error) {
        if (error instanceof RendererUnavailableError) throw error;
        const message = error instanceof Error ? error.message : 'external QA command failed';
        if (isMissingCommand(error) || /ENOENT|not recognized|找不到/i.test(message)) {
          throw new RendererUnavailableError(`Artifact QA unavailable: install LibreOffice and Poppler (soffice/pdfinfo/pdftoppm): ${message}`);
        }
        throw new Error(`Artifact QA failed: ${message}`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

export async function runArtifactPreflight(options: ExternalQualityAdapterOptions = {}) {
  const run = options.commandRunner ?? runCommand;
  const timeout = options.timeoutMs ?? 10_000;
  const checks = [
    { name: 'LibreOffice', command: options.libreOfficeBin ?? process.env.LIBREOFFICE_BIN ?? 'soffice', args: ['--version'] },
    { name: 'Poppler pdfinfo', command: options.pdfInfoBin ?? process.env.POPPLER_PDFINFO_BIN ?? 'pdfinfo', args: ['-v'] },
    { name: 'Poppler pdftoppm', command: options.pdfToPpmBin ?? process.env.POPPLER_PDFTOPPM_BIN ?? 'pdftoppm', args: ['-v'] },
    { name: 'Poppler pdftotext', command: options.pdfToTextBin ?? process.env.POPPLER_PDFTOTEXT_BIN ?? 'pdftotext', args: ['-v'] },
    { name: 'Poppler pdffonts', command: options.pdfFontsBin ?? process.env.POPPLER_PDFFONTS_BIN ?? 'pdffonts', args: ['-v'] }
  ];
  const results: Array<{ name: string; available: boolean; diagnostic?: string }> = [];
  try {
    const imported = await import('playwright');
    const chromium = imported.chromium;
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    results.push({ name: 'Playwright Chromium', available: true });
  } catch (error) {
    results.push({ name: 'Playwright Chromium', available: false, diagnostic: error instanceof Error ? error.message : 'Chromium unavailable' });
  }
  for (const check of checks) {
    try {
      const output = await run(check.command, check.args, { timeout });
      results.push({ name: check.name, available: true, diagnostic: `${output.stdout}${output.stderr}`.trim().slice(0, 500) });
    } catch (error) {
      results.push({ name: check.name, available: false, diagnostic: error instanceof Error ? error.message : 'command unavailable' });
    }
  }
  return { ok: results.every((result) => result.available), results };
}

function parsePageCount(output: string) {
  const match = output.match(/^Pages:\s*(\d+)$/im);
  return match ? Number(match[1]) : undefined;
}

function parseFontRows(output: string) {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^name\s+type\s+encoding/i.test(line) && !/^-+$/.test(line));
}

function isEmbeddedFontRow(row: string, output: string) {
  const header = output.split(/\r?\n/).find((line) => /^name\s+type\s+encoding\s+emb\b/i.test(line.trim()));
  if (!header) return true;
  const columns = header.trim().split(/\s+/);
  const embIndex = columns.findIndex((column) => column.toLowerCase() === 'emb');
  if (embIndex < 0) return true;
  const values = row.trim().split(/\s+/);
  const value = values[embIndex]?.toLowerCase();
  return value === undefined || value === 'yes' || value === 'true';
}

function detectPossibleOverflow(text: string) {
  if (/overflow|clipp|cut ?off|outside page|truncat/i.test(text)) return 'renderer warning';
  const longLine = text.split(/\r?\n/).find((line) => line.trim().length > 240);
  return longLine ? `long extracted line (${longLine.trim().length} chars)` : undefined;
}

async function readPreview(directory: string, base: string, pages: number) {
  const entries = await readdir(directory);
  const pageFiles = entries
    .filter((entry) => /^preview(?:-\d+)?\.png$/i.test(entry))
    .sort((left, right) => pageNumber(left) - pageNumber(right));
  if (pageFiles.length) {
    const images = await Promise.all(pageFiles.map((entry) => readFile(path.join(directory, entry))));
    if (images.some((image) => image.byteLength === 0)) throw new Error('pdftoppm rendered an empty page image');
    return {
      pageCount: pageFiles.length,
      preview: images.length === 1 ? images[0]! : createPngContactSheet(images) ?? images[0]
    };
  }
  // A single contact-sheet PNG is not evidence that every page was rasterized.
  // Keep the count explicit so QA cannot complete a multi-page output with
  // only one image.
  return { pageCount: 0, preview: undefined };
}

/** Compose ordinary 8-bit RGB/RGBA Poppler PNGs without adding an image
 * dependency. If an adapter emits an unsupported PNG, the first page remains
 * a valid preview while QA has still rasterized every page. */
function createPngContactSheet(images: Buffer[]) {
  const decoded = images.map(decodePng).filter((item): item is DecodedPng => Boolean(item));
  if (decoded.length !== images.length || !decoded.length) return undefined;
  const thumbWidth = 360;
  const thumbs = decoded.map((image) => {
    const width = thumbWidth;
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
        const source = (sourceY * image.width + sourceX) * 3;
        const target = (y * width + x) * 3;
        pixels[target] = image.pixels[source]!;
        pixels[target + 1] = image.pixels[source + 1]!;
        pixels[target + 2] = image.pixels[source + 2]!;
      }
    }
    return { width, height, pixels };
  });
  const columns = 2;
  const gap = 20;
  const rows = Math.ceil(thumbs.length / columns);
  const cellHeight = Math.max(...thumbs.map((item) => item.height));
  const canvasWidth = columns * thumbWidth + (columns + 1) * gap;
  const canvasHeight = rows * cellHeight + (rows + 1) * gap;
  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 3, 255);
  thumbs.forEach((thumb, index) => {
    const offsetX = gap + (index % columns) * (thumbWidth + gap);
    const offsetY = gap + Math.floor(index / columns) * (cellHeight + gap);
    for (let y = 0; y < thumb.height; y += 1) {
      const sourceStart = y * thumb.width * 3;
      const targetStart = ((offsetY + y) * canvasWidth + offsetX) * 3;
      thumb.pixels.copy(canvas, targetStart, sourceStart, sourceStart + thumb.width * 3);
    }
  });
  const raw = Buffer.alloc((canvasHeight * (canvasWidth * 3 + 1)));
  for (let y = 0; y < canvasHeight; y += 1) {
    raw[y * (canvasWidth * 3 + 1)] = 0;
    canvas.copy(raw, y * (canvasWidth * 3 + 1) + 1, y * canvasWidth * 3, (y + 1) * canvasWidth * 3);
  }
  return encodePng(canvasWidth, canvasHeight, deflateSync(raw));
}

type DecodedPng = { width: number; height: number; pixels: Buffer };

function decodePng(buffer: Buffer): DecodedPng | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) return undefined;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9]!;
      if (bitDepth !== 8 || ![2, 6, 0].includes(colorType)) return undefined;
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!width || !height || !chunks.length) return undefined;
  const sourceChannels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const rowBytes = width * sourceChannels;
  const inflated = inflateSync(Buffer.concat(chunks));
  if (inflated.length < height * (rowBytes + 1)) return undefined;
  const rows: Buffer[] = [];
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[cursor++]!;
    const row = Buffer.from(inflated.subarray(cursor, cursor + rowBytes));
    cursor += rowBytes;
    const previous = rows[y - 1];
    for (let x = 0; x < row.length; x += 1) {
      const left = x >= sourceChannels ? row[x - sourceChannels]! : 0;
      const up = previous?.[x] ?? 0;
      const upperLeft = x >= sourceChannels ? previous?.[x - sourceChannels] ?? 0 : 0;
      if (filter === 1) row[x] = (row[x]! + left) & 255;
      else if (filter === 2) row[x] = (row[x]! + up) & 255;
      else if (filter === 3) row[x] = (row[x]! + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x]! + paeth(left, up, upperLeft)) & 255;
      else if (filter !== 0) return undefined;
    }
    rows.push(row);
  }
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      const source = x * sourceChannels;
      const target = (y * width + x) * 3;
      pixels[target] = row[source]!;
      pixels[target + 1] = sourceChannels === 1 ? row[source]! : row[source + 1]!;
      pixels[target + 2] = sourceChannels === 1 ? row[source]! : row[source + 2]!;
    }
  }
  return { width, height, pixels };
}

function paeth(left: number, up: number, upperLeft: number) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function encodePng(width: number, height: number, compressed: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const typeBuffer = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuffer, data]);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    body.copy(result, 4);
    result.writeUInt32BE(crc32(body), 8 + data.length);
    return result;
  };
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pageNumber(value: string) {
  const match = value.match(/-(\d+)\.png$/i);
  return match ? Number(match[1]) : 1;
}

function isMissingCommand(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

async function runCommand(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Artifact QA cancelled');
}
