/**
 * Unified document generation domain types for the three-phase refactor.
 * Phase 1: Domain model and single tool
 */

export type DocumentType = 'presentation' | 'longform';
export type DocumentOutputFormat = 'pptx' | 'docx' | 'pdf';
export type DocumentTheme = 'research' | 'technical' | 'business';

export type DocumentBranding = {
  primaryColor?: string;
  logoUrl?: string;
  titleFont?: string;
  bodyFont?: string;
};

// Longform block types - shared by DOCX and PDF
export type LongformBlock =
  | {
      id: string;
      type: 'heading';
      level: 1 | 2 | 3;
      text: string;
      citations: string[];
    }
  | {
      id: string;
      type: 'paragraph';
      text: string;
      alignment?: 'left' | 'center' | 'right' | 'justify';
      citations: string[];
    }
  | {
      id: string;
      type: 'bulletList';
      items: string[];
      citations: string[];
    }
  | {
      id: string;
      type: 'numberedList';
      items: string[];
      citations: string[];
    }
  | {
      id: string;
      type: 'table';
      headers: string[];
      rows: string[][];
      citations: string[];
    }
  | {
      id: string;
      type: 'pageBreak';
      citations: [];
    };

// Presentation deliverable - only outputs PPTX
export type PresentationDeliverable = {
  id: string;
  documentType: 'presentation';
  formats: ['pptx'];
  targetSlideCount: number;
  slides: PresentationSlide[];
};

// Reuse existing PresentationSlide from artifacts/generation/types.ts
export type PresentationSlide = {
  id: string;
  title: string;
  kind: 'title' | 'content' | 'comparison' | 'closing';
  bullets: string[];
  speakerNotes?: string;
  citations: string[];
  visual?:
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'bar'; labels: string[]; values: number[] };
};

// Longform deliverable - outputs DOCX, PDF, or both
export type LongformDeliverable = {
  id: string;
  documentType: 'longform';
  formats: Array<'docx' | 'pdf'>;
  subtitle?: string;
  author?: string;
  targetPageCount: number;
  page: {
    size: 'A4' | 'LETTER';
    orientation: 'portrait' | 'landscape';
    margins: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    showHeader: boolean;
    headerText?: string;
    footerText?: string;
    showPageNumber: boolean;
  };
  blocks: LongformBlock[];
};

// Unified generation spec
export type DocumentGenerationSpec = {
  title: string;
  audience: string;
  theme: DocumentTheme;
  branding: DocumentBranding;
  brief: ResearchBrief;
  deliverables: Array<PresentationDeliverable | LongformDeliverable>;
};

// Reuse ResearchBrief from artifacts/generation/types.ts
export type ArtifactCitation = {
  citationKey: string;
  sourceId: string;
  title: string;
  locator?: string;
};

export type ResearchBriefSection = {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  citations: string[];
};

export type ResearchBrief = {
  title: string;
  audience: string;
  executiveSummary: string;
  keyFindings: string[];
  recommendations: string[];
  sections: ResearchBriefSection[];
  citations: ArtifactCitation[];
};
