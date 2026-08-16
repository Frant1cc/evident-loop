import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const testEvents = sqliteTable('test_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  message: text('message').notNull(),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`)
});

export const knowledgeDocuments = sqliteTable('knowledge_documents', {
  path: text('path').primaryKey(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  sourceType: text('source_type').notNull().default('manual'),
  format: text('format').notNull().default('md'),
  mimeType: text('mime_type'),
  originalName: text('original_name'),
  originalSize: integer('original_size'),
  storageKey: text('storage_key'),
  parserName: text('parser_name').notNull().default('markdown'),
  parserVersion: text('parser_version').notNull().default('1'),
  parseWarningsJson: text('parse_warnings_json').notNull().default('[]'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  contentHash: text('content_hash'),
  originalHash: text('original_hash')
});

export const knowledgeDocumentBlocks = sqliteTable('knowledge_document_blocks', {
  id: text('id').primaryKey(),
  documentPath: text('document_path').notNull(),
  blockOrder: integer('block_order').notNull(),
  blockType: text('block_type').notNull(),
  text: text('text').notNull(),
  headingPathJson: text('heading_path_json').notNull().default('[]'),
  locatorJson: text('locator_json').notNull().default('{}'),
  metadataJson: text('metadata_json').notNull().default('{}')
});

export const ragEvaluations = sqliteTable('rag_evaluations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed'] }).notNull(),
  completedCases: integer('completed_cases').notNull(),
  totalCases: integer('total_cases').notNull(),
  currentCaseId: text('current_case_id'),
  configJson: text('config_json').notNull(),
  reportJson: text('report_json'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull()
});

export const webEvaluations = sqliteTable('web_evaluations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed'] }).notNull(),
  completedCases: integer('completed_cases').notNull(),
  totalCases: integer('total_cases').notNull(),
  currentCaseId: text('current_case_id'),
  configJson: text('config_json').notNull(),
  reportJson: text('report_json'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull()
});

export const webEvaluationCases = sqliteTable('web_evaluation_cases', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  question: text('question').notNull(),
  category: text('category').notNull(),
  answerable: integer('answerable', { mode: 'boolean' }).notNull(),
  includeDomainsJson: text('include_domains_json'),
  expectedDomainsJson: text('expected_domains_json').notNull(),
  expectedEvidenceJson: text('expected_evidence_json').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const chatConversations = sqliteTable('chat_conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['streaming', 'complete', 'error'] }).notNull(),
  createdAt: text('created_at').notNull()
});

export const researchConversations = sqliteTable('research_conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  topic: text('topic'),
  summary: text('summary'),
  contextStateJson: text('context_state_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const researchMessages = sqliteTable('research_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['streaming', 'complete', 'error'] }).notNull(),
  createdAt: text('created_at').notNull()
});

export const researchRuns = sqliteTable('research_runs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userMessageId: text('user_message_id').notNull(),
  assistantMessageId: text('assistant_message_id').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] }).notNull(),
  inputJson: text('input_json').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull()
});

export const researchSteps = sqliteTable('research_steps', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  messageId: text('message_id').notNull(),
  sequence: integer('sequence').notNull(),
  type: text('type', { enum: ['llm', 'tool'] }).notNull(),
  status: text('status', { enum: ['running', 'complete', 'error'] }).notNull(),
  title: text('title').notNull(),
  inputJson: text('input_json'),
  outputJson: text('output_json'),
  parentStepId: text('parent_step_id'),
  toolCallId: text('tool_call_id'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at')
});

export const researchSources = sqliteTable('research_sources', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  sourceId: text('source_id').notNull(),
  citationKey: text('citation_key').notNull(),
  file: text('file').notNull(),
  title: text('title').notNull(),
  heading: text('heading'),
  content: text('content').notNull(),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  score: real('score').notNull(),
  locatorJson: text('locator_json'),
  createdAt: text('created_at').notNull()
});

