import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';

import { KnowledgeImportError } from './errors.js';
import { detectKnowledgeFormat } from './fileValidation.js';
import { docxParser } from './parsers/docxParser.js';
import { pdfParser } from './parsers/pdfParser.js';
import { buildEmptyTextPdf, buildEncryptedPdf, buildTextPdf } from './pdfFixture.js';

test('DOCX parser extracts headings, lists and DOM tables', async () => {
  const file = await Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('风险报告')] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('市场风险')] }),
        new Paragraph({ children: [new TextRun('普通段落说明。')] }),
        new Paragraph({ children: [new TextRun({ text: '无序列表项', italics: false })], numbering: { reference: 'list', level: 0 } }),
        new Table({
          rows: [
            new TableRow({ children: [cell('证券'), cell('评级')] }),
            new TableRow({ children: [cell('债券 A'), cell('AA')] })
          ]
        })
      ]
    }],
    numbering: {
      config: [{
        reference: 'list',
        levels: [{ level: 0, format: 'bullet', text: '•' }]
      }]
    }
  }));

  const parsed = await docxParser.parse({
    originalName: 'headings-and-table.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: file.length,
    buffer: Buffer.from(file)
  });

  assert.equal(parsed.title, '风险报告');
  assert.ok(parsed.blocks.some((block) => block.type === 'heading' && block.text === '市场风险'));
  assert.ok(parsed.blocks.some((block) => block.type === 'paragraph' && block.text.includes('普通段落')));
  const table = parsed.blocks.find((block) => block.type === 'table');
  assert.ok(table);
  assert.deepEqual(table?.metadata.tableHeaders, ['证券', '评级']);
  assert.match(table?.text ?? '', /债券 A/);
});

test('DOCX parser rejects corrupt archives', () => {
  assert.throws(
    () => detectKnowledgeFormat({
      originalName: 'corrupt.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12,
      buffer: Buffer.from('not-a-zip!!!!')
    }),
    (error: unknown) => error instanceof KnowledgeImportError && (error.status === 415 || error.status === 422)
  );
});

test('PDF parser keeps page locators and can span paragraphs across pages', async () => {
  const buffer = buildTextPdf([
    ['Market risk overview', 'Duration increases portfolio sensitivity to yield changes,'],
    ['and amplifies price volatility.']
  ]);
  const parsed = await pdfParser.parse({
    originalName: 'text-layer.pdf',
    mimeType: 'application/pdf',
    size: buffer.length,
    buffer
  });

  assert.ok(parsed.metadata.pageCount === 2);
  const paragraph = parsed.blocks.find((block) => block.type === 'paragraph' && block.text.includes('Duration increases'));
  assert.ok(paragraph);
  assert.equal(paragraph?.locator.pageStart, 1);
  assert.ok((paragraph?.locator.pageEnd ?? 1) >= 1);
});

test('PDF parser rejects scanned and encrypted files without persisting text', async () => {
  await assert.rejects(
    () => pdfParser.parse({
      originalName: 'scanned-no-text.pdf',
      mimeType: 'application/pdf',
      size: 10,
      buffer: buildEmptyTextPdf()
    }),
    (error: unknown) => error instanceof KnowledgeImportError && error.message.includes('扫描 PDF')
  );

  await assert.rejects(
    () => pdfParser.parse({
      originalName: 'encrypted.pdf',
      mimeType: 'application/pdf',
      size: 10,
      buffer: buildEncryptedPdf()
    }),
    (error: unknown) => error instanceof KnowledgeImportError && error.status === 422
  );
});

test('file signature mismatch is rejected', () => {
  assert.throws(
    () => detectKnowledgeFormat({
      originalName: 'fake-extension.pdf',
      mimeType: 'application/pdf',
      size: 12,
      buffer: Buffer.from('this is not a pdf')
    }),
    (error: unknown) => error instanceof KnowledgeImportError && error.status === 415
  );
});

function cell(text: string) {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun(text)] })] });
}
