import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip
} from 'docx';

import type {
  DocumentBlock,
  ResolvedDocumentSpec,
  TextAlignment
} from './types.js';

const pageSizes = {
  A4: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
  LETTER: { width: 12_240, height: 15_840 }
} as const;

const bulletReference = 'agent-document-bullets';
const numberedReference = 'agent-document-numbering';

export async function renderWordDocument(spec: ResolvedDocumentSpec) {
  const format = spec.format;
  const pageSize = pageSizes[format.pageSize];
  const bodyChildren = [
    createTitle(spec),
    ...createFrontMatter(spec),
    ...spec.blocks.flatMap((block, blockIndex) => renderBlock(block, spec, blockIndex))
  ];
  const document = new Document({
    title: spec.title,
    creator: spec.author ?? 'EvidentLoop',
    description: `Generated ${format.name} document`,
    styles: createStyles(spec),
    numbering: {
      config: [
        {
          reference: bulletReference,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '\u2022',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: {
                    left: convertMillimetersToTwip(7),
                    hanging: convertMillimetersToTwip(3)
                  }
                }
              }
            }
          ]
        },
        {
          reference: numberedReference,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: {
                    left: convertMillimetersToTwip(7),
                    hanging: convertMillimetersToTwip(3)
                  }
                }
              }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pageSize.width,
              height: pageSize.height,
              orientation:
                format.orientation === 'landscape'
                  ? PageOrientation.LANDSCAPE
                  : PageOrientation.PORTRAIT
            },
            margin: {
              top: convertMillimetersToTwip(format.margins.top),
              right: convertMillimetersToTwip(format.margins.right),
              bottom: convertMillimetersToTwip(format.margins.bottom),
              left: convertMillimetersToTwip(format.margins.left),
              header: convertMillimetersToTwip(10),
              footer: convertMillimetersToTwip(10)
            }
          }
        },
        headers: format.showHeader
          ? {
              default: new Header({
                children: [createHeader(spec)]
              })
            }
          : undefined,
        footers:
          format.showPageNumber || format.footerText
            ? {
                default: new Footer({
                  children: [createFooter(spec)]
                })
              }
            : undefined,
        children: bodyChildren
      }
    ]
  });

  return Packer.toBuffer(document);
}

function createStyles(spec: ResolvedDocumentSpec) {
  const { format } = spec;
  const bodyLine = Math.round(format.lineSpacing * 240);
  const paragraphAfter = format.compact ? 100 : 140;

  return {
    default: {
      document: {
        run: {
          font: fontAttributes(format.bodyFont),
          size: format.bodyFontSize * 2,
          color: '222222',
          language: { value: 'zh-CN', eastAsia: 'zh-CN' }
        },
        paragraph: {
          spacing: { line: bodyLine, after: paragraphAfter },
          widowControl: true
        }
      },
      heading1: headingStyle(spec, 1),
      heading2: headingStyle(spec, 2),
      heading3: headingStyle(spec, 3),
      listParagraph: {
        run: {
          font: fontAttributes(format.bodyFont),
          size: format.bodyFontSize * 2
        },
        paragraph: {
          spacing: { line: bodyLine, after: format.compact ? 60 : 90 }
        }
      }
    },
    paragraphStyles: [
      {
        id: 'AgentTitle',
        name: 'Agent Document Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: fontAttributes(format.titleFont),
          size: format.titleFontSize * 2,
          bold: true,
          color: format.primaryColor
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: format.compact ? 120 : 180 },
          keepNext: true
        }
      },
      {
        id: 'AgentSubtitle',
        name: 'Agent Document Subtitle',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: fontAttributes(format.bodyFont),
          size: (format.bodyFontSize + 1) * 2,
          color: '666666'
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 100 },
          keepNext: true
        }
      },
      {
        id: 'AgentMeta',
        name: 'Agent Document Metadata',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: fontAttributes(format.bodyFont),
          size: Math.max(9, format.bodyFontSize - 1) * 2,
          color: '777777'
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: format.compact ? 180 : 260 }
        }
      }
    ]
  };
}

