export const documentPresetNames = [
  'research-report',
  'technical-report',
  'business-report',
  'simple'
] as const;

export type DocumentPresetName = (typeof documentPresetNames)[number];
export type PageSize = 'A4' | 'LETTER';
export type PageOrientation = 'portrait' | 'landscape';
export type TextAlignment = 'left' | 'center' | 'right' | 'justify';

export type DocumentBlock =
  | {
      type: 'heading';
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: 'paragraph';
      text: string;
      alignment?: TextAlignment;
    }
  | {
      type: 'bulletList';
      items: string[];
    }
  | {
      type: 'numberedList';
      items: string[];
    }
  | {
      type: 'table';
      headers: string[];
      rows: string[][];
    }
  | {
      type: 'pageBreak';
    };

export type DocumentFormatInput = {
  preset?: DocumentPresetName;
  pageSize?: PageSize;
  orientation?: PageOrientation;
  margins?: Partial<DocumentMargins>;
  titleFont?: string;
  titleFontSize?: number;
  headingFont?: string;
  bodyFont?: string;
  bodyFontSize?: number;
  lineSpacing?: number;
  primaryColor?: string;
  showHeader?: boolean;
  headerText?: string;
  footerText?: string;
  showPageNumber?: boolean;
};

export type DocumentSpecInput = {
  fileName?: string;
  title: string;
  subtitle?: string;
  author?: string;
  blocks: DocumentBlock[];
  format?: DocumentFormatInput;
};

export type DocumentMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type DocumentPreset = {
  name: DocumentPresetName;
  pageSize: PageSize;
  orientation: PageOrientation;
  margins: DocumentMargins;
  titleFont: string;
  titleFontSize: number;
  headingFont: string;
  headingSizes: [number, number, number];
  bodyFont: string;
  bodyFontSize: number;
  lineSpacing: number;
  primaryColor: string;
  tableHeaderColor: string;
  showHeader: boolean;
  showPageNumber: boolean;
  compact: boolean;
};

export type ResolvedDocumentSpec = Omit<DocumentSpecInput, 'fileName' | 'format'> & {
  fileName: string;
  format: DocumentPreset & {
    headerText?: string;
    footerText?: string;
  };
};
