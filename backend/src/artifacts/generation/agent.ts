import type { LlmProvider } from '../../llm/contracts.js';
import { lastUserTextFromSnapshot, resolveArtifactFormats } from './formats.js';
import { parseArtifactPlanModelOutput, parseArtifactSpec } from './schema.js';
import { parseModelJsonObject } from './parseModelJson.js';
import {
  appendPresentationThemeCss,
  getSlideCssClassNames,
  getSlideHtmlClassNames,
  sanitizeSlideCss,
  validatePresentationSlideHtml
} from './pptxHtml.js';
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
  repair: (
    spec: ArtifactSpec,
    format: ArtifactFormat,
    diagnostics: string[],
    signal?: AbortSignal,
    repairRound?: number
  ) => Promise<ArtifactSpec>;
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
    repair: (spec, format, diagnostics, signal, repairRound) =>
      repairArtifact(options, spec, format, diagnostics, signal, repairRound),
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
      { role: 'user', content: createPlanningPrompt(snapshot, preferences, fallback.formats) }
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
    }, fallback.formats);
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
  signal: AbortSignal | undefined,
  repairRound = 1
) {
  throwIfAborted(signal);
  if (format === 'pptx') {
    if (repairRound >= 2) return repairPresentationWithSafeLayouts(spec, diagnostics);
    if (!options.llm) return repairPresentationWithSafeLayouts(spec, diagnostics);
    const repairSlideIds = presentationRepairSlideIds(spec, diagnostics);
    return authorPresentationHtml(options, spec, signal, diagnostics, repairSlideIds);
  }
  if (!options.llm) return spec;
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
  themeExtensionCss?: string;
  slides: Array<{ id: string; html: string }>;
};

const presentationHtmlBatchSize = 2;

