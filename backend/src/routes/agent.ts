import { Router } from 'express';

import { runAgentLoop } from '../agent/agentLoop.js';
import { DeepSeekApiError } from '../agent/deepseekClient.js';
import { failure, success } from '../response.js';
import { isExplicitWordDocumentRequest } from '../tools/wordDocumentTool.js';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const MAX_TOOL_ROUNDS = 4;
const AGENT_SYSTEM_PROMPT = `You are EvidentLoop, an evidence-first durable research agent.

Use tools when they help answer with real local project data.

Rules:
- Only use tools listed in the provided tools array.
- Do not write or simulate tool calls in normal text.
- For knowledge base or documentation questions, call search_knowledge first.
- Treat search_knowledge.verdict as authoritative retrieval confidence:
  - sufficient: answer from the returned sources and cite or name them when useful.
  - weak: if rewriteTriggered=true, the automatic rewrite budget is already exhausted; do not search the same intent again and state the evidence limitation. If rewriteTriggered=false, reformulate once with more specific terminology.
  - empty: do not use or cite the returned candidates as evidence; state that the local knowledge base does not cover the question.
- Use read_document only when search_knowledge snippets are not enough.
- Use search_docs only to locate text in a document already identified by a sufficient or weak retrieval; do not use it to override an empty verdict.
- For external facts the local knowledge base cannot answer (library comparisons, versions, releases, current events), call retrieve_web_evidence.
- Call retrieve_web_evidence at most once per user request. It already performs query rewriting and progressive search internally; a second call would incorrectly reset the quality budget.
- Treat retrieve_web_evidence.verdict as authoritative: sufficient may support an answer; exhausted may only support a qualified partial answer; empty must not be presented as evidence. Do not simulate lower-level web_search or fetch_page calls.
- When answering from web results, cite the page title or url.
- Call generate_word_document only when the user explicitly asks to generate, export, download, or create a Word/DOCX file. Ordinary requests to summarize, analyze, or write content should remain normal chat replies.
- For generate_word_document, always put the complete body in contentMarkdown. Never construct a blocks array. Use <!-- pagebreak --> for explicit page breaks.
- When generate_word_document succeeds, call it only once. The client renders the document card from the structured tool result, so do not include downloadUrl, previewUrl, localhost URLs, Markdown download links, or redundant download instructions in the final answer. Give only a concise content summary when useful.
- If a tool fails, explain the failure based on the tool error instead of pretending it succeeded.
- Stop calling tools once you have enough information to answer.`;

export const agentRouter = Router();

agentRouter.post('/agent/chat', async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    res.status(500).json(failure('DEEPSEEK_API_KEY is not configured'));
    return;
  }

  const message = String(req.body?.message ?? '').trim();

  if (!message) {
    res.status(400).json(failure('message is required'));
    return;
  }

  // Abort the loop when the client disconnects so we stop burning LLM/tool budget on abandoned requests.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort(new Error('Client disconnected before the agent finished'));
    }
  });

  try {
    const result = await runAgentLoop({
      apiKey,
      message,
      model: process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      maxToolRounds: MAX_TOOL_ROUNDS,
      requiredToolName: isExplicitWordDocumentRequest(message)
        ? 'generate_word_document'
        : undefined,
      signal: controller.signal
    });

    res.json(success(result));
  } catch (error) {
    // Connection is already gone; nothing to respond to.
    if (controller.signal.aborted) return;

    if (error instanceof DeepSeekApiError) {
      // 401/403 mean a misconfigured key on our side; anything else is an upstream failure.
      const isConfigIssue = error.status === 401 || error.status === 403;
      res.status(isConfigIssue ? 500 : 502).json(failure(error.message));
      return;
    }

    res.status(500).json(failure(error instanceof Error ? error.message : 'Agent chat failed'));
  }
});
