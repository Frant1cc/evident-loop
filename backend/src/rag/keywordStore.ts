import type { DocumentChunk } from './types.js';
import { parseLocator } from '../knowledge/locator.js';
import type { KnowledgeFormat } from '../knowledge/types.js';

/**
 * SQLite FTS5 关键词检索层。
 *
 * - 与 Qdrant 向量索引平行的第二路召回，按 chunkKey 对齐，供后续 RRF 融合。
 * - 中文没有空格分词，这里采用字符级索引：写入前在每个 CJK 字符间插入空格，
 *   查询时把连续 CJK 段构造成 FTS5 短语（保证相邻性），ASCII 词原样保留。
 * - 通过 collection 列隔离生产库与评测库（rag_eval），与 Qdrant collection 语义一致。
 * - 通过工厂函数注入数据库实例：生产使用 better-sqlite3，测试可注入 node:sqlite。
 */

export const FTS_TABLE = 'knowledge_chunk_fts_v3';

/** 与 better-sqlite3 / node:sqlite 均兼容的最小接口 */
export type SqliteLike = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get?(...params: unknown[]): unknown;
  };
};

export type KeywordSearchResult = DocumentChunk & {
  /** BM25 相关性，越大越相关（SQLite bm25() 取负） */
  keywordScore: number;
};

type FtsRow = {
  chunk_key: string;
  file: string;
  title: string;
  heading: string | null;
  heading_path: string | null;
  content: string;
  start_line: number;
  end_line: number;
  chunk_index: number | null;
  part_index: number | null;
  parent_id: string | null;
  previous_chunk_id: string | null;
  next_chunk_id: string | null;
  token_count: number | null;
  content_type: string | null;
  format: string | null;
  locator_json: string | null;
  parser_version: string | null;
  score: number;
};

const cjkPattern = /[㐀-䶿一-鿿豈-﫿]/;

/** 在每个 CJK 字符之间插入空格，使 FTS5 unicode61 按字符建立词元；ASCII 保持整词 */
export function segmentForFts(text: string): string {
  let result = '';
  let previousWasCjk = false;

  for (const char of text) {
    const isCjk = cjkPattern.test(char);
    if (result && (isCjk || previousWasCjk) && !result.endsWith(' ')) {
      result += ' ';
    }
    result += char;
    previousWasCjk = isCjk;
  }

  return result.replace(/\s+/g, ' ').trim();
}

/**
 * 把用户查询构造成 FTS5 MATCH 表达式：
 * 连续 CJK 段 → 重叠字符二元组短语（"修正久期" → "修 正" OR "正 久" OR "久 期"，
 * 每个短语要求两字相邻，命中的二元组越多 BM25 累计越高，实现部分匹配），
 * ASCII 词 → 引号包裹的词条；词条之间 OR。
 * 返回 undefined 表示查询中没有可检索词元。
 */