async function authorPresentationHtml(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  signal: AbortSignal | undefined,
  diagnostics: string[] = [],
  targetSlideIds?: Set<string>
): Promise<ArtifactSpec> {
  if (!options.llm || !spec.formats.includes('pptx')) return spec;

  const authoredHtml = new Map<string, string>();
  let authoredThemeCss = spec.presentation.themeCss?.trim() || undefined;
  const authoringFailures = new Map<string, string[]>();
  const slidesToAuthor = targetSlideIds?.size
    ? spec.presentation.slides.filter((slide) => targetSlideIds.has(slide.id) || !slide.html?.trim())
    : spec.presentation.slides;
  if (targetSlideIds?.size) {
    for (const slide of spec.presentation.slides) {
      if (!slidesToAuthor.includes(slide) && slide.html?.trim()) authoredHtml.set(slide.id, slide.html);
    }
  }
  const storyOutline = spec.presentation.slides.map((slide) => ({
    id: slide.id,
    title: slide.title,
    kind: slide.kind
  }));
  if (!authoredThemeCss) {
    authoredThemeCss = await requestPresentationThemeLibrary(options, spec, storyOutline, signal)
      ?? fallbackPresentationThemeCss;
  }
  authoredThemeCss = installPresentationCoreComponents(authoredThemeCss);

  for (let index = 0; index < slidesToAuthor.length; index += presentationHtmlBatchSize) {
    throwIfAborted(signal);
    const batch = slidesToAuthor.slice(index, index + presentationHtmlBatchSize);
    const sharedThemeCss = authoredThemeCss;
    const batchDiagnostics = presentationDiagnosticsForSlides(spec, batch, diagnostics);
    const forbiddenRepairClasses = presentationDiagnosticClassNames(batchDiagnostics);
    const result = await requestPresentationHtmlBatch(
      options,
      spec,
      storyOutline,
      batch,
      sharedThemeCss,
      batchDiagnostics,
      signal
    );
    acceptPresentationHtmlBatch(result, authoredHtml, authoringFailures, {
      get themeCss() { return authoredThemeCss; },
      updateThemeCss: (value) => { authoredThemeCss = value; }
    }, batchDiagnostics.length ? {
      originalHtml: new Map(batch.map((slide) => [slide.id, slide.html?.trim() ?? ''])),
      forbiddenClasses: forbiddenRepairClasses
    } : undefined);

    // A malformed or contract-breaking batch is retried one slide at a time.
    // Retries receive exact validation feedback and must use the same frozen
    // theme, so a late batch cannot silently introduce a second design system.
    const missingSlides = batch.filter((slide) => !authoredHtml.has(slide.id));
    if (missingSlides.length) {
      for (const slide of missingSlides) {
        for (let retry = 0; retry < 2 && !authoredHtml.has(slide.id); retry += 1) {
          const slideDiagnostics = authoringFailures.get(slide.id) ?? [];
          const singleResult = await requestPresentationHtmlBatch(
            options,
            spec,
            storyOutline,
            [slide],
            authoredThemeCss,
            [
              ...presentationDiagnosticsForSlides(spec, [slide], diagnostics),
              ...slideDiagnostics.map((issue) => `Slide ${slide.id}: ${issue}`)
            ],
            signal
          );
          acceptPresentationHtmlBatch(singleResult, authoredHtml, authoringFailures, {
            get themeCss() { return authoredThemeCss; },
            updateThemeCss: (value) => { authoredThemeCss = value; }
          }, {
            originalHtml: new Map([[slide.id, slide.html?.trim() ?? '']]),
            forbiddenClasses: presentationDiagnosticClassNames(
              presentationDiagnosticsForSlides(spec, [slide], diagnostics)
            )
          });
        }
      }
    }
  }

  const missingSlides = spec.presentation.slides.filter((slide) => !authoredHtml.has(slide.id));
  for (const slide of missingSlides) {
    const slideIndex = spec.presentation.slides.findIndex((candidate) => candidate.id === slide.id);
    authoredHtml.set(slide.id, createSafePresentationSlideHtml(slide, slideIndex));
  }

  return parseArtifactSpec({
    ...spec,
    presentation: {
      ...spec.presentation,
      themeCss: authoredThemeCss,
      slides: spec.presentation.slides.map((slide) => ({
        ...slide,
        html: authoredHtml.get(slide.id)
      }))
    }
  });
}

function presentationRepairSlideIds(spec: ArtifactSpec, diagnostics: string[]) {
  const pages = new Set<number>();
  for (const diagnostic of diagnostics) {
    for (const match of diagnostic.matchAll(/(?:slide-|Layout page\s+)(\d+)/gi)) {
      const page = Number(match[1]);
      if (Number.isInteger(page) && page >= 1 && page <= spec.presentation.slides.length) pages.add(page);
    }
  }
  return new Set(
    [...pages].map((page) => spec.presentation.slides[page - 1]?.id).filter((id): id is string => Boolean(id))
  );
}

type SafePresentationLayout = 'list' | 'grid-2x2' | 'bar' | 'table';

const fallbackPresentationThemeCss = `
.slide { --el-accent: #d39b42; --el-text: #f4f1ea; --el-muted: #a9a69f; --el-surface: rgba(255,255,255,0.06); --el-border: rgba(255,255,255,0.18); position: relative; width: 1600px; height: 900px; overflow: hidden; box-sizing: border-box; background: #17191d; color: var(--el-text); font-family: var(--slide-font); }
.slide::before { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, transparent 0 7%, rgba(255,255,255,0.035) 7% 7.08%, transparent 7.08% 100%); }
`;

