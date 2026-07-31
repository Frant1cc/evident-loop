import 'dotenv/config';

import { app } from './app.js';
import { artifactStore, startArtifactCleanup } from './artifacts/store.js';
import { initDb } from './db.js';
import { initRagIndex } from './rag/index.js';

const port = Number(process.env.PORT ?? 3000);

initDb();
await initRagIndex();
await artifactStore.cleanupExpired();
startArtifactCleanup();

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
