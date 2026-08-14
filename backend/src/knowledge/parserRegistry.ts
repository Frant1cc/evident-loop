import { detectKnowledgeFormat } from './fileValidation.js';
import { unsupportedFormatError } from './errors.js';
import { docxParser } from './parsers/docxParser.js';
import { markdownParser } from './parsers/markdownParser.js';
import { pdfParser } from './parsers/pdfParser.js';
import { textParser } from './parsers/textParser.js';
import type { KnowledgeParser, KnowledgeUpload } from './types.js';

const parsers: KnowledgeParser[] = [markdownParser, textParser, docxParser, pdfParser];

export function resolveParser(input: KnowledgeUpload): KnowledgeParser {
  const format = detectKnowledgeFormat(input);
  const parser = parsers.find((candidate) => candidate.formats.includes(format) && candidate.canParse(input))
    ?? parsers.find((candidate) => candidate.formats.includes(format));
  if (!parser) throw unsupportedFormatError();
  return parser;
}

export function getParserByName(name: string) {
  return parsers.find((parser) => parser.name === name);
}