export function buildFtsQuery(query: string): string | undefined {
  const sanitized = query.replace(/["]/g, ' ');
  const terms: string[] = [];
  // 拆出连续 CJK 段与 ASCII 词（含 . _ - 连接的标识符，如 enable.idempotence）
  const pattern = /([㐀-䶿一-鿿豈-﫿]+)|([A-Za-z0-9][A-Za-z0-9._\-/@]*)/g;

  for (const match of sanitized.matchAll(pattern)) {
    const cjkRun = match[1];
    const asciiRun = match[2];
    if (cjkRun) {
      const chars = [...cjkRun];
      if (chars.length === 1) {
        terms.push(`"${chars[0]}"`);
      } else {
        for (let index = 0; index < chars.length - 1; index += 1) {
          terms.push(`"${chars[index]} ${chars[index + 1]}"`);
        }
      }
    } else if (asciiRun) {
      terms.push(`"${asciiRun}"`);
    }
  }

  if (!terms.length) return undefined;
  return terms.join(' OR ');
}

export function createKeywordStore(db: SqliteLike) {
  let ensured = false;

  function ensureTable() {
    if (ensured) return;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        title_seg,
        heading_seg,
        content_seg,
        collection UNINDEXED,
        chunk_key UNINDEXED,
        file UNINDEXED,
        title UNINDEXED,
        heading UNINDEXED,
        heading_path UNINDEXED,
        content UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        chunk_index UNINDEXED,
        part_index UNINDEXED,
        parent_id UNINDEXED,
        previous_chunk_id UNINDEXED,
        next_chunk_id UNINDEXED,
        token_count UNINDEXED,
        content_type UNINDEXED,
        format UNINDEXED,
        locator_json UNINDEXED,
        parser_version UNINDEXED,
        tokenize = 'unicode61'
      )
    `);
    ensured = true;
  }

  /** 用最新 chunk 集合整体替换某文档在指定 collection 下的 FTS 行（幂等） */
  function replaceFileChunks(collection: string, file: string, chunks: DocumentChunk[]) {
    ensureTable();
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM ${FTS_TABLE} WHERE collection = ? AND file = ?`).run(collection, file);
      const insert = db.prepare(`
        INSERT INTO ${FTS_TABLE} (
          title_seg, heading_seg, content_seg,
          collection, chunk_key, file, title, heading, heading_path, content, start_line, end_line,
          chunk_index, part_index, parent_id, previous_chunk_id, next_chunk_id, token_count, content_type,
          format, locator_json, parser_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        insert.run(
          segmentForFts(chunk.title),
          chunk.headingPath?.length
            ? segmentForFts(chunk.headingPath.join(' > '))
            : chunk.heading ? segmentForFts(chunk.heading) : '',
          segmentForFts(chunk.content),
          collection,
          chunk.id,
          chunk.file,
          chunk.title,
          chunk.heading ?? null,
          chunk.headingPath ? JSON.stringify(chunk.headingPath) : null,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          chunk.chunkIndex ?? null,
          chunk.partIndex ?? null,
          chunk.parentId ?? null,
          chunk.previousChunkId ?? null,
          chunk.nextChunkId ?? null,
          chunk.tokenCount ?? null,
          chunk.contentType ?? null,
          chunk.format ?? null,
          chunk.locator ? JSON.stringify(chunk.locator) : null,
          chunk.parserVersion ?? null
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function deleteFileChunks(collection: string, file: string) {
    ensureTable();
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE collection = ? AND file = ?`).run(collection, file);
  }

  function deleteFilesNotIn(collection: string, keepFiles: string[]) {
    ensureTable();
    if (!keepFiles.length) {
      db.prepare(`DELETE FROM ${FTS_TABLE} WHERE collection = ?`).run(collection);
      return;
    }
    const placeholders = keepFiles.map(() => '?').join(', ');
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE collection = ? AND file NOT IN (${placeholders})`)
      .run(collection, ...keepFiles);
  }

  function countChunks(collection: string): number {
    ensureTable();
    const rows = db.prepare(`SELECT count(*) AS total FROM ${FTS_TABLE} WHERE collection = ?`).all(collection) as Array<{ total: number }>;
    return rows[0]?.total ?? 0;
  }

  /** BM25 检索。标题/章节权重高于正文；返回按相关性降序的 chunk 列表 */
  function searchKeyword(query: string, limit: number, collection: string): KeywordSearchResult[] {
    ensureTable();
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = db.prepare(`
      SELECT
        chunk_key, file, title, heading, heading_path, content, start_line, end_line,
        chunk_index, part_index, parent_id, previous_chunk_id, next_chunk_id, token_count, content_type,
        format, locator_json, parser_version,
        -bm25(${FTS_TABLE}, 2.0, 3.0, 1.0) AS score
      FROM ${FTS_TABLE}
      WHERE ${FTS_TABLE} MATCH ? AND collection = ?
      ORDER BY score DESC
      LIMIT ?
    `).all(ftsQuery, collection, Math.max(1, limit)) as FtsRow[];

    return rows.map((row) => ({
      id: row.chunk_key,
      file: row.file,
      title: row.title,
      heading: row.heading ?? undefined,
      headingPath: parseHeadingPath(row.heading_path),
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      chunkIndex: row.chunk_index ?? undefined,
      partIndex: row.part_index ?? undefined,
      parentId: row.parent_id ?? undefined,
      previousChunkId: row.previous_chunk_id ?? undefined,
      nextChunkId: row.next_chunk_id ?? undefined,
      tokenCount: row.token_count ?? undefined,
      contentType: isContentType(row.content_type) ? row.content_type : undefined,
      format: isFormat(row.format) ? row.format : undefined,
      locator: parseLocatorJson(row.locator_json),
      parserVersion: row.parser_version ?? undefined,
      keywordScore: row.score
    }));
  }

  function listDocumentTopics(collection: string) {
    return db.prepare(`
      SELECT DISTINCT file, title
      FROM ${FTS_TABLE}
      WHERE collection = ?
      ORDER BY file ASC
    `).all(collection) as Array<{ file: string; title: string }>;
  }

  return {
    replaceFileChunks,
    deleteFileChunks,
    deleteFilesNotIn,
    countChunks,
    searchKeyword,
    listDocumentTopics
  };
}

function parseHeadingPath(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function isContentType(value: string | null): value is NonNullable<DocumentChunk['contentType']> {
  return value === 'text' || value === 'table' || value === 'code' || value === 'mixed';
}

function isFormat(value: string | null): value is KnowledgeFormat {
  return value === 'md' || value === 'txt' || value === 'docx' || value === 'pdf';
}

function parseLocatorJson(value: string | null) {
  if (!value) return undefined;
  try {
    return parseLocator(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export type KeywordStore = ReturnType<typeof createKeywordStore>;

let defaultStore: KeywordStore | undefined;

/** 生产默认实例：绑定应用的 better-sqlite3 连接（懒加载避免测试环境引入原生依赖） */
export async function getKeywordStore(): Promise<KeywordStore> {
  if (!defaultStore) {
    const { sqlite } = await import('../db.js');
    defaultStore = createKeywordStore(sqlite as unknown as SqliteLike);
  }
  return defaultStore;
}