export const researchNotes = sqliteTable('research_notes', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentTasks = sqliteTable('agent_tasks', {
  id: text('id').primaryKey(),
  goal: text('goal').notNull(),
  status: text('status', {
    enum: ['created', 'planning', 'awaiting_approval', 'running', 'paused', 'completed', 'failed', 'cancelled']
  }).notNull(),
  currentStepId: text('current_step_id'),
  maxSteps: integer('max_steps').notNull(),
  maxTokens: integer('max_tokens').notNull(),
  allowedToolsJson: text('allowed_tools_json').notNull(),
  checkpointVersion: integer('checkpoint_version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentPlanSteps = sqliteTable('agent_plan_steps', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  sequence: integer('sequence').notNull(),
  objective: text('objective').notNull(),
  expectedEvidenceJson: text('expected_evidence_json').notNull(),
  dependenciesJson: text('dependencies_json').notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed', 'blocked', 'skipped'] }).notNull(),
  attempts: integer('attempts').notNull(),
  inputJson: text('input_json'),
  outputJson: text('output_json'),
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentReviews = sqliteTable('agent_reviews', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id').notNull(),
  verdict: text('verdict', { enum: ['pass', 'needs_more_evidence'] }).notNull(),
  summary: text('summary').notNull(),
  supportedClaimsJson: text('supported_claims_json').notNull(),
  unsupportedClaimsJson: text('unsupported_claims_json').notNull(),
  limitationsJson: text('limitations_json').notNull(),
  createdAt: text('created_at').notNull()
});

export const agentEvidenceGaps = sqliteTable('agent_evidence_gaps', {
  id: text('id').primaryKey(),
  reviewId: text('review_id').notNull(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id').notNull(),
  description: text('description').notNull(),
  requiredEvidence: text('required_evidence').notNull(),
  suggestedQuery: text('suggested_query').notNull(),
  status: text('status', { enum: ['open', 'scheduled', 'resolved', 'unresolved'] }).notNull(),
  supplementalStepId: text('supplemental_step_id'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at')
});

export const agentSources = sqliteTable('agent_sources', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id'),
  toolExecutionId: text('tool_execution_id'),
  sourceKey: text('source_key').notNull(),
  type: text('type', { enum: ['knowledge_document', 'document', 'web', 'tool_result', 'other'] }).notNull(),
  title: text('title').notNull(),
  uri: text('uri'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentEvidence = sqliteTable('agent_evidence', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id'),
  sourceId: text('source_id').notNull(),
  evidenceKey: text('evidence_key').notNull(),
  content: text('content').notNull(),
  context: text('context'),
  locatorJson: text('locator_json'),
  relevanceScore: real('relevance_score'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentClaims = sqliteTable('agent_claims', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id'),
  claimKey: text('claim_key').notNull(),
  text: text('text').notNull(),
  status: text('status', { enum: ['proposed', 'supported', 'unsupported', 'conflicted'] }).notNull(),
  confidence: real('confidence'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentClaimEvidence = sqliteTable('agent_claim_evidence', {
  taskId: text('task_id').notNull(),
  claimId: text('claim_id').notNull(),
  evidenceId: text('evidence_id').notNull(),
  relation: text('relation', { enum: ['supports', 'contradicts', 'context'] }).notNull(),
  rationale: text('rationale'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const agentEvents = sqliteTable('agent_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  sequence: integer('sequence').notNull(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull()
});

export const agentCheckpoints = sqliteTable('agent_checkpoints', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  version: integer('version').notNull(),
  stateJson: text('state_json').notNull(),
  createdAt: text('created_at').notNull()
});

export const toolExecutions = sqliteTable('tool_executions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  stepId: text('step_id'),
  executionKey: text('execution_key').notNull(),
  toolName: text('tool_name').notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  argumentsJson: text('arguments_json').notNull(),
  resultJson: text('result_json'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at')
});

export const agentArtifacts = sqliteTable('agent_artifacts', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  type: text('type', { enum: ['report'] }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['completed'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});
