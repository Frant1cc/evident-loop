import { Router } from 'express';

import { DEFAULT_MAX_TOOL_ROUNDS } from '../agent/config.js';
import { runAgentLoop } from '../agent/agentLoop.js';
import { createConfiguredLlm } from '../llm/config.js';
import { LlmProviderApiError } from '../llm/openAiCompatibleClient.js';
import { failure, success } from '../response.js';
import type { ToolRuntime } from '../tools/contracts.js';
import { builtInToolRuntime } from '../tools/runtime.js';
import { isExplicitDocumentRequest } from '../tools/wordDocumentTool.js';

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
- search_knowledge already combines semantic and keyword retrieval; use its optional file filter to search within an identified document.
- Use read_document only when search_knowledge snippets are not enough, and read the smallest relevant line range.
- After an empty knowledge search, do not guess a file name or scan documents with read_document.
- For external facts the local knowledge base cannot answer (library comparisons, versions, releases, current events), call retrieve_web_evidence.
- Pass the user's current question to retrieve_web_evidence without adding model names, versions, products, dates, rumors, or factual candidates that the user did not supply. Query translation and source discovery happen inside the tool.
- Call retrieve_web_evidence at most once per user request. It already performs query rewriting and progressive search internally; a second call would incorrectly reset the quality budget.
- Treat retrieve_web_evidence.verdict as authoritative: sufficient may support an answer; exhausted may only support a qualified partial answer; empty must not be presented as evidence. When exhausted has no supported claims, explain the diagnostic cause (rejected candidates, planning fallback, recovery, or budget) and do not claim the search provider returned nothing unless all query result counts are zero. The tool already performs focused company recovery. Do not simulate lower-level web_search or fetch_page calls.
- Every entity in retrieve_web_evidence.requiredMentions must be named explicitly in the answer and bound to one of its sourceUrls. Do not replace a required entity with vague wording such as "a new version".
- When answering from web results, cite the page title or url.
- Call start_document_generation only when the user explicitly asks to generate, export, download, or create a document file (Word, DOCX, PDF report, PPT, PPTX, or slides). Ordinary requests to summarize, analyze, or write content should remain normal chat replies.
- For start_document_generation, specify deliverables based on what the user requested: presentation for PPT/PPTX/slides, longform for Word/DOCX/PDF reports. If the format is unclear, ask before calling the tool.
- When start_document_generation succeeds, call it only once. The client renders the document card from the structured tool result, so do not include download URLs, localhost URLs, or redundant download instructions in the final answer. Give only a concise content summary when useful.
- If a tool fails, explain the failure based on the tool error instead of pretending it succeeded.
- Stop calling tools once you have enough information to answer.`;

export function createAgentRouter(toolRuntime: ToolRuntime = builtInToolRuntime) {
  const router = Router();
  router.post('/agent/chat', async (req, res) => {
    const configuredLlm = createConfiguredLlm();

    if (!configuredLlm.llm) {
      res.status(500).json(failure(`${configuredLlm.providerName} API key is not configured`));
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
        llm: configuredLlm.llm,
        message,
        model: configuredLlm.model,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
        toolRuntime,
        requiredToolName: isExplicitDocumentRequest(message)
          ? 'start_document_generation'
          : undefined,
        signal: controller.signal
      });

      res.json(success(result));
    } catch (error) {
      // Connection is already gone; nothing to respond to.
      if (controller.signal.aborted) return;

      if (error instanceof LlmProviderApiError) {
        // 401/403 mean a misconfigured key on our side; anything else is an upstream failure.
        const isConfigIssue = error.status === 401 || error.status === 403;
        res.status(isConfigIssue ? 500 : 502).json(failure(error.message));
        return;
      }

      res.status(500).json(failure(error instanceof Error ? error.message : 'Agent chat failed'));
    }
  });
  return router;
}

export const agentRouter = createAgentRouter();