function headingStyle(spec: ResolvedDocumentSpec, level: 1 | 2 | 3) {
  const { format } = spec;
  const sizes = format.headingSizes;
  const before = level === 1 ? 280 : level === 2 ? 220 : 160;
  const after = level === 1 ? 120 : 90;

  return {
    run: {
      font: fontAttributes(format.headingFont),
      size: sizes[level - 1] * 2,
      bold: true,
      color: format.primaryColor
    },
    paragraph: {
      spacing: { before, after },
      keepNext: true,
      keepLines: true,
      outlineLevel: level - 1
    }
  };
}

function createTitle(spec: ResolvedDocumentSpec) {
  return new Paragraph({
    style: 'AgentTitle',
    children: [new TextRun(spec.title)]
  });
}

function createFrontMatter(spec: ResolvedDocumentSpec) {
  const paragraphs: Paragraph[] = [];

  if (spec.subtitle) {
    paragraphs.push(
      new Paragraph({
        style: 'AgentSubtitle',
        children: [new TextRun(spec.subtitle)]
      })
    );
  }

  if (spec.author) {
    paragraphs.push(
      new Paragraph({
        style: 'AgentMeta',
        children: [new TextRun(spec.author)]
      })
    );
  } else if (spec.subtitle) {
    paragraphs.push(new Paragraph({ spacing: { after: spec.format.compact ? 120 : 220 } }));
  }

  return paragraphs;
}

function renderBlock(
  block: DocumentBlock,
  spec: ResolvedDocumentSpec,
  blockIndex: number
) {
  if (block.type === 'heading') {
    return [
      new Paragraph({
        heading: headingLevel(block.level),
        children: [new TextRun(block.text)]
      })
    ];
  }

  if (block.type === 'paragraph') {
    return [
      new Paragraph({
        alignment: alignmentType(block.alignment),
        children: createTextRuns(block.text)
      })
    ];
  }

  if (block.type === 'bulletList' || block.type === 'numberedList') {
    const reference = block.type === 'bulletList' ? bulletReference : numberedReference;
    const keepTogether =
      block.items.length <= 8 &&
      block.items.reduce((total, item) => total + item.length, 0) <= 800;
    return block.items.map(
      (item, index) =>
        new Paragraph({
          style: 'ListParagraph',
          numbering: {
            reference,
            level: 0,
            instance: block.type === 'numberedList' ? blockIndex + 1 : undefined
          },
          keepNext: keepTogether && index < block.items.length - 1,
          keepLines: true,
          children: createTextRuns(item)
        })
    );
  }

  if (block.type === 'table') {
    return [
      createTable(block, spec),
      new Paragraph({
        spacing: { before: 0, after: spec.format.compact ? 60 : 100 }
      })
    ];
  }

  return [new Paragraph({ children: [new PageBreak()] })];
}

function createTable(
  block: Extract<DocumentBlock, { type: 'table' }>,
  spec: ResolvedDocumentSpec
) {
  const usableWidth = getUsablePageWidth(spec);
  const columnWidths = calculateColumnWidths(block.headers, block.rows, usableWidth);
  const compactColumns = block.headers.map((_, columnIndex) => {
    const values = [block.headers[columnIndex], ...block.rows.map((row) => row[columnIndex] ?? '')];
    return Math.max(...values.map((value) => value.length)) <= 12;
  });
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C9CED4' };
  const cellMargins = {
    marginUnitType: WidthType.DXA,
    top: 100,
    bottom: 100,
    left: 120,
    right: 120
  };
  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: block.headers.map(
      (header, columnIndex) =>
        new TableCell({
          width: { size: columnWidths[columnIndex], type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          shading: { fill: spec.format.tableHeaderColor, type: ShadingType.CLEAR },
          margins: cellMargins,
          children: [
            new Paragraph({
              alignment: compactColumns[columnIndex] ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { before: 0, after: 0, line: 240 },
              children: [
                new TextRun({
                  text: header,
                  bold: true,
                  color: spec.format.primaryColor,
                  font: fontAttributes(spec.format.headingFont),
                  size: spec.format.bodyFontSize * 2
                })
              ]
            })
          ]
        })
    )
  });
  const rows = block.rows.map(
    (row, rowIndex) =>
      new TableRow({
        cantSplit: true,
        children: row.map(
          (cell, columnIndex) =>
            new TableCell({
              width: { size: columnWidths[columnIndex], type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              shading:
                rowIndex % 2 === 1
                  ? { fill: 'F7F8FA', type: ShadingType.CLEAR }
                  : undefined,
              margins: cellMargins,
              children: [
                new Paragraph({
                  alignment: compactColumns[columnIndex]
                    ? AlignmentType.CENTER
                    : AlignmentType.LEFT,
                  spacing: {
                    before: 0,
                    after: 0,
                    line: Math.round(Math.min(spec.format.lineSpacing, 1.25) * 240)
                  },
                  children: createTextRuns(cell, {
                    font: spec.format.bodyFont,
                    size: Math.max(9, spec.format.bodyFontSize - 1)
                  })
                })
              ]
            })
        )
      })
  );

  return new Table({
    rows: [headerRow, ...rows],
    width: { size: usableWidth, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.LEFT,
    indent: { size: 0, type: WidthType.DXA },
    margins: cellMargins,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border
    }
  });
}

