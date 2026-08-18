import type { AgentTaskStatus } from './types.js';

const allowedTransitions: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  created: ['planning', 'cancelled'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: ['running', 'cancelled'],
  cancelled: []
};

export function assertTaskTransition(from: AgentTaskStatus, to: AgentTaskStatus) {
  if (!canTransitionTask(from, to)) {
    throw new InvalidTaskTransitionError(from, to);
  }
}

function canTransitionTask(from: AgentTaskStatus, to: AgentTaskStatus) {
  return allowedTransitions[from].includes(to);
}

export class InvalidTaskTransitionError extends Error {
  constructor(public readonly from: AgentTaskStatus, public readonly to: AgentTaskStatus) {
    super(`Invalid agent task transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

