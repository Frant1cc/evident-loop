type MigratableDb = {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
};

const documentColumns: Array<[string, string]> = [
  ['source_type', "TEXT NOT NULL DEFAULT 'manual'"],
  ['format', "TEXT NOT NULL DEFAULT 'md'"],
  ['mime_type', 'TEXT'],
  ['original_name', 'TEXT'],
  ['original_size', 'INTEGER'],
  ['storage_key', 'TEXT'],
  ['parser_name', "TEXT NOT NULL DEFAULT 'legacy-markdown'"],
  ['parser_version', "TEXT NOT NULL DEFAULT '1'"],
  ['parse_warnings_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
  ['content_hash', 'TEXT'],
  ['original_hash', 'TEXT']
];

export function migrateKnowledgeSchema(sqlite: MigratableDb) {
  addMissingColumns(sqlite, 'knowledge_documents', documentColumns);
  addMissingColumns(sqlite, 'research_sources', [['locator_json', 'TEXT']]);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_document_blocks (
      id                  TEXT PRIMARY KEY,
      document_path       TEXT NOT NULL,
      block_order         INTEGER NOT NULL,
      block_type          TEXT NOT NULL,
      text                TEXT NOT NULL,
      heading_path_json   TEXT NOT NULL DEFAULT '[]',
      locator_json        TEXT NOT NULL DEFAULT '{}',
      metadata_json       TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_path)
        REFERENCES knowledge_documents(path)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_blocks_path_order_idx
    ON knowledge_document_blocks(document_path, block_order);
  `);

  sqlite.exec(`
    UPDATE knowledge_documents
    SET mime_type = COALESCE(mime_type, 'text/markdown')
    WHERE mime_type IS NULL;
  `);
}

function addMissingColumns(sqlite: MigratableDb, table: string, columns: Array<[string, string]>) {
  const existing = new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
  );

  for (const [name, spec] of columns) {
    if (!existing.has(name)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`);
    }
  }
}
