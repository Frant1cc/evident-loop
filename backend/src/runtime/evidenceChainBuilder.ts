import { createHash } from 'node:crypto';

import type { DeepSeekChatResponse } from '../agent/types.js';
import type { LlmProvider } from '../llm/contracts.js';
import type {
  AgentPlanStep,
  AgentTask,
  EvidenceChainDraft,
  ToolExecution
} from './types.js';

const claimExtractorPrompt = `You extract atomic claims from one completed research step and link them to supplied evidence.

Return JSON only:
{
  "claims": [
    {
      "text": "one atomic claim",
      "status": "proposed" | "supported" | "unsupported" | "conflicted",
      "confidence": 0.0,
      "evidenceLinks": [
        {
          "evidenceKey": "an exact supplied evidenceKey",
          "relation": "supports" | "contradicts" | "context",
          "rationale": "why this evidence has this relation"
        }
      ]
    }
  ]
}

Rules:
- Use the same language as the research goal.
- Split the result into concise, independently checkable claims.
- Never invent an evidenceKey.
- Copy every evidenceKey exactly, including its namespace prefix such as "knowledge:".
- A supported claim must have at least one direct "supports" link.
- If no supplied evidence directly supports a claim, mark it proposed or unsupported.
- Use conflicted when supplied evidence both supports and contradicts the claim.
- Do not convert instructions, limitations or future work into factual claims.`;

export type AgentEvidenceChainBuilder = (context: {
  task: AgentTask;
  step: AgentPlanStep;
  output: unknown;
  toolExecutions: ToolExecution[];
  signal?: AbortSignal;
}) => Promise<EvidenceChainDraft>;

export function createModelEvidenceChainBuilder(llm: LlmProvider, model: string): AgentEvidenceChainBuilder {
  return async ({ task, step, output, toolExecutions, signal }) => {
    const base = buildEvidenceFromToolExecutions(toolExecutions);
    const serialized = JSON.stringify({
      researchGoal: task.goal,
      step: {
        objective: step.objective,
        expectedEvidence: step.expectedEvidence,
        output: claimExtractionOutput(output)
      },
      evidence: base.evidence.map((item) => ({
        evidenceKey: item.evidenceKey,
        content: item.content,
        context: item.context,
        locator: item.locator,
        relevanceScore: item.relevanceScore
      }))
    });
    const boundedInput = serialized.length > 60_000 ? `${serialized.slice(0, 60_000)}\n[claim input truncated]` : serialized;
    const request = {
      model,
      messages: [
        { role: 'system' as const, content: claimExtractorPrompt },
        { role: 'user' as const, content: boundedInput }
      ],
      signal
    };
    let completion = await llm.complete(request);
    let content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      completion = await llm.complete(request);
      content = completion.choices?.[0]?.message?.content;
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(describeEmptyClaimCompletion(completion));
    }
    const extracted = parseEvidenceChainClaims(content, new Set(base.evidence.map((item) => item.evidenceKey)));
    return { ...base, ...extracted };
  };
}