const safePresentationThemeCss = `
.slide .el-safe-frame { position: absolute; inset: 64px 80px 100px; display: flex; flex-direction: column; color: inherit; }
.slide .el-safe-eyebrow { flex: 0 0 auto; margin-bottom: 12px; color: inherit; opacity: 0.62; font-size: 24px; line-height: 1.2; letter-spacing: 0.08em; }
.slide .el-safe-title { flex: 0 0 auto; margin: 0; max-width: 1360px; color: inherit; font-size: 48px; font-weight: 650; line-height: 1.18; letter-spacing: -0.02em; }
.slide .el-safe-rule { flex: 0 0 auto; width: 120px; height: 4px; margin: 22px 0 28px; background: var(--el-accent, #58a6ff); }
.slide .el-safe-body { min-height: 0; flex: 1 1 auto; }
.slide .el-safe-list { display: grid; grid-template-columns: 1fr; align-content: start; gap: 18px; }
.slide .el-safe-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 18px 28px; }
.slide .el-safe-item { min-width: 0; display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 14px; align-items: start; padding: 16px 18px; border-top: 1px solid var(--el-border, rgba(139, 148, 158, 0.38)); background: var(--el-surface, transparent); }
.slide .el-safe-index { color: var(--el-accent, #58a6ff); font-size: 24px; line-height: 1.35; font-variant-numeric: tabular-nums; }
.slide .el-safe-copy { min-width: 0; color: inherit; opacity: 0.84; font-size: 26px; line-height: 1.42; overflow-wrap: anywhere; }
.slide .el-safe-bars { display: grid; align-content: start; gap: 18px; }
.slide .el-safe-bar-row { display: grid; grid-template-columns: 260px minmax(0, 1fr) 120px; gap: 18px; align-items: center; }
.slide .el-safe-bar-label { color: inherit; opacity: 0.84; font-size: 24px; line-height: 1.3; }
.slide .el-safe-bar-track { height: 24px; background: var(--el-surface, rgba(139, 148, 158, 0.18)); overflow: hidden; }
.slide .el-safe-bar-fill { height: 100%; min-width: 4px; background: var(--el-accent, #58a6ff); }
.slide .el-safe-bar-value { color: inherit; font-size: 24px; line-height: 1.3; text-align: right; font-variant-numeric: tabular-nums; }
.slide .el-safe-table { width: 100%; border-collapse: collapse; table-layout: fixed; color: inherit; }
.slide .el-safe-table th { padding: 12px 14px; border-bottom: 2px solid var(--el-accent, #58a6ff); color: inherit; font-size: 23px; line-height: 1.25; text-align: left; }
.slide .el-safe-table td { padding: 12px 14px; border-bottom: 1px solid var(--el-border, rgba(139, 148, 158, 0.32)); font-size: 22px; line-height: 1.32; vertical-align: top; overflow-wrap: anywhere; }
`;

function installPresentationCoreComponents(themeCss: string) {
  return appendPresentationThemeCss(
    themeCss,
    safePresentationThemeCss,
    getSlideCssClassNames(safePresentationThemeCss)
  );
}

function repairPresentationWithSafeLayouts(spec: ArtifactSpec, diagnostics: string[]) {
  const targetSlideIds = presentationRepairSlideIds(spec, diagnostics);
  if (!targetSlideIds.size) return spec;

  const repairedSlides = spec.presentation.slides.map((slide, index) =>
    targetSlideIds.has(slide.id)
      ? { ...slide, html: createSafePresentationSlideHtml(slide, index) }
      : slide
  );
  const requiredClasses = new Set(
    repairedSlides
      .filter((slide) => targetSlideIds.has(slide.id))
      .flatMap((slide) => [...getSlideHtmlClassNames(slide.html ?? '')])
  );
  const themeCss = appendPresentationThemeCss(
    spec.presentation.themeCss?.trim() ?? '',
    safePresentationThemeCss,
    requiredClasses
  );

  return parseArtifactSpec({
    ...spec,
    presentation: {
      ...spec.presentation,
      themeCss,
      slides: repairedSlides
    }
  });
}

