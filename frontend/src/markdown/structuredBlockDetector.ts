/**
 * Streaming structured-block detector.
 *
 * Splits a growing Markdown string into ordered segments so the UI can show
 * code blocks and tables as soon as their structure is recognisable, filling
 * them line-by-line while streaming. Only newly-appeared segments get fresh
 * ids; segments at a position whose kind is unchanged keep their id, so keyed
 * `v-for` never re-mounts already-rendered content.
 *
 * This is intentionally NOT a full Markdown state machine (see plan §1): it only
 * recognises fenced code blocks and GFM tables. Everything else stays as a
 * `markdown` segment rendered by the existing renderer.
 */

export type BlockStatus = 'generating' | 'complete' | 'repaired';

export type Alignment = 'left' | 'center' | 'right' | 'none';

export type MarkdownSegment = {
  kind: 'markdown';
  id: string;
  raw: string;
};

export type CodeSegment = {
  kind: 'code';
  id: string;
  fenceChar: '`' | '~';
  fenceLen: number;
  language: string;
  lines: string[];
  currentLine: string;
  status: BlockStatus;
  raw: string;
};

export type TableSegment = {
  kind: 'table';
  id: string;
  headerCells: string[];
  alignments: Alignment[];
  completedRows: string[][];
  currentRow: string[] | null;
  status: BlockStatus;
  raw: string;
};

export type Segment = MarkdownSegment | CodeSegment | TableSegment;

export type DetectorState = {
  /** Frozen segments plus, as the last entry, the active (still-growing) one. */
  segments: Segment[];
  /** Monotonic id counter so segment ids stay unique for the whole message. */
  seq: number;
};

export function createDetectorState(): DetectorState {
  return { segments: [], seq: 0 };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/;

export function detectFenceOpen(
  line: string
): { fenceChar: '`' | '~'; fenceLen: number; language: string } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  const fenceChar = marker[0] as '`' | '~';
  const info = line.trim().slice(marker.length).trim();
  const language = info.split(/\s+/, 1)[0] ?? '';
  return { fenceChar, fenceLen: marker.length, language };
}

export function isFenceClose(line: string, fenceChar: '`' | '~', fenceLen: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fenceLen) return false;
  return [...trimmed].every((character) => character === fenceChar);
}

export function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = body.split('|');
  if (cells.length === 0) return false;
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

