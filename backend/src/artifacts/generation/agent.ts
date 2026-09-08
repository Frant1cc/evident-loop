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
  repair: (spec: ArtifactSpec, format: ArtifactFormat, diagnostics: string[], signal?: AbortSignal) => Promise<ArtifactSpec>;
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
      // Assets are resolved by the application boundary after consent and
      // provider policy checks. HTML rendering never gains arbitrary network
      // access or a general-purpose shell seam.
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
  const fallback = buildFallbackSpec(snapshot, preferences);

  const completion = await options.llm.complete({
    model: options.model,
    temperature: 0.2,
    maxTokens: 10_000,
    // Reasoning models can spend the entire output budget on hidden thinking
    // and return an empty content field. Artifact planning needs the JSON/HTML
    // payload itself, so keep thinking disabled for this structured pass.
    reasoning: false,
    signal,
    messages: [
      { role: 'system', content: artifactPlanningSystemPrompt },
      { role: 'user', content: createPlanningPrompt(snapshot, preferences) }
    ]
  });
  throwIfAborted(signal);
  const content = completion.choices?.[0]?.message?.content?.trim();
  let spec = fallback;
  // An empty or length-truncated provider response must not strand a durable
  // draft request. The visual HTML pass below can still turn the deterministic
  // content plan into a designed deck.
  if (!content) return authorPresentationHtml(options, spec, signal);
  try {
    const plan = parseArtifactPlanModelOutput(parseModelJsonObject(content), {
      brief: fallback.brief,
      presentation: fallback.presentation,
      pdf: fallback.pdf
    });
    spec = mergePlan(snapshot, plan.brief, plan.presentation, plan.pdf, preferences);
  } catch (error) {
    if (isLikelyTruncatedModelOutput(error)) {
      return authorPresentationHtml(options, spec, signal);
    }
    throw new ArtifactPlanningError(
      `Artifact text model returned an invalid plan: ${error instanceof Error ? error.message : 'schema validation failed'}`
    );
  }
  return authorPresentationHtml(options, spec, signal);
}

async function repairArtifact(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  format: ArtifactFormat,
  diagnostics: string[],
  signal: AbortSignal | undefined
) {
  throwIfAborted(signal);
  if (!options.llm) return spec;
  if (format === 'pptx') {
    return authorPresentationHtml(options, spec, signal, diagnostics);
  }
  const completion = await options.llm.complete({
    model: options.model,
    temperature: 0.1,
    maxTokens: 16_000,
    reasoning: false,
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

type AuthoredHtmlBatch = {
  themeCss?: string;
  slides: Array<{ id: string; html: string }>;
};

const presentationHtmlBatchSize = 2;

async function authorPresentationHtml(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  signal: AbortSignal | undefined,
  diagnostics: string[] = []
): Promise<ArtifactSpec> {
  if (!options.llm || !spec.formats.includes('pptx')) return spec;

  const authoredHtml = new Map<string, string>();
  let authoredThemeCss: string | undefined;
  const storyOutline = spec.presentation.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    kind: slide.kind
  }));

  for (let index = 0; index < spec.presentation.slides.length; index += presentationHtmlBatchSize) {
    throwIfAborted(signal);
    const batch = spec.presentation.slides.slice(index, index + presentationHtmlBatchSize);
    const sharedThemeCss = authoredThemeCss ?? (diagnostics.length ? undefined : spec.presentation.themeCss);
    const result = await requestPresentationHtmlBatch(
      options,
      spec,
      storyOutline,
      batch,
      sharedThemeCss,
      diagnostics,
      signal
    );
    if (result?.themeCss && !authoredThemeCss) authoredThemeCss = result.themeCss;
    for (const slide of result?.slides ?? []) authoredHtml.set(slide.id, slide.html);

    // A malformed two-slide response is retried one slide at a time. This
    // bounds the retry output and prevents one truncated JSON string from
    // discarding an otherwise usable presentation draft.
    const missingSlides = batch.filter((slide) => !authoredHtml.has(slide.id));
    if (batch.length > 1 && missingSlides.length) {
      for (const slide of missingSlides) {
        const singleResult = await requestPresentationHtmlBatch(
          options,
          spec,
          storyOutline,
          [slide],
          authoredThemeCss ?? sharedThemeCss,
          diagnostics,
          signal
        );
        if (singleResult?.themeCss && !authoredThemeCss) authoredThemeCss = singleResult.themeCss;
        for (const authoredSlide of singleResult?.slides ?? []) authoredHtml.set(authoredSlide.id, authoredSlide.html);
      }
    }
  }

  return parseArtifactSpec({
    ...spec,
    presentation: {
      ...spec.presentation,
      themeCss: authoredThemeCss ?? spec.presentation.themeCss,
      slides: spec.presentation.slides.map((slide) => ({
        ...slide,
        html: authoredHtml.get(slide.id) ?? slide.html
      }))
    }
  });
}

