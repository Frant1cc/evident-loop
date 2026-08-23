import type { LlmProvider } from '../../llm/contracts.js';
import { lastUserTextFromSnapshot, resolveArtifactFormats } from './formats.js';
import { parseArtifactPlanModelOutput, parseArtifactSpec } from './schema.js';
import { parseModelJsonObject } from './parseModelJson.js';
import type {
  ArtifactPreferences,
  ArtifactQualityInspector,
  ArtifactRenderer,
  ArtifactSpec,
  ArtifactFormat,
  PdfReportPlan,
  PresentationPlan,
  ResearchBrief,
  ResearchSnapshot,
  RendererContext,
  RendererResult,
  QualityReport
} from './types.js';

export type ArtifactTextModel = Pick<LlmProvider, 'complete'>;

export class ArtifactPlanningError extends Error {
  readonly code = 'artifact_planning_failed';

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPlanningError';
  }
}

export type ArtifactAgent = {
  plan: (snapshot: ResearchSnapshot, preferences?: ArtifactPreferences, signal?: AbortSignal) => Promise<ArtifactSpec>;
  repair: (spec: ArtifactSpec, format: 'pptx' | 'pdf', diagnostics: string[], signal?: AbortSignal) => Promise<ArtifactSpec>;
  /**
   * Execute one deterministic output attempt under the agent's narrow seams.
   * The service owns persistence and retry state; the agent owns the explicit
   * renderer -> inspector hand-off and the frozen asset context. This keeps
   * render/inspect from becoming hidden model-facing tools.
   */
  execute: (input: ArtifactAgentExecutionInput) => Promise<ArtifactAgentExecutionResult>;
};

export type ArtifactAgentExecutionInput = {
  format: ArtifactFormat;
  spec: ArtifactSpec;
  snapshot: ResearchSnapshot;
  renderer: ArtifactRenderer;
  qualityInspector: ArtifactQualityInspector;
  context: RendererContext;
};

export type ArtifactAgentExecutionResult = {
  result: RendererResult;
  quality: QualityReport;
};

export function createArtifactAgent(options: {
  llm?: ArtifactTextModel;
  model: string;
}): ArtifactAgent {
  return {
    plan: (snapshot, preferences, signal) => planArtifact(options, snapshot, preferences, signal),
    repair: (spec, format, diagnostics, signal) => repairArtifact(options, spec, format, diagnostics, signal),
    execute: async ({ renderer, qualityInspector, spec, snapshot, context, format }) => {
      throwIfAborted(context.signal);
      // Assets are resolved by the application boundary (after consent and
      // provider policy checks). When none are available, renderers retain
      // their deterministic native-chart/geometry fallback; no arbitrary URL
      // or shell operation is introduced here.
      context.onProgress?.(context.assets?.length ? `ArtifactAgent uses ${context.assets.length} persisted visual assets for ${format}` : `ArtifactAgent uses builtin visual fallback for ${format}`);
      const result = await renderer.render(spec, snapshot, context);
      throwIfAborted(context.signal);
      const quality = await qualityInspector.inspect(format, result, spec, context);
      return { result, quality };
    }
  };
}

async function planArtifact(
  options: { llm?: ArtifactTextModel; model: string },
  snapshot: ResearchSnapshot,
  preferences: ArtifactPreferences | undefined,
  signal: AbortSignal | undefined
) {
  throwIfAborted(signal);
  if (!options.llm) return buildFallbackSpec(snapshot, preferences);

  const completion = await options.llm.complete({
    model: options.model,
    temperature: 0.2,
    maxTokens: 16_000,
    signal,
    messages: [
      { role: 'system', content: artifactPlanningSystemPrompt },
      { role: 'user', content: createPlanningPrompt(snapshot, preferences) }
    ]
  });
  throwIfAborted(signal);
  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) throw new ArtifactPlanningError('Artifact text model returned no structured plan');
  const fallback = buildFallbackSpec(snapshot, preferences);
  try {
    const plan = parseArtifactPlanModelOutput(parseModelJsonObject(content), {
      brief: fallback.brief,
      presentation: fallback.presentation,
      pdf: fallback.pdf
    });
    return mergePlan(snapshot, plan.brief, plan.presentation, plan.pdf, preferences);
  } catch (error) {
    throw new ArtifactPlanningError(
      `Artifact text model returned an invalid plan: ${error instanceof Error ? error.message : 'schema validation failed'}`
    );
  }
}

