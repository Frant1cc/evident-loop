import 'dotenv/config';

import { syncRagIndex } from './sync.js';

const result = await syncRagIndex();
console.log(
  `RAG sync completed: ${result.documents} documents, ${result.chunks} chunks, ${result.unchanged} unchanged, ${result.upserted} upserted, ${result.deleted} deleted, collection "${result.collection}" in ${result.durationMs}ms`
);
