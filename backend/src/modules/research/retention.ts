import { sqlite } from '../../db.js';
import type { ArtifactApplication } from '../artifacts/index.js';

// Notes and artifact work can be newer than the conversation's own timestamp.
const expiredConversation = `c.updated_at <= @cutoff
  AND NOT EXISTS (SELECT 1 FROM research_runs r WHERE r.conversation_id = c.id
    AND (r.status IN ('queued', 'running') OR r.updated_at > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM research_messages m WHERE m.conversation_id = c.id
    AND (m.status = 'streaming' OR m.created_at > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM research_notes n WHERE n.conversation_id = c.id AND n.updated_at > @cutoff)
  AND NOT EXISTS (SELECT 1 FROM research_steps s WHERE s.conversation_id = c.id
    AND (s.status = 'running' OR COALESCE(s.completed_at, s.started_at) > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM research_artifacts g WHERE g.conversation_id = c.id
    AND (g.status IN ('planning', 'rendering', 'validating', 'repairing') OR g.updated_at > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM research_artifact_outputs o
    JOIN research_artifacts g ON g.id = o.generation_id WHERE g.conversation_id = c.id
    AND (o.status IN ('rendering', 'validating') OR o.updated_at > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM research_artifact_assets a
    JOIN research_artifacts g ON g.id = a.generation_id WHERE g.conversation_id = c.id AND a.created_at > @cutoff)
  AND NOT EXISTS (SELECT 1 FROM research_artifact_image_consents i
    WHERE i.conversation_id = c.id AND i.confirmed_at > @cutoff)
  AND NOT EXISTS (SELECT 1 FROM research_artifact_draft_requests d WHERE d.conversation_id = c.id
    AND (d.status IN ('queued', 'running') OR d.updated_at > @cutoff))
  AND NOT EXISTS (SELECT 1 FROM tool_approvals a JOIN research_runs r ON r.id = a.scope_id
    WHERE a.scope_type = 'research_run' AND r.conversation_id = c.id
    AND (a.requested_at > @cutoff OR a.decided_at > @cutoff))`;

/** Remove inactive conversations through the artifact application so binaries are removed too. */
export async function pruneExpiredResearchData(options: {
  cutoff: string;
  artifacts: Pick<ArtifactApplication, 'deleteConversationArtifacts'>;
}) {
  const parameters = { cutoff: options.cutoff };
  const candidates = sqlite.prepare(`SELECT c.id FROM research_conversations c
    WHERE ${expiredConversation} ORDER BY c.updated_at ASC`).all(parameters) as Array<{ id: string }>;
  const eligible = sqlite.prepare(`SELECT c.id FROM research_conversations c
    WHERE c.id = @id AND ${expiredConversation}`);
  const commitDelete = sqlite.transaction((id: string) => {
    // File removal awaits I/O. Recheck activity before committing the database deletion.
    if (!eligible.get({ ...parameters, id })) return false;
    sqlite.prepare(`DELETE FROM stream_events WHERE stream_id IN
      (SELECT id FROM research_runs WHERE conversation_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM tool_approvals WHERE scope_type = 'research_run' AND scope_id IN
      (SELECT id FROM research_runs WHERE conversation_id = ?)`).run(id);
    return sqlite.prepare('DELETE FROM research_conversations WHERE id = ?').run(id).changes > 0;
  });
  let deleted = 0;
  let failed = 0;
  for (const { id } of candidates) {
    if (!eligible.get({ ...parameters, id })) continue;
    let changed = false;
    try {
      await options.artifacts.deleteConversationArtifacts(id, () => {
        const committed = commitDelete(id);
        changed = !committed;
        return committed;
      });
      deleted += 1;
    } catch {
      // The artifact application restores removed binaries when the commit fails.
      // Leave failures for the next sweep and continue with other conversations.
      if (!changed) failed += 1;
    }
  }
  return { deleted, failed };
}