async function repairArtifact(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  format: 'pptx' | 'pdf',
  diagnostics: string[],
  signal: AbortSignal | undefined
) {
  throwIfAborted(signal);
  if (!options.llm) return spec;
  const completion = await options.llm.complete({
    model: options.model,
    temperature: 0.1,
    maxTokens: 16_000,
    signal,
    messages: [
      { role: 'system', content: artifactRepairSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({ format, diagnostics, spec })
      }
    ]
  });
  throwIfAborted(signal);
  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) return spec;
  try {
    return parseArtifactSpec(parseModelJsonObject(content));
  } catch {
    return spec;
  }
}

function buildFallbackSpec(snapshot: ResearchSnapshot, preferences?: ArtifactPreferences): ArtifactSpec {
  const title = preferences?.title ?? snapshot.conversationTitle;
  const audience = preferences?.audience ?? '研究参与者与决策者';
  const sourceCitations = snapshot.sources.slice(0, 100).map((source) => ({
    citationKey: source.citationKey,
    sourceId: source.id,
    title: source.title,
    locator: `${source.file}:${source.startLine}-${source.endLine}`
  }));
  const messageText = snapshot.messages.map((message) => message.content).filter(Boolean);
  const keyFindings = takeText(messageText, 5, '研究对话尚未提炼出明确结论。');
  const recommendations = snapshot.notes.length
    ? takeText(snapshot.notes.map((note) => note.content), 5)
    : ['基于来源继续验证关键假设，并在后续版本中更新结论。'];
  const sections = [
    {
      id: 'context',
      title: '研究背景与问题',
      summary: snapshot.topic ?? `围绕“${title}”整理研究背景、范围和问题定义。`,
      keyPoints: takeText(messageText, 4, '研究范围由当前会话中的问题与回答确定。'),
      citations: sourceCitations.slice(0, 4).map((source) => source.citationKey)
    },
    {
      id: 'findings',
      title: '核心发现',
      summary: snapshot.summary ?? '核心发现来自已完成的研究消息与来源证据。',
      keyPoints: keyFindings,
      citations: sourceCitations.slice(0, 8).map((source) => source.citationKey)
    },
    {
      id: 'recommendations',
      title: '建议与下一步',
      summary: '将研究发现转化为可执行的验证与行动计划。',
      keyPoints: recommendations,
      citations: sourceCitations.slice(0, 4).map((source) => source.citationKey)
    }
  ];
  const slides = [
    { id: 'title', title, kind: 'title' as const, bullets: [], citations: [] as string[] },
    ...sections.map((section) => ({
      id: `slide-${section.id}`,
      title: section.title,
      kind: 'content' as const,
      bullets: section.keyPoints.slice(0, 6),
      citations: section.citations
    })),
    {
      id: 'findings-summary',
      title: '结论摘要',
      kind: 'closing' as const,
      bullets: [...keyFindings.slice(0, 4), ...recommendations.slice(0, 2)].slice(0, 6),
      citations: sourceCitations.slice(0, 6).map((source) => source.citationKey)
    },
    {
      id: 'next-steps',
      title: '下一步行动',
      kind: 'closing' as const,
      bullets: recommendations.slice(0, 6),
      citations: sourceCitations.slice(0, 4).map((source) => source.citationKey)
    },
    {
      id: 'evidence',
      title: '证据与限制',
      kind: 'content' as const,
      bullets: [
        `当前快照包含 ${snapshot.sources.length} 条研究来源和 ${snapshot.messages.length} 条已完成消息。`,
        '结论应结合来源定位复核，未覆盖的事实不应视为已验证。'
      ],
      citations: sourceCitations.slice(0, 8).map((source) => source.citationKey)
    },
    {
      id: 'references',
      title: '参考来源',
      kind: 'content' as const,
      bullets: sourceCitations.slice(0, 6).map((source) => `${source.citationKey} ${source.title}`),
      citations: sourceCitations.slice(0, 6).map((source) => source.citationKey)
    }
  ];
  const reportSections = sections.map((section) => ({
    id: `report-${section.id}`,
    title: section.title,
    paragraphs: [section.summary],
    bullets: section.keyPoints,
    citations: section.citations
  }));
  reportSections.push({
    id: 'report-evidence-boundary',
    title: '证据边界与复核方法',
    paragraphs: ['本节说明当前快照覆盖的证据范围、未覆盖的假设以及复核路径，避免将未验证内容误读为结论。'],
    bullets: [
      `当前快照包含 ${snapshot.sources.length} 条来源和 ${snapshot.messages.length} 条已完成消息。`,
      '结论应回到来源定位复核，新增事实需要在后续研究版本中补充证据。'
    ],
    citations: sourceCitations.slice(0, 8).map((source) => source.citationKey)
  });
  const brief: ResearchBrief = {
    title,
    audience,
    executiveSummary: snapshot.summary ?? messageText[0] ?? '本报告汇总当前研究会话中的可用信息。',
    keyFindings,
    recommendations,
    sections,
    citations: sourceCitations
  };
  const presentation: PresentationPlan = {
    slides,
    targetSlideCount: slides.length
  };
  const pdf: PdfReportPlan = {
    sections: reportSections,
    targetPageCount: reportSections.length + 2
  };
  return mergePlan(snapshot, brief, presentation, pdf, preferences);
}

