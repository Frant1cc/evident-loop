/**
 * Discriminated event-type identifiers shared by producers (backend) and
 * consumers (frontend). The concrete payload shapes stay in each side's domain
 * types; the protocol package only pins the `type` discriminants and the
 * terminal-event classification so both sides agree on stream lifecycle.
 */

export const RESEARCH_EVENT_TYPES = [
  'research_step',
  'tool_call_started',
  'tool_call_completed',
  'tool_approval_requested',
  'tool_approval_resolved',
  'research_source_found',
  'assistant_delta',
  'research_message_completed',
  'run_updated',
  'error',
  'done'
] as const;

export type ResearchEventType = (typeof RESEARCH_EVENT_TYPES)[number];

/** Frame name reserved for full-state recovery, sent outside the sequence log. */
export const SNAPSHOT_EVENT_TYPE = 'snapshot' as const;

const TERMINAL_EVENT_TYPES = new Set<string>(['done', 'error']);

/** Terminal events close the stream; the client must not retry after one. */
export function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}
