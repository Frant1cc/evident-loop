import { sqlite } from '../../db.js';

/** Remove idle tasks and their dependent records in one transaction. */
export function pruneExpiredTaskData(cutoff: string): number {
  return sqlite.transaction(() => {
    const candidates = sqlite.prepare(`SELECT t.id FROM agent_tasks t
      WHERE t.updated_at <= @cutoff AND t.status NOT IN ('planning', 'running')
      AND NOT EXISTS (SELECT 1 FROM agent_plan_steps s WHERE s.task_id = t.id
        AND (s.status = 'running' OR s.updated_at > @cutoff))
      AND NOT EXISTS (SELECT 1 FROM tool_executions e WHERE e.task_id = t.id
        AND (e.status = 'running' OR COALESCE(e.completed_at, e.started_at) > @cutoff))
      AND NOT EXISTS (SELECT 1 FROM agent_events e WHERE e.task_id = t.id AND e.created_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_checkpoints c WHERE c.task_id = t.id AND c.created_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_artifacts a WHERE a.task_id = t.id AND a.updated_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_sources s WHERE s.task_id = t.id AND s.updated_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_evidence e WHERE e.task_id = t.id AND e.updated_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_claims c WHERE c.task_id = t.id AND c.updated_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM agent_claim_evidence c WHERE c.task_id = t.id AND c.updated_at > @cutoff)
      AND NOT EXISTS (SELECT 1 FROM tool_approvals a WHERE a.scope_type = 'agent_task' AND a.scope_id = t.id
        AND (a.requested_at > @cutoff OR a.decided_at > @cutoff))`).all({ cutoff }) as Array<{ id: string }>;
    for (const { id } of candidates) {
      sqlite.prepare("DELETE FROM tool_approvals WHERE scope_type = 'agent_task' AND scope_id = ?").run(id);
      sqlite.prepare('DELETE FROM stream_events WHERE stream_id = ?').run(id);
      sqlite.prepare('DELETE FROM agent_tasks WHERE id = ?').run(id);
    }
    return candidates.length;
  })();
}