function mergePlan(
  snapshot: ResearchSnapshot,
  brief: ResearchBrief,
  presentation: PresentationPlan,
  pdf: PdfReportPlan,
  preferences?: ArtifactPreferences
): ArtifactSpec {
  const title = preferences?.title ?? brief.title ?? snapshot.conversationTitle;
  const audience = preferences?.audience ?? brief.audience ?? '研究参与者与决策者';
  const theme = preferences?.theme ?? 'research';
  const branding = { ...preferences?.branding };
  const slideCount = presentation.slides.length;
  if (slideCount < 8 || slideCount > 15) {
    throw new ArtifactPlanningError(`Presentation plan contains ${slideCount} content slides; plan between 8 and 15 substantive slides`);
  }
  if (!presentation.slides.some((slide) => slide.kind === 'title')) {
    throw new ArtifactPlanningError('Presentation plan must include a substantive title slide');
  }
  const pageCount = pdf.sections.length + 2;
  if (pageCount < 6 || pageCount > 20) {
    throw new ArtifactPlanningError(`PDF plan resolves to ${pageCount} pages; plan between 6 and 20 substantive pages`);
  }
  const formats = resolveArtifactFormats({
    requested: preferences?.formats,
    userText: lastUserTextFromSnapshot(snapshot)
  });
  return parseArtifactSpec({
    title,
    audience,
    theme,
    branding,
    brief: { ...brief, title, audience },
    formats,
    presentation: {
      ...presentation,
      slides: [
        presentation.slides.find((slide) => slide.kind === 'title')!,
        ...presentation.slides.filter((slide) => slide.kind !== 'title')
      ],
      // Target preferences are soft goals. Persist the actual planned count
      // so QA can require exact reproducibility instead of padding a deck.
      targetSlideCount: slideCount
    },
    pdf: {
      ...pdf,
      // The renderer emits an intro, one page per report section, and a
      // references page. Persist that planned page count, not a requested
      // minimum that could cause blank filler pages.
      targetPageCount: pageCount
    }
  });
}