function createSafePresentationSlideHtml(
  slide: ArtifactSpec['presentation']['slides'][number],
  index: number
) {
  const layout = chooseSafePresentationLayout(slide);
  const body = layout === 'bar'
    ? renderSafeBarLayout(slide)
    : layout === 'table'
      ? renderSafeTableLayout(slide)
      : renderSafeListLayout(slide, layout === 'grid-2x2');
  return `<div class="slide"><div class="el-safe-frame" data-layout="${layout}"><div class="el-safe-eyebrow">${String(index + 1).padStart(2, '0')} · ${escapeSlideHtml(safeSlideKindLabel(slide))}</div><h1 class="el-safe-title" data-el-field="title">${escapeSlideHtml(slide.title)}</h1><div class="el-safe-rule"></div>${body}</div></div>`;
}

function safeSlideKindLabel(slide: ArtifactSpec['presentation']['slides'][number]) {
  if (!/[\u3400-\u9fff]/u.test(`${slide.title}${slide.bullets.join('')}`)) return slide.kind;
  return {
    title: '封面',
    content: '内容',
    comparison: '对比',
    closing: '结语'
  }[slide.kind];
}

function chooseSafePresentationLayout(
  slide: ArtifactSpec['presentation']['slides'][number]
): SafePresentationLayout {
  if (slide.visual?.type === 'bar' && slide.visual.values.length <= 8) return 'bar';
  if (
    slide.visual?.type === 'table'
    && slide.visual.headers.length <= 4
    && slide.visual.rows.length <= 6
  ) return 'table';
  return slide.bullets.length >= 4 ? 'grid-2x2' : 'list';
}

function renderSafeListLayout(
  slide: ArtifactSpec['presentation']['slides'][number],
  grid: boolean
) {
  const items = slide.bullets.length ? slide.bullets : [slide.speakerNotes ?? slide.title];
  return `<div class="el-safe-body ${grid ? 'el-safe-grid' : 'el-safe-list'}">${items.map((item, index) => `<div class="el-safe-item"><span class="el-safe-index">${String(index + 1).padStart(2, '0')}</span><span class="el-safe-copy" data-el-bullet-index="${index}">${escapeSlideHtml(item)}</span></div>`).join('')}</div>`;
}

function renderSafeBarLayout(slide: ArtifactSpec['presentation']['slides'][number]) {
  if (slide.visual?.type !== 'bar') return renderSafeListLayout(slide, false);
  const maximum = Math.max(...slide.visual.values.map((value) => Math.abs(value)), 1);
  const rows = slide.visual.labels.map((label, index) => {
    const value = slide.visual?.type === 'bar' ? slide.visual.values[index] ?? 0 : 0;
    const width = Math.max(1, Math.min(100, Math.abs(value) / maximum * 100));
    return `<div class="el-safe-bar-row"><div class="el-safe-bar-label">${escapeSlideHtml(label)}</div><div class="el-safe-bar-track"><div class="el-safe-bar-fill" style="width:${width.toFixed(2)}%"></div></div><div class="el-safe-bar-value">${escapeSlideHtml(String(value))}</div></div>`;
  }).join('');
  return `<div class="el-safe-body el-safe-bars">${rows}</div>`;
}