async function requestPresentationHtmlBatch(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  storyOutline: Array<{ id: string; title: string; kind: string }>,
  slides: ArtifactSpec['presentation']['slides'],
  themeCss: string | undefined,
  diagnostics: string[],
  signal: AbortSignal | undefined
): Promise<AuthoredHtmlBatch | undefined> {
  if (!options.llm) return undefined;
  try {
    const completion = await options.llm.complete({
      model: options.model,
      temperature: diagnostics.length ? 0.1 : 0.35,
      // Keep a generous provider budget even though each response contains at
      // most two concise slides. Batching, rather than a tight token cap, is
      // what guarantees that normal HTML output stays below model limits.
      maxTokens: 16_000,
      reasoning: false,
      signal,
      messages: [
        { role: 'system', content: artifactPresentationHtmlSystemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            deck: {
              title: spec.title,
              audience: spec.audience,
              theme: spec.theme,
              executiveSummary: spec.brief.executiveSummary,
              keyFindings: spec.brief.keyFindings,
              storyOutline
            },
            slides,
            existingThemeCss: themeCss?.slice(0, 16_000),
            diagnostics
          })
        }
      ]
    });
    throwIfAborted(signal);
    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) return undefined;
    return parseAuthoredHtmlBatch(parseModelJsonObject(content), slides.map((slide) => slide.id));
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