export function looksLikeTableHeader(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  // Reject fenced/quoted/heading lines that merely contain a pipe.
  if (/^ {0,3}(`{3,}|~{3,}|>|#)/.test(trimmed)) return false;
  return true;
}

export function parseAlignments(separatorLine: string): Alignment[] {
  return splitTableRow(separatorLine).map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return 'none';
  });
}

export function splitTableRow(line: string): string[] {
  let body = line.trim();
  body = body.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const character = body[i]!;
    if (character === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Incrementally advance the detector to reflect the latest `content`.
 *
 * `content` is assumed to be an append-only growth of what was seen before (the
 * composable resets state on any non-prefix change). We recompute the full
 * segment list, then reconcile against the previous run so unchanged positions
 * keep their id and only genuinely new segments consume a fresh `seq`.
 */
export function advance(state: DetectorState, content: string): void {
  const rebuilt = segmentize(content);
  state.segments = reconcile(state, state.segments, rebuilt);
}

/**
 * Mark the message as finished: an unclosed code fence becomes `repaired`, an
 * open table is frozen as `complete`, trailing markdown stays as-is.
 */
export function finalize(state: DetectorState): void {
  for (const segment of state.segments) {
    if (segment.kind === 'code' && segment.status === 'generating') {
      if (segment.currentLine) {
        segment.lines.push(segment.currentLine);
        segment.currentLine = '';
      }
      segment.status = 'repaired';
    } else if (segment.kind === 'table' && segment.status === 'generating') {
      commitCurrentTableRow(segment);
      segment.status = 'complete';
    }
  }
}

function commitCurrentTableRow(segment: TableSegment): void {
  if (segment.currentRow && segment.currentRow.some((cell) => cell.length > 0)) {
    segment.completedRows.push(segment.currentRow);
  }
  segment.currentRow = null;
}

function normalizeRow(cells: string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) row.push('');
  return row;
}

type LineInfo = { text: string; hasNewline: boolean };

function toLines(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      let text = content.slice(start, i);
      if (text.endsWith('\r')) text = text.slice(0, -1);
      lines.push({ text, hasNewline: true });
      start = i + 1;
    }
  }
  lines.push({ text: content.slice(start), hasNewline: false });
  return lines;
}

/** Build the full ordered segment list from scratch, with placeholder ids. */
function segmentize(content: string): Segment[] {
  const lines = toLines(content);
  const segments: Segment[] = [];

  let markdownBuffer: string[] = [];
  let i = 0;

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return;
    const raw = markdownBuffer.join('\n');
    if (raw.trim().length > 0 || segments.length === 0) {
      segments.push({ kind: 'markdown', id: '', raw });
    }
    markdownBuffer = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = detectFenceOpen(line.text);

    if (fence) {
      flushMarkdown();
      const code: CodeSegment = {
        kind: 'code',
        id: '',
        fenceChar: fence.fenceChar,
        fenceLen: fence.fenceLen,
        language: fence.language,
        lines: [],
        currentLine: '',
        status: 'generating',
        raw: ''
      };
      const rawLines: string[] = [line.text];
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        rawLines.push(bodyLine.text);
        if (isFenceClose(bodyLine.text, fence.fenceChar, fence.fenceLen)) {
          code.status = 'complete';
          i++;
          break;
        }
        if (bodyLine.hasNewline) {
          code.lines.push(bodyLine.text);
        } else {
          code.currentLine = bodyLine.text;
        }
        i++;
      }
      code.raw = rawLines.join('\n');
      segments.push(code);
      continue;
    }

    // Table detection: a header line immediately followed by a separator line,
    // both fully received (terminated by a newline).
    if (
      looksLikeTableHeader(line.text) &&
      line.hasNewline &&
      i + 1 < lines.length &&
      lines[i + 1]!.hasNewline &&
      isTableSeparator(lines[i + 1]!.text)
    ) {
      flushMarkdown();
      const headerCells = splitTableRow(line.text);
      const alignments = parseAlignments(lines[i + 1]!.text);
      const table: TableSegment = {
        kind: 'table',
        id: '',
        headerCells,
        alignments,
        completedRows: [],
        currentRow: null,
        status: 'generating',
        raw: ''
      };
      const rawLines: string[] = [line.text, lines[i + 1]!.text];
      i += 2;
      let ended = false;
      while (i < lines.length) {
        const rowLine = lines[i]!;
        const isLastLine = i === lines.length - 1;
        // The trailing line without a newline is the live streaming cursor; an
        // empty cursor just means "awaiting more" and must not end the table.
        if (isLastLine && !rowLine.hasNewline && rowLine.text.trim() === '') {
          break;
        }
        // A blank line or a line that is no longer a table row ends the table.
        if (rowLine.text.trim() === '' || !rowLine.text.includes('|')) {
          ended = true;
          break;
        }
        rawLines.push(rowLine.text);
        if (rowLine.hasNewline) {
          table.completedRows.push(normalizeRow(splitTableRow(rowLine.text), headerCells.length));
        } else {
          table.currentRow = normalizeRow(splitTableRow(rowLine.text), headerCells.length);
        }
        i++;
      }
      if (ended) table.status = 'complete';
      table.raw = rawLines.join('\n');
      segments.push(table);
      continue;
    }

    markdownBuffer.push(line.text);
    i++;
  }

  flushMarkdown();
  return segments;
}

/**
 * Copy ids from the previous pass onto same-position, same-kind segments; give
 * every other segment a fresh id from the monotonic counter. Because content is
 * append-only, frozen prefixes always line up positionally with the prior run.
 */
function reconcile(state: DetectorState, previous: Segment[], next: Segment[]): Segment[] {
  for (let i = 0; i < next.length; i++) {
    const before = previous[i];
    const after = next[i]!;
    after.id = before && before.kind === after.kind ? before.id : `seg-${state.seq++}`;
  }
  return next;
}
