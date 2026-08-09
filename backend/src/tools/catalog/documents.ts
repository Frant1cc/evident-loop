import { generateWordDocument } from '../wordDocumentTool.js';
import type { ToolModule } from '../contracts.js';

export const documentToolModules: ToolModule[] = [
  {
    label: '生成 Word 文档',
    definition: {
      type: 'function',
      function: {
        name: 'generate_word_document',
        description:
          'Generate a downloadable DOCX only when the user explicitly asks to create, export, or download a Word/DOCX document. Put the complete body in contentMarkdown instead of constructing JSON block arrays. Supported Markdown: #/##/### headings, paragraphs, - bullet lists, 1. numbered lists, pipe tables, fenced code as plain text, and <!-- pagebreak -->. Do not repeat title/subtitle in contentMarkdown. Choose research-report for research and analysis, technical-report for architecture and implementation plans, business-report for decisions and action plans, and simple for general notes. Call at most once per user request. The client renders preview and download actions from the structured tool result. Do not repeat downloadUrl, previewUrl, localhost URLs, Markdown download links, or download instructions in the final prose.',
        parameters: {
          type: 'object',
          properties: {
            fileName: { type: 'string', description: 'Optional user-facing file name. The .docx extension is added automatically.' },
            title: { type: 'string', description: 'Document title.' },
            subtitle: { type: 'string', description: 'Optional subtitle.' },
            author: { type: 'string', description: 'Optional author or organization.' },
            contentMarkdown: {
              type: 'string',
              minLength: 1,
              maxLength: 40000,
              description: 'Complete document body as Markdown. Use <!-- pagebreak --> where a new page is needed. Do not wrap the Markdown in a code fence.'
            },
            format: {
              type: 'object',
              description: 'Optional style overrides. Omitted values inherit from the selected preset.',
              properties: {
                preset: { type: 'string', enum: ['research-report', 'technical-report', 'business-report', 'simple'] },
                pageSize: { type: 'string', enum: ['A4', 'LETTER'] },
                orientation: { type: 'string', enum: ['portrait', 'landscape'] },
                margins: {
                  type: 'object',
                  description: 'Page margins in millimeters, each between 5 and 50.',
                  properties: {
                    top: { type: 'number' },
                    right: { type: 'number' },
                    bottom: { type: 'number' },
                    left: { type: 'number' }
                  }
                },
                titleFont: { type: 'string' },
                titleFontSize: { type: 'number' },
                headingFont: { type: 'string' },
                bodyFont: { type: 'string' },
                bodyFontSize: { type: 'number' },
                lineSpacing: { type: 'number' },
                primaryColor: { type: 'string', description: 'Six-digit hex color, with or without #.' },
                showHeader: { type: 'boolean' },
                headerText: { type: 'string' },
                footerText: { type: 'string' },
                showPageNumber: { type: 'boolean' }
              }
            }
          },
          required: ['title', 'contentMarkdown']
        }
      }
    },
    execute: generateWordDocument
  }
];
