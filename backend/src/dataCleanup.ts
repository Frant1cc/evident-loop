import type { ArtifactApplication } from './modules/artifacts/index.js';
import { pruneExpiredResearchData } from './modules/research/index.js';
import { pruneExpiredTaskData } from './modules/tasks/index.js';
import { isPublicDemoEnabled, pruneDemoMetadata } from './modules/demo/index.js';

export const DEMO_DATA_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function isDemoDataCleanupEnabled() {
  return isPublicDemoEnabled() || process.env.DEMO_DATA_CLEANUP_ENABLED === 'true';
}

export async function cleanupExpiredDemoData(
  artifacts: Pick<ArtifactApplication, 'deleteConversationArtifacts'>,
  now = Date.now()
) {
  const cutoff = new Date(now - DEMO_DATA_CLEANUP_INTERVAL_MS).toISOString();
  const research = await pruneExpiredResearchData({ cutoff, artifacts });
  const tasks = pruneExpiredTaskData(cutoff);
  pruneDemoMetadata(now);
  return { conversations: research.deleted, tasks, failedConversations: research.failed };
}

/** Opt-in for a dedicated demo instance; never erase local history by default. */
export function startDemoDataCleanup(options: {
  artifacts: Pick<ArtifactApplication, 'deleteConversationArtifacts'>;
  enabled?: boolean;
  intervalMs?: number;
  cleanup?: () => Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: () => void;
}): () => Promise<void> {
  if (!(options.enabled ?? isDemoDataCleanupEnabled())) return async () => {};
  let running: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || running) return;
    running = Promise.resolve()
      .then(() => (options.cleanup ?? (() => cleanupExpiredDemoData(options.artifacts)))())
      .then((result) => {
        (options.onSuccess ?? ((summary) => console.log('Demo data cleanup completed', summary)))(result);
      })
      .catch(() => {
        // Do not log document contents, file paths, or provider errors.
        (options.onError ?? (() => console.error('Demo data cleanup failed; will retry on the next sweep')))();
      })
      .finally(() => { running = undefined; });
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? DEMO_DATA_CLEANUP_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