function parseAuthoredHtmlBatch(value: unknown, expectedSlideIds: string[]): AuthoredHtmlBatch | undefined {
  if (!isRecord(value) || !Array.isArray(value.slides)) return undefined;
  const expected = new Set(expectedSlideIds);
  const seen = new Set<string>();
  const slides: AuthoredHtmlBatch['slides'] = [];
  for (const candidate of value.slides) {
    if (!isRecord(candidate)) continue;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const html = typeof candidate.html === 'string' ? candidate.html.trim() : '';
    if (!expected.has(id) || seen.has(id) || !html || html.length > 30_000) continue;
    seen.add(id);
    slides.push({ id, html });
  }
  if (!slides.length) return undefined;
  const themeCss = typeof value.themeCss === 'string' && value.themeCss.trim() && value.themeCss.length <= 24_000
    ? value.themeCss.trim()
    : undefined;
  return { themeCss, slides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLikelyTruncatedModelOutput(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unterminated|string in json|unexpected end|end of json|json object not found/i.test(message);
}

function buildFallbackSpec(snapshot: ResearchSnapshot, preferences?: ArtifactPreferences): ArtifactSpec {
  const title = clipText(preferences?.title ?? snapshot.conversationTitle, 200);
  const audience = clipText(preferences?.audience ?? '研究参与者与决策者', 300);
  const sourceCitations = snapshot.sources.slice(0, 100).map((source) => ({
    citationKey: clipText(source.citationKey, 80),
    sourceId: clipText(source.id, 120),
    title: clipText(source.title, 500),
    locator: clipText(`${source.file}:${source.startLine}-${source.endLine}`, 300)
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
      summary: clipText(snapshot.topic ?? `围绕“${title}”整理研究背景、范围和问题定义。`, 4_000),
      keyPoints: takeText(messageText, 4, '研究范围由当前会话中的问题与回答确定。'),
      citations: sourceCitations.slice(0, 4).map((source) => source.citationKey)
    },
    {
      id: 'findings',
      title: '核心发现',
      summary: clipText(snapshot.summary ?? '核心发现来自已完成的研究消息与来源证据。', 4_000),
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
    executiveSummary: clipText(snapshot.summary ?? messageText[0] ?? '本报告汇总当前研究会话中的可用信息。', 8_000),
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
    output: 'Return JSON only with keys brief, presentation, pdf. Plan slide content only: do not include presentation HTML or CSS because those are authored separately in bounded batches. Do not include Markdown fences. preferences.formats is the user-requested file set.'
  });
}

const artifactPresentationDesignGuide = `Adapt these frontend-design principles to a static 16:9 presentation:
- First infer the deck's purpose, audience, tone, and one memorable visual motif. Commit to one deliberate aesthetic direction, such as editorial, technical schematic, refined minimal, industrial, or geometric. Do not default every technical deck to a dark dashboard.
- Use a dominant background/foreground relationship with one sharp accent. Build atmosphere with restrained CSS or inline SVG geometry, texture, rules, or layered transparency when it supports the subject. Avoid generic purple gradients and timid evenly distributed palettes.
- Use the renderer-provided --slide-title-font and --slide-font variables. Create character through scale, weight, spacing, and contrast; never request remote fonts and do not name Inter, Roboto, or Arial as the design concept.
- Prefer one flat, content-specific composition per slide. Use editorial asymmetry, generous negative space, controlled density, diagrams, timelines, comparisons, or evidence-led data displays. Avoid repeated card grids, pills, badges, dashboard panels, and component-library layouts.
- Vary composition across the deck while keeping the motif, typography, palette, and alignment logic coherent. Do not reuse one template with different text.
- Slides are static screenshots. Do not use animations, transitions, hover states, or interactions. Complexity must serve the explanation, not decoration.
- Every slide.html must have exactly one root element with class="slide". That root must fill 1600x900, reserve at least 72px at the bottom for the renderer footer, and keep all visible content inside its bounds. Use at least 24px for compact labels, 30px for body copy, 46px for slide titles, and 68px for the cover title. Prefer cutting copy or changing composition over shrinking text.`;

const artifactPlanningSystemPrompt = `You are EvidentLoop's ArtifactAgent content planner. Convert a frozen research snapshot into one factually consistent ResearchBrief, PresentationPlan, and PdfReportPlan. Plan 8-15 substantive slides and enough substantive report sections for 6-20 actual PDF pages; requested target counts are soft goals and must be normalized to the real plan. Never add filler or no-information pages just to reach a target. Only use facts and citations present in the snapshot; say that evidence is insufficient when needed. Keep the same citation keys across both outputs. preferences.formats lists the files the user asked to generate (pptx, pdf, or both); still return both plans so the shared brief stays consistent, but do not pad a format they did not request.

This is a compact narrative planning pass. Do not generate HTML or CSS here. A separate bounded visual-design pass will author each slide after this JSON has been validated.
Write concise atomic findings and bullets, not copied transcripts or long prose blocks. Keep every key finding, recommendation, key point, slide bullet, and report bullet below 500 characters.

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
const artifactPresentationHtmlSystemPrompt = `You are EvidentLoop's presentation HTML designer. Author only the supplied one or two slides as static 1600x900 HTML. The validated narrative, facts, slide ids, wording, visual data, and citations are immutable. Transform them into a polished visual explanation without inventing evidence.

${artifactPresentationDesignGuide}

Use only HTML, inline SVG, and CSS. Never use scripts, event handlers, forms, iframes, external URLs, remote fonts, data URLs, or fabricated images. The renderer supplies the page number, source strip, and brand logo. Keep markup concise: reuse classes in themeCss rather than repeating long inline styles, and keep each slide HTML comfortably below 6,000 characters.
Scope every selector to .slide or its descendants; do not style html or body because the renderer owns the outer document and frame.

The user input contains the whole deck outline for continuity, the current slides to author, optional existingThemeCss, and optional renderer diagnostics. When existingThemeCss is supplied, reuse it and omit themeCss unless a diagnostic requires a correction. When it is absent, return a coherent shared themeCss. Diagnostics apply only to visual layout and must not change facts or sibling formats.

Return exactly one JSON object with this shape and no other keys:
{
  "themeCss": "optional shared CSS scoped only to .slide and descendants",
  "slides": [
    { "id": "exact supplied slide id", "html": "one root element whose class is slide" }
  ]
}
Return every requested id exactly once and no other ids. Encode newlines inside JSON strings. Do not include Markdown fences or explanatory prose.`;

const artifactRepairSystemPrompt = `You are EvidentLoop's ArtifactAgent repair pass. Repair only the supplied non-presentation format-local plan/layout for the reported renderer/quality diagnostics. Preserve the shared brief, facts, citation keys, title, audience, branding, and user choices; do not change the sibling format. Return the complete valid ArtifactSpec as JSON only. Never add arbitrary URLs, shell commands, secret values, filler pages, or unsupported evidence.`;

function takeText(values: string[], limit: number, fallback?: string) {
  const result = values.map((value) => clipText(value, 1_000)).filter(Boolean).slice(0, limit);
  return result.length ? result : fallback ? [fallback] : ['该部分暂无可用笔记；请在后续研究中补充可验证依据。'];
}

function clipText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const clipped = trimmed.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Artifact generation cancelled');
}