export function buildEvidenceFromToolExecutions(
  toolExecutions: ToolExecution[]
): Pick<EvidenceChainDraft, 'sources' | 'evidence'> {
  const sources = new Map<string, EvidenceChainDraft['sources'][number]>();
  const evidence = new Map<string, EvidenceChainDraft['evidence'][number]>();

  for (const execution of toolExecutions) {
    if (execution.status !== 'completed' || execution.result === undefined) continue;
    if (execution.toolName === 'search_knowledge') {
      const retrieval = recordValue(execution.result);
      if (retrieval?.verdict === 'empty') continue;
      for (const result of resultItems(execution.result)) {
        const file = textValue(result.file) ?? 'unknown-document';
        const content = textValue(result.content);
        if (!content) continue;
        const sourceKey = `knowledge:${file}`;
        sources.set(sourceKey, {
          sourceKey,
          type: 'knowledge_document',
          title: textValue(result.title) ?? file,
          uri: `knowledge://${file}`,
          toolExecutionId: execution.id,
          metadata: { file }
        });
        const rawId = textValue(result.id) ?? fingerprint(`${file}:${content}`);
        const evidenceKey = `knowledge:${rawId}`;
        const locator = recordValue(result.locator);
        evidence.set(evidenceKey, {
          evidenceKey,
          sourceKey,
          content,
          ...(textValue(result.heading) ? { context: textValue(result.heading) } : {}),
          locator: {
            chunkId: textValue(result.id),
            heading: textValue(result.heading),
            startLine: numberValue(result.startLine),
            endLine: numberValue(result.endLine),
            ...(numberValue(locator?.pageStart) === undefined ? {} : { pageStart: numberValue(locator?.pageStart) }),
            ...(numberValue(locator?.pageEnd) === undefined ? {} : { pageEnd: numberValue(locator?.pageEnd) }),
            ...(numberValue(locator?.originalLineStart) === undefined ? {} : { originalLineStart: numberValue(locator?.originalLineStart) }),
            ...(numberValue(locator?.originalLineEnd) === undefined ? {} : { originalLineEnd: numberValue(locator?.originalLineEnd) }),
            ...(textValue(result.format) ? { format: textValue(result.format) } : {})
          },
          ...(normalizedScore(result.score) === undefined ? {} : { relevanceScore: normalizedScore(result.score) })
        });
      }
      continue;
    }

    if (execution.toolName === 'search_docs') {
      for (const result of resultItems(execution.result)) {
        const file = textValue(result.file);
        const preview = textValue(result.preview);
        if (!file || !preview) continue;
        const line = numberValue(result.line);
        const sourceKey = `document:${file}`;
        sources.set(sourceKey, {
          sourceKey,
          type: 'document',
          title: file,
          uri: `document://${file}`,
          toolExecutionId: execution.id,
          metadata: { file }
        });
        const evidenceKey = `docs:${file}:${line ?? 'unknown'}:${fingerprint(preview)}`;
        evidence.set(evidenceKey, {
          evidenceKey,
          sourceKey,
          content: preview,
          locator: { line }
        });
      }
      continue;
    }

    if (execution.toolName === 'read_document') {
      const result = recordValue(execution.result);
      if (!result) continue;
      const file = textValue(result.file);
      const content = textValue(result.content);
      if (!file || !content) continue;
      const sourceKey = `document:${file}`;
      sources.set(sourceKey, {
        sourceKey,
        type: 'document',
        title: file,
        uri: `document://${file}`,
        toolExecutionId: execution.id,
        metadata: { file }
      });
      const evidenceKey = `document:${file}:${fingerprint(content)}`;
      evidence.set(evidenceKey, {
        evidenceKey,
        sourceKey,
        content,
        locator: {
          truncated: Boolean(result.truncated),
          totalChars: numberValue(result.totalChars)
        }
      });
      continue;
    }

    if (execution.toolName === 'retrieve_web_evidence') {
      const result = recordValue(execution.result);
      if (result && Array.isArray(result.sources)) {
        for (const rawSource of result.sources) {
          const source = recordValue(rawSource);
          if (!source) continue;
          const uri = textValue(source.file);
          const content = textValue(source.content);
          if (!uri || !content) continue;
          const rawId = textValue(source.id) ?? fingerprint(`${uri}:${content}`);
          const domain = textValue(source.heading);
          const contentType = textValue(source.contentType);
          const startLine = numberValue(source.startLine);
          const endLine = numberValue(source.endLine);
          const relevanceScore = normalizedScore(source.score);
          const sourceKey = `web:${uri}`;
          sources.set(sourceKey, {
            sourceKey,
            type: 'web',
            title: textValue(source.title) ?? uri,
            uri,
            toolExecutionId: execution.id,
            ...(!domain && !contentType ? {} : {
              metadata: {
                ...(domain ? { domain } : {}),
                ...(contentType ? { contentType } : {})
              }
            })
          });
          const evidenceKey = `web:${rawId}`;
          evidence.set(evidenceKey, {
            evidenceKey,
            sourceKey,
            content,
            ...(domain ? { context: domain } : {}),
            ...(startLine === undefined && endLine === undefined ? {} : {
              locator: {
                ...(startLine === undefined ? {} : { startLine }),
                ...(endLine === undefined ? {} : { endLine })
              }
            }),
            ...(relevanceScore === undefined ? {} : { relevanceScore })
          });
        }
        continue;
      }
    }

    const serialized = safeStringify(execution.result);
    if (!serialized) continue;
    const sourceKey = `tool:${execution.id}`;
    sources.set(sourceKey, {
      sourceKey,
      type: 'tool_result',
      title: `${execution.toolName} 工具结果`,
      uri: `tool-execution://${execution.id}`,
      toolExecutionId: execution.id,
      metadata: { toolName: execution.toolName, arguments: execution.arguments }
    });
    evidence.set(`${sourceKey}:result`, {
      evidenceKey: `${sourceKey}:result`,
      sourceKey,
      content: serialized.length > 12_000 ? `${serialized.slice(0, 12_000)}\n[tool result truncated]` : serialized,
      locator: { toolExecutionId: execution.id }
    });
  }

  return { sources: [...sources.values()], evidence: [...evidence.values()] };
}