function createPlanningPrompt(snapshot: ResearchSnapshot, preferences?: ArtifactPreferences) {
  return JSON.stringify({
    preferences,
    snapshot: {
      conversationId: snapshot.conversationId,
      conversationTitle: snapshot.conversationTitle,
      topic: snapshot.topic,
      summary: snapshot.summary,
      messages: snapshot.messages,
      sources: snapshot.sources,
      notes: snapshot.notes
    },
    output: 'Return JSON only with keys brief, presentation, pdf. Do not include Markdown fences. preferences.formats is the user-requested file set.'
  });
}

const artifactPlanningSystemPrompt = `You are EvidentLoop's ArtifactAgent. Convert a frozen research snapshot into one factually consistent ResearchBrief, PresentationPlan, and PdfReportPlan. Plan 8-15 substantive slides and enough substantive report sections for 6-20 actual PDF pages; requested target counts are soft goals and must be normalized to the real plan. Never add filler or no-information pages just to reach a target. Only use facts and citations present in the snapshot; say that evidence is insufficient when needed. Keep the same citation keys across both outputs. preferences.formats lists the files the user asked to generate (pptx, pdf, or both); still return both plans so the shared brief stays consistent, but do not pad a format they did not request.

Return exactly ONE JSON object with ONLY the three keys "brief", "presentation", "pdf". Objects are STRICT: only the fields listed below are allowed, no extra keys, and every listed field is REQUIRED unless marked optional. Use exactly the field names and enum values below.

brief = {
  title: string,
  audience: string,
  executiveSummary: string,
  keyFindings: string[],          // 1-20 items
  recommendations: string[],      // 0-20 items
  sections: [                     // 1-20 items
    {
      id: string,
      title: string,
      summary: string,
      keyPoints: string[],        // 1-12 items
      citations: string[]         // citation keys, 0-24 items
    }
  ],
  citations: [                    // 0-100 items
    {
      citationKey: string,
      sourceId: string,
      title: string,
      locator: string             // optional
    }
  ]
}

presentation = {
  slides: [                       // 3-30 items accepted; plan 8-15 substantive slides
    {
      id: string,
      title: string,
      kind: "title" | "content" | "comparison" | "closing",
      bullets: string[],          // 0-8 items
      speakerNotes: string,       // optional
      citations: string[],        // citation keys, 0-24 items
      visual: {                   // optional; exactly one of these two shapes
        type: "table",
        headers: string[],        // 1-12 items
        rows: string[][]          // 1-50 rows, up to 12 cells each
      }
      // or
      visual: {
        type: "bar",
        labels: string[],         // 1-20 items
        values: number[]          // 1-20 items, finite numbers
      }
    }
  ],
  targetSlideCount: number        // integer 8-15, equal to the real slide count
}

pdf = {
  sections: [                     // 3-30 items accepted; plan enough for 6-20 real pages
    {
      id: string,
      title: string,
      paragraphs: string[],       // 0-12 items
      bullets: string[],          // 0-20 items
      citations: string[]         // citation keys
    }
  ],
  targetPageCount: number         // integer 6-20, equal to sections.length + 2
}

Return a single JSON object only. Every array and object element except the last MUST be followed by a comma. Do not omit commas, do not use trailing commas, and do not put raw line breaks inside strings. Do not include Markdown fences, system instructions, tool traces, secret values, arbitrary URLs, shell commands, or file paths not present in the snapshot.`;
const artifactRepairSystemPrompt = `You are EvidentLoop's ArtifactAgent repair pass. Repair only the supplied format-local plan/layout for the reported renderer/quality diagnostics. Preserve the shared brief, facts, citation keys, title, audience, branding, and user choices; do not change the sibling format. Return the complete valid ArtifactSpec as JSON only. Never add arbitrary URLs, shell commands, secret values, filler pages, or unsupported evidence.`;

function takeText(values: string[], limit: number, fallback?: string) {
  const result = values.map((value) => value.trim()).filter(Boolean).slice(0, limit);
  return result.length ? result : fallback ? [fallback] : ['该部分暂无可用笔记；请在后续研究中补充可验证依据。'];
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Artifact generation cancelled');
}