function getUsablePageWidth(spec: ResolvedDocumentSpec) {
  const pageSize = pageSizes[spec.format.pageSize];
  const pageWidth =
    spec.format.orientation === 'landscape' ? pageSize.height : pageSize.width;
  return (
    pageWidth -
    convertMillimetersToTwip(spec.format.margins.left) -
    convertMillimetersToTwip(spec.format.margins.right)
  );
}

function calculateColumnWidths(headers: string[], rows: string[][], totalWidth: number) {
  const weights = headers.map((header, columnIndex) => {
    const contentLengths = rows.map((row) => Math.min((row[columnIndex] ?? '').length, 40));
    return Math.max(6, Math.min(40, Math.max(header.length, ...contentLengths)));
  });
  const minimumWidth = Math.min(convertMillimetersToTwip(24), Math.floor(totalWidth / headers.length));
  const distributableWidth = Math.max(0, totalWidth - minimumWidth * headers.length);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map(
    (weight) => minimumWidth + Math.floor((distributableWidth * weight) / totalWeight)
  );
  widths[widths.length - 1] += totalWidth - widths.reduce((sum, width) => sum + width, 0);
  return widths;
}

function createHeader(spec: ResolvedDocumentSpec) {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { after: 80 },
    children: [
      new TextRun({
        text: spec.format.headerText ?? spec.title,
        font: fontAttributes(spec.format.headingFont),
        size: 18,
        color: '666666'
      })
    ]
  });
}

function createFooter(spec: ResolvedDocumentSpec) {
  const runStyle = {
    font: fontAttributes(spec.format.bodyFont),
    size: 18,
    color: '777777'
  };
  const children: TextRun[] = [];
  if (spec.format.footerText) {
    children.push(new TextRun({ text: spec.format.footerText, ...runStyle }));
  }
  if (spec.format.showPageNumber) {
    if (children.length) children.push(new TextRun({ text: '  |  ', ...runStyle }));
    children.push(
      new TextRun({ text: '第 ', ...runStyle }),
      new TextRun({ children: [PageNumber.CURRENT], ...runStyle }),
      new TextRun({ text: ' 页', ...runStyle })
    );
  }

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80 },
    children
  });
}

function createTextRuns(
  text: string,
  options?: {
    font?: string;
    size?: number;
  }
) {
  return text.split(/\r?\n/).map(
    (line, index) =>
      new TextRun({
        text: line,
        break: index === 0 ? undefined : 1,
        font: options?.font ? fontAttributes(options.font) : undefined,
        size: options?.size ? options.size * 2 : undefined
      })
  );
}

function fontAttributes(font: string) {
  return {
    ascii: font,
    hAnsi: font,
    eastAsia: font,
    cs: font
  };
}

function headingLevel(level: 1 | 2 | 3) {
  if (level === 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  return HeadingLevel.HEADING_3;
}

function alignmentType(alignment?: TextAlignment) {
  if (alignment === 'center') return AlignmentType.CENTER;
  if (alignment === 'right') return AlignmentType.RIGHT;
  if (alignment === 'justify') return AlignmentType.JUSTIFIED;
  return AlignmentType.LEFT;
}