export function parseEvidenceChainClaims(
  content: string,
  availableEvidenceKeys: Set<string>
): Pick<EvidenceChainDraft, 'claims' | 'links'> {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(normalized) as unknown;
  } catch {
    throw new Error('Claim extractor returned invalid JSON');
  }
  const root = recordValue(value);
  if (!root || !Array.isArray(root.claims) || !root.claims.length) {
    throw new Error('Claim extractor must return at least one claim');
  }

  const claims = new Map<string, EvidenceChainDraft['claims'][number]>();
  const links = new Map<string, EvidenceChainDraft['links'][number]>();
  for (const rawClaim of root.claims.slice(0, 20)) {
    const claim = recordValue(rawClaim);
    if (!claim) throw new Error('Claim extractor returned an invalid claim');
    const text = requiredText(claim.text, 'claim text');
    const status = claim.status;
    if (status !== 'proposed' && status !== 'supported' && status !== 'unsupported' && status !== 'conflicted') {
      throw new Error('Claim extractor returned an invalid claim status');
    }
    const confidence = normalizedScore(claim.confidence);
    if (confidence === undefined) throw new Error('Claim extractor confidence must be between 0 and 1');
    const claimKey = `claim:${fingerprint(text.toLocaleLowerCase())}`;
    const rawLinks = Array.isArray(claim.evidenceLinks) ? claim.evidenceLinks : [];
    let hasDirectSupport = false;
    for (const rawLink of rawLinks) {
      const link = recordValue(rawLink);
      if (!link) throw new Error('Claim extractor returned an invalid evidence link');
      const requestedEvidenceKey = requiredText(link.evidenceKey, 'evidenceKey');
      const evidenceKey = resolveEvidenceKey(requestedEvidenceKey, availableEvidenceKeys);
      if (!evidenceKey) throw new Error(`Claim extractor referenced unknown evidence ${requestedEvidenceKey}`);
      const relation = link.relation;
      if (relation !== 'supports' && relation !== 'contradicts' && relation !== 'context') {
        throw new Error('Claim extractor returned an invalid evidence relation');
      }
      if (relation === 'supports') hasDirectSupport = true;
      links.set(`${claimKey}\u0000${evidenceKey}`, {
        claimKey,
        evidenceKey,
        relation,
        ...(textValue(link.rationale) ? { rationale: textValue(link.rationale) } : {})
      });
    }
    if (status === 'supported' && !hasDirectSupport) {
      throw new Error('A supported claim must have at least one supporting evidence link');
    }
    claims.set(claimKey, { claimKey, text, status, confidence });
  }
  return { claims: [...claims.values()], links: [...links.values()] };
}

function resolveEvidenceKey(requestedKey: string, availableEvidenceKeys: Set<string>) {
  if (availableEvidenceKeys.has(requestedKey)) return requestedKey;

  // Models occasionally copy a chunk ID but omit its evidence namespace (for
  // example, "knowledge:"). Only repair the key when the suffix is unique so
  // an ambiguous or invented reference can never be accepted silently.
  const suffix = `:${requestedKey}`;
  let match: string | undefined;
  for (const availableKey of availableEvidenceKeys) {
    if (!availableKey.endsWith(suffix)) continue;
    if (match) return undefined;
    match = availableKey;
  }
  return match;
}

export function claimExtractionOutput(output: unknown) {
  const record = recordValue(output);
  if (!record || !('reply' in record) || (!('sources' in record) && !('toolCalls' in record))) return output;
  return { reply: record.reply };
}

export function describeEmptyClaimCompletion(completion: DeepSeekChatResponse) {
  const choiceCount = completion.choices?.length ?? 0;
  return `Claim extractor returned an empty response (choices: ${choiceCount}): ${safeStringify(completion)?.slice(0, 500) ?? '<unserializable completion>'}`;
}

function resultItems(value: unknown) {
  const record = recordValue(value);
  return record && Array.isArray(record.results)
    ? record.results.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown, field: string) {
  const text = textValue(value);
  if (!text) throw new Error(`Claim extractor ${field} is required`);
  return text;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedScore(value: unknown) {
  const score = numberValue(value);
  return score !== undefined && score >= 0 && score <= 1 ? score : undefined;
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
