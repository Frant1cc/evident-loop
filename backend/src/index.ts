import 'dotenv/config';

import { createProductionApp } from './app.js';
import { artifactStore, startArtifactCleanup } from './artifacts/store.js';
import { initDb } from './db.js';
import { initRagIndex } from './rag/index.js';
import { failOrphanedResearchRuns, recoverCompletedArtifactDraftRequests } from './research/service.js';
import { failOrphanedAgentTasks } from './runtime/service.js';
import { startStreamEventCleanup } from './streaming/cleanup.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || '127.0.0.1';

initDb();
const production = createProductionApp({ host, port });
const { app, mcpManager, artifactApplication } = production;
await mcpManager.start();
failOrphanedResearchRuns(artifactApplication);
await recoverCompletedArtifactDraftRequests(artifactApplication);
failOrphanedAgentTasks();
startStreamEventCleanup();
await initRagIndex();
await artifactStore.cleanupExpired();
startArtifactCleanup();

app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);
});

const shutdown = async () => {
  await mcpManager.stop();
};
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