function renderSafeTableLayout(slide: ArtifactSpec['presentation']['slides'][number]) {
  if (slide.visual?.type !== 'table') return renderSafeListLayout(slide, false);
  const head = `<tr>${slide.visual.headers.map((cell) => `<th>${escapeSlideHtml(cell)}</th>`).join('')}</tr>`;
  const rows = slide.visual.rows.map((row) => `<tr>${slide.visual?.type === 'table' ? slide.visual.headers.map((_header, index) => `<td>${escapeSlideHtml(row[index] ?? '')}</td>`).join('') : ''}</tr>`).join('');
  return `<div class="el-safe-body"><table class="el-safe-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function escapeSlideHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function presentationDiagnosticsForSlides(
  spec: ArtifactSpec,
  slides: ArtifactSpec['presentation']['slides'],
  diagnostics: string[]
) {
  const slideIds = new Set(slides.map((slide) => slide.id));
  const pages = new Set(
    slides
      .map((slide) => spec.presentation.slides.findIndex((candidate) => candidate.id === slide.id) + 1)
      .filter((page) => page > 0)
  );
  const clauses = diagnostics.flatMap((diagnostic) =>
    diagnostic.split(/;\s+(?=Layout (?:box|boxes|page)\b)/i)
  );
  return [...new Set(clauses.filter((diagnostic) =>
    [...slideIds].some((id) => diagnostic.includes(`${id}-`))
    || [...pages].some((page) => new RegExp(`Layout page\\s+${page}\\b`, 'i').test(diagnostic))
  ))];
}

function presentationDiagnosticClassNames(diagnostics: string[]) {
  const classes = new Set<string>();
  for (const diagnostic of diagnostics) {
    for (const match of diagnostic.matchAll(/\[[a-z][\w-]*((?:\.[\w-]+)+)(?:\s|“|\])/gi)) {
      for (const className of (match[1] ?? '').split('.').filter(Boolean)) classes.add(className);
    }
  }
  return classes;
}

function acceptPresentationHtmlBatch(
  result: AuthoredHtmlBatch | undefined,
  authoredHtml: Map<string, string>,
  authoringFailures: Map<string, string[]>,
  theme: { readonly themeCss: string | undefined; updateThemeCss: (value: string) => void },
  repair?: { originalHtml: Map<string, string>; forbiddenClasses: Set<string> }
) {
  if (!result) return;
  const requiredClasses = new Set(
    result.slides.flatMap((slide) => [...getSlideHtmlClassNames(slide.html)])
  );
  const candidateThemeCss = theme.themeCss
    ? appendPresentationThemeCss(theme.themeCss, result.themeExtensionCss ?? '', requiredClasses)
    : result.themeExtensionCss?.trim();
  if (candidateThemeCss && candidateThemeCss !== theme.themeCss) {
    theme.updateThemeCss(candidateThemeCss);
  }
  for (const slide of result.slides) {
    const pageSpecificClasses = [...getSlideHtmlClassNames(slide.html)]
      .filter((className) => /^s\d+[-_]/i.test(className));
    if (pageSpecificClasses.length) {
      authoringFailures.set(slide.id, [`uses page-specific classes instead of reusable components: ${pageSpecificClasses.join(', ')}`]);
      continue;
    }
    if (repair?.originalHtml.get(slide.id) === slide.html.trim()) {
      authoringFailures.set(slide.id, ['repair returned unchanged HTML despite active layout diagnostics']);
      continue;
    }
    const reusedClasses = [...getSlideHtmlClassNames(slide.html)].filter((className) =>
      repair?.forbiddenClasses.has(className)
    );
    if (reusedClasses.length) {
      authoringFailures.set(slide.id, [`repair reused classes responsible for the failed layout: ${reusedClasses.join(', ')}`]);
      continue;
    }
    const issues = candidateThemeCss
      ? validatePresentationSlideHtml(slide.html, candidateThemeCss)
      : ['shared themeCss is required before slide HTML can be accepted'];
    if (issues.length) {
      authoringFailures.set(slide.id, issues);
      continue;
    }
    authoredHtml.set(slide.id, slide.html);
    authoringFailures.delete(slide.id);
  }
}

async function requestPresentationThemeLibrary(
  options: { llm?: ArtifactTextModel; model: string },
  spec: ArtifactSpec,
  storyOutline: Array<{ id: string; title: string; kind: string }>,
  signal: AbortSignal | undefined
) {
  if (!options.llm) return undefined;
  try {
    const completion = await options.llm.complete({
      model: options.model,
      temperature: 0.35,
      maxTokens: 10_000,
      reasoning: false,
      signal,
      messages: [
        { role: 'system', content: artifactPresentationThemeSystemPrompt },
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
            slideNeeds: spec.presentation.slides.map((slide) => ({
              id: slide.id,
              title: slide.title,
              kind: slide.kind,
              bulletCount: slide.bullets.length,
              visualType: slide.visual?.type
            }))
          })
        }
      ]
    });
    throwIfAborted(signal);
    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) return undefined;
    const value = parseModelJsonObject(content);
    if (!isRecord(value) || typeof value.themeCss !== 'string') return undefined;
    const themeCss = sanitizeSlideCss(value.themeCss).trim();
    if (!themeCss || themeCss.length > 48_000 || !isValidPresentationThemeLibrary(themeCss)) return undefined;
    return themeCss;
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

function isValidPresentationThemeLibrary(themeCss: string) {
  const classes = getSlideCssClassNames(themeCss);
  if (!classes.has('slide') || classes.size < 8) return false;
  for (const match of themeCss.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const selector = match[1]?.trim() ?? '';
    if (!selector || selector.startsWith('@')) continue;
    if (selector.split(',').some((part) => !/\.slide\b/.test(part.trim()))) return false;
  }
  return true;
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
            slides: slides.map(({ html: _html, ...slide }) => slide),
            componentThemeCss: themeCss?.slice(0, 56_000),
            componentClasses: themeCss ? [...getSlideCssClassNames(themeCss)].sort() : [],
            forbiddenRepairClasses: diagnostics.length ? [...presentationDiagnosticClassNames(diagnostics)].sort() : [],
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
  const rawExtension = typeof value.themeExtensionCss === 'string'
    ? value.themeExtensionCss
    : typeof value.themeCss === 'string'
      ? value.themeCss
      : '';
  const themeExtensionCss = rawExtension.trim() && rawExtension.length <= 32_000
    ? rawExtension.trim()
    : undefined;
  return { themeExtensionCss, slides };
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
  const formats = resolveArtifactFormats({
    requested: preferences?.formats,
    userText: lastUserTextFromSnapshot(snapshot)
  });
  const slideCount = presentation.slides.length;
  if (formats.includes('pptx') && (slideCount < 8 || slideCount > 15)) {
    throw new ArtifactPlanningError(`Presentation plan contains ${slideCount} content slides; plan between 8 and 15 substantive slides`);
  }
  if (formats.includes('pptx') && !presentation.slides.some((slide) => slide.kind === 'title')) {
    throw new ArtifactPlanningError('Presentation plan must include a substantive title slide');
  }
  const pageCount = pdf.sections.length + 2;
  const wantsLongform = formats.includes('pdf') || formats.includes('docx');
  if (wantsLongform && (pageCount < 6 || pageCount > 20)) {
    throw new ArtifactPlanningError(`PDF plan resolves to ${pageCount} pages; plan between 6 and 20 substantive pages`);
  }
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

function createPlanningPrompt(
  snapshot: ResearchSnapshot,
  preferences: ArtifactPreferences | undefined,
  requestedFormats: ArtifactFormat[]
) {
  return JSON.stringify({
    preferences,
    requestedFormats,
    snapshot: {
      conversationId: snapshot.conversationId,
      conversationTitle: snapshot.conversationTitle,
      topic: snapshot.topic,
      summary: snapshot.summary,
      messages: snapshot.messages,
      sources: snapshot.sources,
      notes: snapshot.notes
    },
    output: 'Return JSON only with keys brief, presentation, pdf. Plan slide content only: do not include presentation HTML or CSS because those are authored separately in bounded batches. Do not include Markdown fences. requestedFormats is authoritative; only requested output plans must satisfy their full count constraints.'
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

const artifactPlanningSystemPrompt = `You are EvidentLoop's ArtifactAgent content planner. Convert a frozen research snapshot into one factually consistent ResearchBrief, PresentationPlan, and PdfReportPlan. requestedFormats is authoritative. For requested PPTX output, plan 8-15 substantive slides. For requested PDF or DOCX output, plan enough substantive report sections for 6-20 actual pages. Requested target counts are soft goals and must be normalized to the real plan. Never add filler or no-information pages just to reach a target. Only use facts and citations present in the snapshot; say that evidence is insufficient when needed. Keep the same citation keys across outputs. Always return all three required JSON keys, but unrequested output plans are compatibility placeholders and do not need to meet their full count constraints.

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
const artifactPresentationThemeSystemPrompt = `You are EvidentLoop's presentation design-system author. Before any slide HTML is written, create one deck-specific CSS component library for a static 1600x900 presentation. Infer a distinctive visual direction from the supplied deck, audience, outline, and slide needs.

${artifactPresentationDesignGuide}

Return CSS only inside one JSON field named "themeCss". The stylesheet must:
- define .slide as the 1600x900 root and set --el-accent, --el-text, --el-muted, --el-surface, and --el-border tokens;
- provide reusable semantic components covering title/section framing, editorial text, metrics, comparisons, timelines/processes, charts, tables, quotes/evidence, and closing pages;
- use semantic class names such as .deck-title, .metric-grid, or .process-flow; never use page-number names such as .s3-title, .slide-7-grid, or one-off id selectors;
- scope every selector to .slide or a .slide pseudo-element; never target html or body;
- preserve at least 72px of footer space and use the renderer's --slide-title-font and --slide-font variables;
- contain no @import, @font-face, URLs, external assets, animations, media queries, or JavaScript-related content.

The component library is a visual grammar, not a command to repeat card grids. Components should support varied compositions while sharing typography, palette, rhythm, and motif. Return exactly {"themeCss":"..."} with valid JSON escaping and no Markdown fences or prose.`;
const artifactPresentationHtmlSystemPrompt = `You are EvidentLoop's presentation HTML designer. Author only the supplied one or two slides as static 1600x900 HTML. The validated narrative, facts, slide ids, wording, visual data, and citations are immutable. Transform them into a polished visual explanation without inventing evidence.

${artifactPresentationDesignGuide}

Use only HTML, inline SVG, and CSS. Never use scripts, event handlers, forms, iframes, external URLs, remote fonts, data URLs, or fabricated images. The renderer supplies the page number, source strip, and brand logo. Keep markup concise: reuse classes in themeCss rather than repeating long inline styles, and keep each slide HTML comfortably below 6,000 characters. Never put a style element inside slide HTML.
Scope every selector to .slide or its descendants; do not style html or body because the renderer owns the outer document and frame.
Put data-el-field="title" on the innermost element containing the exact slide title, and data-el-bullet-index="0", "1", and so on on the innermost text element for each exact slide bullet. These attributes are editing bindings; do not place them on decorative or enclosing layout elements.

The user input contains the whole deck outline for continuity, the current slides to author, componentThemeCss, its complete componentClasses list, and optional renderer diagnostics. The component theme is already frozen for the entire deck. Compose each page from those semantic components and vary the composition without creating a page-specific mini-theme. Never use page-number class names such as s3-title or slide-7-grid. If the composition genuinely needs a missing reusable component, return themeExtensionCss containing only additive .slide-scoped rules for the new semantic classes and define every new class used by the returned HTML. Never redefine .slide or an existing class: the server discards overriding rules and keeps only safe append-only additions. Every class used in HTML is validated against the accumulated theme and any incomplete slide is retried. Diagnostics apply only to visual layout and must not change facts or sibling formats.

When renderer diagnostics are present, this is a mandatory layout repair. Return materially changed HTML for every requested slide and resolve every supplied diagnostic; never echo the current HTML unchanged. Diagnostics use inches on a 13.333 x 7.5 inch canvas corresponding to 1600 x 900 pixels. Keep every text box at least 40px from the left and right edges, at least 30px from the top, and entirely above y=828px so the 72px footer remains clear. Classes listed in forbiddenRepairClasses caused the measured failure and MUST NOT appear in repaired HTML. Replace them with inline geometry or new uniquely named classes with additive CSS. Do not attempt to redefine an existing class. Prefer fewer columns, tighter but readable copy, or a different composition over pushing any element outside the safe area.

Return exactly one JSON object with this shape and no other keys:
{
  "themeExtensionCss": "optional additive CSS for genuinely missing reusable components",
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
