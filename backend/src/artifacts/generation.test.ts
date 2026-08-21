import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import {
  createResearchConversation,
  createResearchMessage,
  updateResearchMessage,
  createResearchNote,
  addResearchSource
} from '../research/store.js';
import { createArtifactAgent, type ArtifactAgent } from './generation/agent.js';
import { createCredentialCipher, generateCredentialKey } from '../mcp/crypto.js';
import { createImageProviderStore } from './generation/imageProviders.js';
import { fetchSourceImage, generateImageAsset, ImageAssetError } from './generation/images.js';
import { createArtifactGenerationService } from './generation/service.js';
import { createResearchSnapshot } from './generation/snapshot.js';
import { createArtifactGeneration } from './generation/repository.js';
import { listArtifactAssets } from './generation/repository.js';
import { RendererUnavailableError } from './generation/errors.js';
import type {
  ArtifactBinaryStore,
  ArtifactFormat,
  ArtifactQualityInspector,
  ArtifactRenderer,
  RendererResult
} from './generation/types.js';

initDb();

test('research snapshot digest is deterministic and detects completed-message changes', () => {
  const conversation = createResearchConversation();
  createResearchMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '请研究可观测性方案',
    status: 'complete'
  });
  const first = createResearchSnapshot(conversation.id);
  const second = createResearchSnapshot(conversation.id);
  assert.equal(first.digest, second.digest);
  createResearchMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '结论：需要统一指标和追踪。',
    status: 'complete'
  });
  const changed = createResearchSnapshot(conversation.id);
  assert.notEqual(first.digest, changed.digest);
});

test('artifact generation creates an editable draft and a partial result when one renderer fails', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '研究数据库迁移', status: 'complete' });
  const assistant = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '迁移应当可回滚。', status: 'complete' });
  createResearchNote(conversation.id, '先做备份和演练');
  addResearchSource(assistant.id, {
    id: 'source-1',
    file: 'migration.md',
    title: 'Migration guide',
    content: 'Backup before migration',
    startLine: 1,
    endLine: 2,
    score: 1
  }, 'S1');

  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const renderers = {
    pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')),
    pdf: {
      render: async () => { throw new Error('Chromium unavailable'); }
    } satisfies ArtifactRenderer
  } satisfies Record<ArtifactFormat, ArtifactRenderer>;
  const inspector: ArtifactQualityInspector = {
    inspect: async () => ({ ok: true, diagnostics: [] })
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers,
    qualityInspector: inspector,
    binaryStore
  });

  const draft = await service.createDraft(conversation.id);
  assert.equal(draft.status, 'awaiting_confirmation');
  assert.equal(draft.spec.theme, 'research');
  const generation = service.startRender(draft.id);
  assert.equal(service.get(draft.id)?.status, 'superseded');
  await service.waitForRender(generation.id);
  const completed = service.get(generation.id)!;
  assert.equal(completed.status, 'partial');
  assert.equal(completed.outputs.find((output) => output.format === 'pptx')?.status, 'completed');
  assert.equal(completed.outputs.find((output) => output.format === 'pdf')?.status, 'failed');
  assert.equal(binary.size, 1);
});

test('conversation artifact deletion compensates binary removal failures before deleting metadata', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '建立删除补偿测试', status: 'complete' });
  const binary = new Map<string, Buffer>();
  let deleteCount = 0;
  let failDelete = true;
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => {
      deleteCount += 1;
      if (failDelete && deleteCount === 2) throw new Error('simulated volume failure');
      binary.delete(key);
    }
  };
  const successRenderer = fakeRenderer('pptx', Buffer.from('PK\x03\x04'));
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: successRenderer, pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore
  });

  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  assert.equal(binary.size, 2);

  await assert.rejects(() => service.deleteConversationArtifacts(conversation.id), /simulated volume failure/);
  assert.equal(binary.size, 2);
  assert.equal(service.list(conversation.id).length, 2);

  failDelete = false;
  await service.deleteConversationArtifacts(conversation.id);
  assert.equal(binary.size, 0);
  assert.equal(service.list(conversation.id).length, 0);
});

test('image provider credentials are encrypted and source image policy rejects unsafe requests', async () => {
  const store = createImageProviderStore(undefined, createCredentialCipher(generateCredentialKey()));
  const provider = store.save({
    name: 'Images',
    baseUrl: 'https://images.example.test/v1',
    model: 'image-model',
    apiKey: 'do-not-log-this'
  });
  assert.equal(provider.credentialConfigured, true);
  const raw = (await import('../db.js')).sqlite.prepare('SELECT encrypted_api_key FROM artifact_image_providers WHERE id = ?').get(provider.id) as { encrypted_api_key: string };
  assert.ok(raw.encrypted_api_key);
  assert.doesNotMatch(raw.encrypted_api_key, /do-not-log-this/);
  await assert.rejects(
    () => fetchSourceImage({ generationId: provider.id, imageUrl: 'http://example.test/a.png', licenseConfirmed: true }),
    (error: unknown) => error instanceof ImageAssetError && error.message.includes('HTTPS')
  );
  await assert.rejects(
    () => fetchSourceImage({ generationId: provider.id, imageUrl: 'https://127.0.0.1/a.png', licenseConfirmed: true }),
    (error: unknown) => error instanceof ImageAssetError && error.message.includes('private')
  );
  await assert.rejects(
    () => fetchSourceImage({ generationId: provider.id, imageUrl: 'https://[fd00::1]/a.png', licenseConfirmed: true }),
    (error: unknown) => error instanceof ImageAssetError && error.message.includes('private')
  );
});

test('source image response bodies are stream-limited even with a custom fetch adapter', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12345'));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'image/png' } });
  await assert.rejects(
    () => fetchSourceImage({ generationId: '00000000-0000-0000-0000-000000000099', imageUrl: 'https://example.test/a.png', licenseConfirmed: true }, {
      fetchImpl: async () => response,
      maxBytes: 4
    }),
    (error: unknown) => error instanceof ImageAssetError && error.message.includes('byte limit')
  );
});

test('image providers reject unsafe base URLs and never replay bearer credentials across a POST redirect', async () => {
  const store = createImageProviderStore(undefined, createCredentialCipher(generateCredentialKey()));
  assert.throws(() => store.save({ name: 'local', baseUrl: 'https://127.0.0.1/v1', model: 'image', apiKey: 'secret' }), /private|local network/);
  const provider = store.save({ name: 'redirect-provider', baseUrl: 'https://images.example.test/v1', model: 'image', apiKey: 'secret' });
  const calls: string[] = [];
  const authorizationHeaders: string[] = [];
  await assert.rejects(
    () => generateImageAsset({ generationId: provider.id, providerId: provider.id, prompt: 'test', providerStore: store }, {
      fetchImpl: async (url, init) => {
        calls.push(String(url));
        authorizationHeaders.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
      }
    }),
    (error: unknown) => error instanceof ImageAssetError && /POST redirects are not allowed/.test(error.message)
  );
  assert.deepEqual(calls, ['https://images.example.test/v1/images/generations']);
  assert.deepEqual(authorizationHeaders, ['Bearer secret']);
});

test('stale drafts cannot render after the research conversation changes', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '初始问题', status: 'complete' });
  const service = createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) });
  const draft = await service.createDraft(conversation.id);
  createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '新增结论', status: 'complete' });
  assert.throws(() => service.startRender(draft.id), (error: unknown) => error instanceof Error && error.message.includes('stale'));
  assert.equal(service.get(draft.id)?.stale, true);
});

test('deferred natural-language artifact request uses the same streaming-to-complete snapshot boundary', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '研究 active run 边界', status: 'complete' });
  const assistant = createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '正在研究', status: 'streaming' });
  let active = true;
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    isResearchConversationActive: () => active
  });
  await assert.rejects(() => service.createDraft(conversation.id), /active research run/);
  const queued = await service.requestDraft(conversation.id, undefined, undefined, { researchRunId: 'run-deferred-boundary' });
  assert.equal(queued.queued, true);
  assert.equal(service.list(conversation.id).length, 0);
  updateResearchMessage(assistant.id, { content: '完成结论', status: 'complete' });
  active = false;
  const created = await service.flushPendingDrafts(conversation.id, 'run-deferred-boundary');
  assert.equal(created.length, 1);
  assert.equal(created[0]?.snapshot.messages.some((message) => message.content === '完成结论'), true);
  assert.equal(created[0]?.stale, false);
});

test('deferred artifact requests are durable, run-bound, and terminal on failed planning', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '持久化队列', status: 'complete' });
  let active = true;
  const failingAgent: ArtifactAgent = {
    ...createArtifactAgent({ model: 'test' }),
    plan: async () => { throw new Error('planning model unavailable'); }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: failingAgent,
    isResearchConversationActive: () => active
  });
  const queued = await service.requestDraft(conversation.id, undefined, undefined, { researchRunId: 'failed-run' });
  assert.equal(queued.queued, true);
  assert.equal(service.listDraftRequests(conversation.id, 'failed-run')[0]?.status, 'queued');

  // A fresh service instance can see the same queue, but a later run cannot
  // consume it by accident.
  const restarted = createArtifactGenerationService({
    model: 'test',
    agent: failingAgent,
    isResearchConversationActive: () => false
  });
  assert.equal((await restarted.flushPendingDrafts(conversation.id, 'new-run')).length, 0);
  assert.equal(restarted.listDraftRequests(conversation.id, 'failed-run')[0]?.status, 'queued');

  active = false;
  assert.equal(service.finalizePendingDrafts(conversation.id, 'failed', 'failed-run', 'research run failed'), 1);
  assert.equal(restarted.listDraftRequests(conversation.id, 'failed-run')[0]?.status, 'failed');
  assert.match(restarted.listDraftRequests(conversation.id, 'failed-run')[0]?.error ?? '', /research run failed/);
});

test('queued artifact requests are cancelled when their research run is cancelled', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '取消队列', status: 'complete' });
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    isResearchConversationActive: () => true
  });
  await service.requestDraft(conversation.id, undefined, undefined, { researchRunId: 'cancelled-run' });
  assert.equal(service.finalizePendingDrafts(conversation.id, 'cancelled', 'cancelled-run'), 1);
  assert.equal(service.listDraftRequests(conversation.id, 'cancelled-run')[0]?.status, 'cancelled');
  assert.equal((await service.flushPendingDrafts(conversation.id, 'cancelled-run')).length, 0);
});

test('ArtifactAgent sends only the frozen snapshot to the text model and validates structured output', async () => {
  let prompt = '';
  const llm = {
    complete: async (request: { messages: Array<{ role: string; content: string }> }) => {
      prompt = request.messages[1]?.content ?? '';
      return {
        choices: [{ message: { role: 'assistant' as const, content: JSON.stringify({
          brief: {
            title: '研究',
            audience: '团队',
            executiveSummary: '摘要',
            keyFindings: ['发现'],
            recommendations: ['建议'],
            sections: [{ id: 's1', title: '发现', summary: '说明', keyPoints: ['要点'], citations: [] }],
            citations: []
          },
          presentation: {
            slides: [
              { id: 't', title: '研究', kind: 'title', bullets: [], citations: [] },
              { id: 's', title: '发现', kind: 'content', bullets: ['要点'], citations: [] },
              { id: 'c', title: '结论', kind: 'closing', bullets: ['建议'], citations: [] },
              { id: 'e', title: '证据', kind: 'content', bullets: ['证据'], citations: [] },
              { id: 'r', title: '风险', kind: 'content', bullets: ['风险'], citations: [] },
              { id: 'n', title: '下一步', kind: 'content', bullets: ['行动'], citations: [] },
              { id: 'x', title: '限制', kind: 'content', bullets: ['限制'], citations: [] },
              { id: 'z', title: '参考', kind: 'content', bullets: ['来源'], citations: [] }
            ],
            targetSlideCount: 8
          },
          pdf: {
            sections: [{ id: 'p1', title: '发现', paragraphs: ['说明'], bullets: ['要点'], citations: [] }, { id: 'p2', title: '建议', paragraphs: ['建议'], bullets: [], citations: [] }, { id: 'p3', title: '结论', paragraphs: ['结束'], bullets: [], citations: [] }, { id: 'p4', title: '边界', paragraphs: ['边界'], bullets: [], citations: [] }],
            targetPageCount: 6
          }
        }) } }]
      };
    }
  };
  const snapshot = {
    conversationId: '00000000-0000-0000-0000-000000000001',
    conversationTitle: '会话',
    messages: [{ id: 'm', role: 'user' as const, content: '问题', createdAt: '2026-01-01' }],
    sources: [],
    notes: [],
    capturedAt: '2026-01-01',
    digest: 'digest'
  };
  const spec = await createArtifactAgent({ llm, model: 'artifact-model' }).plan(snapshot);
  assert.equal(spec.title, '研究');
  assert.equal(spec.presentation.slides.length, spec.presentation.targetSlideCount);
  assert.match(prompt, /会话/);
  assert.doesNotMatch(prompt, /system prompt|tool trace|shell command/i);
});

test('ArtifactAgent explicitly orchestrates renderer, frozen assets, and quality inspection', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '编排测试', status: 'complete' });
  const snapshot = createResearchSnapshot(conversation.id);
  const agent = createArtifactAgent({ model: 'test' });
  const spec = await agent.plan(snapshot);
  const events: string[] = [];
  const execution = await agent.execute({
    format: 'pdf',
    spec,
    snapshot,
    renderer: {
      render: async (_spec, _snapshot, context) => {
        events.push(context?.assets?.length ? 'asset' : 'builtin');
        return { buffer: Buffer.from('%PDF-1.7'), fileName: 'test.pdf', contentType: 'application/pdf' };
      }
    },
    qualityInspector: {
      inspect: async () => {
        events.push('inspect');
        return { ok: true, diagnostics: [] };
      }
    },
    context: { snapshot, assets: [] }
  });
  assert.equal(execution.quality.ok, true);
  assert.deepEqual(events, ['builtin', 'inspect']);
});

test('ArtifactAgent rejects an undersized model plan instead of inventing filler pages', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '不足页数规划', status: 'complete' });
  const snapshot = createResearchSnapshot(conversation.id);
  const fallback = await createArtifactAgent({ model: 'test' }).plan(snapshot);
  const llm = {
    complete: async () => ({
      choices: [{ message: {
        role: 'assistant' as const,
        content: JSON.stringify({
          brief: fallback.brief,
          presentation: { ...fallback.presentation, slides: fallback.presentation.slides.slice(0, 3) },
          pdf: fallback.pdf
        })
      } }]
    })
  };
  await assert.rejects(
    () => createArtifactAgent({ llm, model: 'test' }).plan(snapshot),
    /invalid plan.*8 and 15 substantive slides/
  );
});

test('ArtifactAgent completes a truncated plan that omitted citations, presentation, and pdf', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '截断规划', status: 'complete' });
  const snapshot = createResearchSnapshot(conversation.id);
  const llm = {
    complete: async () => ({
      choices: [{ message: {
        role: 'assistant' as const,
        content: JSON.stringify({
          brief: {
            title: '模型标题',
            audience: '决策者',
            executiveSummary: '模型摘要',
            keyFindings: ['发现一'],
            recommendations: ['建议一'],
            sections: [{ id: 's1', title: '背景', summary: '说明', keyPoints: ['要点'] }]
          }
        })
      } }]
    })
  };
  const spec = await createArtifactAgent({ llm, model: 'test' }).plan(snapshot);
  assert.equal(spec.title, '模型标题');
  assert.equal(spec.brief.executiveSummary, '模型摘要');
  assert.ok(Array.isArray(spec.brief.citations));
  assert.ok(spec.presentation.slides.length >= 8);
  assert.ok(spec.pdf.sections.length >= 4);
});

test('renderer_unavailable fails outputs without spending repair attempts', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '环境缺失测试', status: 'complete' });
  const base = createArtifactAgent({ model: 'test' });
  let repairs = 0;
  const agent: ArtifactAgent = {
    ...base,
    repair: async (spec) => {
      repairs += 1;
      return spec;
    }
  };
  const unavailable = { render: async () => { throw new RendererUnavailableError('Chromium unavailable'); } } satisfies ArtifactRenderer;
  const service = createArtifactGenerationService({
    model: 'test',
    agent,
    renderers: { pptx: unavailable, pdf: unavailable },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const completed = service.get(generation.id)!;
  assert.equal(completed.status, 'failed');
  assert.equal(completed.outputs.every((output) => output.status === 'failed'), true);
  assert.equal(repairs, 0);
});

test('confirmed output retry uses its frozen snapshot after the conversation changes', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '可重试产物', status: 'complete' });
  let failPptx = true;
  const pptx: ArtifactRenderer = {
    render: async () => {
      if (failPptx) throw new Error('temporary PPTX failure');
      return { buffer: Buffer.from('PK\x03\x04'), fileName: 'test.pptx', contentType: 'application/octet-stream' };
    }
  };
  const pdf = fakeRenderer('pdf', Buffer.from('%PDF-1.7'));
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx, pdf },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const immutable = service.startRender(draft.id);
  await service.waitForRender(immutable.id);
  const partial = service.get(immutable.id)!;
  const failed = partial.outputs.find((output) => output.format === 'pptx')!;
  assert.equal(failed.status, 'failed');
  createResearchMessage({ conversationId: conversation.id, role: 'assistant', content: '会话后来新增内容', status: 'complete' });
  failPptx = false;
  service.retryOutput(failed.id);
  await service.waitForRender(immutable.id);
  const retried = service.get(immutable.id)!;
  assert.equal(retried.outputs.find((output) => output.format === 'pptx')?.status, 'completed');
});

test('repair suggestions never mutate an immutable generation spec', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '不可变 spec', status: 'complete' });
  const base = createArtifactAgent({ model: 'test' });
  let repairs = 0;
  const agent: ArtifactAgent = {
    ...base,
    repair: async (spec) => {
      repairs += 1;
      return {
        ...spec,
        presentation: {
          ...spec.presentation,
          slides: spec.presentation.slides.map((slide, index) => index === 1 ? { ...slide, title: `${slide.title} repaired` } : slide)
        }
      };
    }
  };
  const alwaysFails: ArtifactRenderer = { render: async () => { throw new Error('overflow'); } };
  const service = createArtifactGenerationService({
    model: 'test',
    agent,
    renderers: { pptx: alwaysFails, pdf: alwaysFails },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  assert.equal(repairs, 4);
  assert.equal(service.get(generation.id)?.spec.title, draft.spec.title);
});

test('repair feeds an ephemeral spec to the next renderer attempt', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '临时修复 spec', status: 'complete' });
  const base = createArtifactAgent({ model: 'test' });
  let attempts = 0;
  const titles: string[] = [];
  const agent: ArtifactAgent = {
    ...base,
    repair: async (spec) => ({
      ...spec,
      presentation: {
        ...spec.presentation,
        slides: spec.presentation.slides.map((slide, index) => index === 1 ? { ...slide, title: `${slide.title} repaired` } : slide)
      }
    })
  };
  const pptx: ArtifactRenderer = {
    render: async (spec) => {
      titles.push(spec.presentation.slides[1]?.title ?? 'missing');
      attempts += 1;
      if (attempts === 1) throw new Error('temporary layout issue');
      return { buffer: Buffer.from('PK\\x03\\x04'), fileName: 'repaired.pptx', contentType: 'application/octet-stream' };
    }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent,
    renderers: { pptx, pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  assert.equal(titles.length >= 2, true);
  assert.notEqual(titles[1], titles[0]);
  assert.equal(service.get(generation.id)?.spec.title, draft.spec.title);
});

test('generation deletion waits for an in-flight render before removing metadata', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '删除竞态', status: 'complete' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocked: ArtifactRenderer = {
    render: async () => {
      await gate;
      return { buffer: Buffer.from('PK\x03\x04'), fileName: 'blocked.pptx', contentType: 'application/octet-stream' };
    }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: blocked, pdf: blocked },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  const deleting = service.deleteGeneration(generation.id);
  await Promise.resolve();
  assert.ok(service.get(generation.id));
  release();
  assert.equal(await deleting, true);
  assert.equal(service.get(generation.id), undefined);
});

test('concurrent format retries are independently drained before generation deletion', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '并发格式重试删除', status: 'complete' });
  let phase: 'fail' | 'block' = 'fail';
  let active = 0;
  let finished = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const renderer: ArtifactRenderer = {
    render: async (_spec, _snapshot, context) => {
      if (phase === 'fail') throw new Error('initial render failure');
      active += 1;
      try {
        await gate;
        return { buffer: Buffer.from('artifact'), fileName: 'retry.bin', contentType: 'application/octet-stream' };
      } finally {
        active -= 1;
        finished += 1;
        void context;
      }
    }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: renderer, pdf: renderer },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const failed = service.get(generation.id)!;
  phase = 'block';
  service.retryOutput(failed.outputs.find((output) => output.format === 'pptx')!.id);
  service.retryOutput(failed.outputs.find((output) => output.format === 'pdf')!.id);
  await Promise.resolve();
  assert.equal(active, 2);
  const deleting = service.deleteGeneration(generation.id);
  await Promise.resolve();
  assert.ok(service.get(generation.id));
  release();
  assert.equal(await deleting, true);
  assert.equal(finished, 2);
  assert.equal(service.get(generation.id), undefined);
});

test('cancellation drains every format task and prevents late completion writes', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '取消多格式任务', status: 'complete' });
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binary = new Map<string, Buffer>();
  const renderer: ArtifactRenderer = {
    render: async (_spec, _snapshot, context) => {
      if (fail) throw new Error('first failure');
      await gate;
      void context;
      return { buffer: Buffer.from('late'), fileName: 'late.bin', contentType: 'application/octet-stream' };
    }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: renderer, pdf: renderer },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore: {
      put: async (key, value) => { binary.set(key, value); },
      get: async (key) => binary.get(key) ?? null,
      delete: async (key) => { binary.delete(key); }
    }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  fail = false;
  service.retryOutput(service.get(generation.id)!.outputs.find((output) => output.format === 'pptx')!.id);
  service.retryOutput(service.get(generation.id)!.outputs.find((output) => output.format === 'pdf')!.id);
  service.cancel(generation.id);
  release();
  await service.waitForRender(generation.id);
  const cancelled = service.get(generation.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.outputs.every((output) => output.status === 'cancelled'), true);
  assert.equal(binary.size, 0);
});

test('artifact version allocation remains unique under concurrent callers', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '版本并发', status: 'complete' });
  const service = createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) });
  const draft = await service.createDraft(conversation.id);
  const versions = await Promise.all(Array.from({ length: 4 }, () => Promise.resolve(createArtifactGeneration({
    conversationId: conversation.id,
    snapshot: draft.snapshot,
    spec: draft.spec
  }))));
  assert.equal(new Set(versions.map((item) => item.version)).size, 4);
});

test('image consent is bound to generation and normalized URL', async () => {
  const first = createResearchConversation();
  const second = createResearchConversation();
  createResearchMessage({ conversationId: first.id, role: 'user', content: '图片授权一', status: 'complete' });
  createResearchMessage({ conversationId: second.id, role: 'user', content: '图片授权二', status: 'complete' });
  const service = createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) });
  const firstGeneration = await service.createDraft(first.id);
  const secondGeneration = await service.createDraft(second.id);
  const consent = service.createImageConsent(firstGeneration.id, 'https://images.example.test/chart.png');
  assert.equal(service.verifyImageConsent(firstGeneration.id, consent.id, 'https://images.example.test/chart.png').id, consent.id);
  assert.throws(() => service.verifyImageConsent(secondGeneration.id, consent.id, consent.imageUrl), /does not belong/);
  assert.throws(() => service.verifyImageConsent(firstGeneration.id, consent.id, 'https://images.example.test/other.png'), /does not match/);
});

test('confirmed versions re-home image assets and consents without sharing binary keys', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '复制图片资产', status: 'complete' });
  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const sourcePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')), pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore,
    imageFetchImpl: async () => new Response(sourcePng, { status: 200, headers: { 'content-type': 'image/png' } })
  });
  const draft = await service.createDraft(conversation.id);
  const imageUrl = 'https://images.example.test/chart.png';
  const consent = service.createImageConsent(draft.id, imageUrl, 'source-1');
  await fetchSourceImage({ generationId: draft.id, imageUrl, sourceId: 'source-1', licenseConfirmed: true }, {
    store: binaryStore,
    fetchImpl: async () => new Response(sourcePng, { status: 200, headers: { 'content-type': 'image/png' } })
  });
  const sourceAsset = listArtifactAssets(draft.id)[0]!;
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const clonedAssets = listArtifactAssets(generation.id);
  assert.equal(clonedAssets.length, 1);
  assert.notEqual(clonedAssets[0]?.id, sourceAsset.id);
  assert.notEqual(clonedAssets[0]?.storageKey, sourceAsset.storageKey);
  assert.deepEqual(binary.get(clonedAssets[0]!.storageKey), sourcePng);
  assert.equal(service.get(generation.id)?.imageConsents?.[0]?.imageUrl, consent.imageUrl);

  await service.deleteGeneration(draft.id);
  assert.deepEqual(binary.get(clonedAssets[0]!.storageKey), sourcePng);
  assert.equal(listArtifactAssets(generation.id).length, 1);
});

test('controlled image resolution prefers a configured provider and records provenance before builtin fallback', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '图片 provider 编排', status: 'complete' });
  const providerStore = createImageProviderStore(undefined, createCredentialCipher(generateCredentialKey()));
  const provider = providerStore.save({
    name: 'fake-provider',
    baseUrl: 'https://images.example.test/v1',
    model: 'fake-model',
    apiKey: 'test-key'
  });
  const generatedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const seenAssets: number[] = [];
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    imageProviders: providerStore,
    imageFetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: generatedPng.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }),
    renderers: {
      pptx: { render: async (_spec, _snapshot, context) => { seenAssets.push(context?.assets?.length ?? 0); return fakeRenderer('pptx', Buffer.from('PK\x03\x04')).render(_spec, _snapshot, context); } },
      pdf: { render: async (_spec, _snapshot, context) => { seenAssets.push(context?.assets?.length ?? 0); return fakeRenderer('pdf', Buffer.from('%PDF-1.7')).render(_spec, _snapshot, context); } }
    },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const completed = service.get(generation.id)!;
  assert.equal(completed.status, 'completed');
  assert.ok(seenAssets.some((count) => count > 0));
  assert.equal(completed.outputs.every((output) => output.provenance?.some((item) => item.kind === 'image_provider' && item.providerId === provider.id)), true);
});

test('source image failure falls back to builtin visuals without failing the artifact', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '图片失败回退', status: 'complete' });
  const seenProvenance: string[] = [];
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    imageFetchImpl: async () => { throw new Error('source unavailable'); },
    renderers: {
      pptx: { render: async (_spec, _snapshot, context) => { seenProvenance.push(context?.visualProvenance?.[0]?.kind ?? 'missing'); return fakeRenderer('pptx', Buffer.from('PK\x03\x04')).render(_spec, _snapshot, context); } },
      pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7'))
    },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  service.createImageConsent(draft.id, 'https://images.example.test/unavailable.png');
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const completed = service.get(generation.id)!;
  assert.equal(completed.status, 'completed');
  assert.equal(seenProvenance[0], 'builtin_vector_shape');
  assert.equal(completed.outputs.every((output) => output.provenance?.some((item) => item.kind === 'builtin_vector_shape')), true);
});

test('soft target preferences normalize to substantive fallback counts without filler pages', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '软目标页数', status: 'complete' });
  const service = createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) });
  const draft = await service.createDraft(conversation.id, { targetSlideCount: 15, targetPageCount: 20 });
  assert.equal(draft.spec.presentation.slides.length, 8);
  assert.equal(draft.spec.presentation.targetSlideCount, 8);
  assert.equal(draft.spec.pdf.targetPageCount, draft.spec.pdf.sections.length + 2);
  assert.ok(draft.spec.pdf.targetPageCount >= 6);
  assert.equal(draft.spec.presentation.slides.some((slide) => /补充页|补充要点/.test(slide.title)), false);
  const edited = service.updateDraft(draft.id, {
    ...draft.spec,
    presentation: { ...draft.spec.presentation, targetSlideCount: 15 },
    pdf: { ...draft.spec.pdf, targetPageCount: 20 }
  });
  assert.equal(edited?.spec.presentation.targetSlideCount, draft.spec.presentation.slides.length);
  assert.equal(edited?.spec.pdf.targetPageCount, draft.spec.pdf.sections.length + 2);
});

test('successful outputs persist an immutable, replayable effective rendered spec per format', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '可重放 rendered spec', status: 'complete' });
  const base = createArtifactAgent({ model: 'test' });
  const agent: ArtifactAgent = {
    ...base,
    repair: async (spec, format) => format === 'pptx'
      ? { ...spec, presentation: { ...spec.presentation, slides: spec.presentation.slides.map((slide, index) => index === 1 ? { ...slide, title: `${slide.title} repaired` } : slide) } }
      : spec
  };
  let attempts = 0;
  const pptx: ArtifactRenderer = {
    render: async (spec) => {
      attempts += 1;
      if (attempts === 1) throw new Error('format-local layout issue');
      return { buffer: Buffer.from('PK\x03\x04'), fileName: 'replayed.pptx', contentType: 'application/octet-stream' };
    }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent,
    renderers: { pptx, pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) }
  });
  const draft = await service.createDraft(conversation.id);
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const completed = service.get(generation.id)!;
  const pptOutput = completed.outputs.find((output) => output.format === 'pptx')!;
  const pdfOutput = completed.outputs.find((output) => output.format === 'pdf')!;
  assert.equal(pptOutput.status, 'completed');
  assert.equal(pptOutput.renderedSpec?.brief.executiveSummary, draft.spec.brief.executiveSummary);
  assert.equal(pptOutput.renderedSpec?.presentation.slides[1]?.title.endsWith('repaired'), true);
  assert.equal(pptOutput.renderedSpec?.pdf.targetPageCount, draft.spec.pdf.targetPageCount);
  assert.equal(pptOutput.renderedSpecDigest?.length, 64);
  assert.deepEqual(pdfOutput.renderedSpec?.brief, draft.spec.brief);
  assert.equal(completed.spec.brief.executiveSummary, draft.spec.brief.executiveSummary);
});

test('asset binary re-home failure marks every pending output failed and leaves single-format retry usable', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '素材复制失败', status: 'complete' });
  const sourcePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const binary = new Map<string, Buffer>();
  let failCopy = false;
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => {
      if (failCopy && key.startsWith('assets/')) throw new Error('binary re-home failed');
      binary.set(key, value);
    },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')), pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore
  });
  const draft = await service.createDraft(conversation.id);
  const consent = service.createImageConsent(draft.id, 'https://images.example.test/copy.png');
  await fetchSourceImage({ generationId: draft.id, imageUrl: consent.imageUrl, licenseConfirmed: true }, {
    store: binaryStore,
    fetchImpl: async () => new Response(sourcePng, { status: 200, headers: { 'content-type': 'image/png' } })
  });
  failCopy = true;
  const generation = service.startRender(draft.id);
  await service.waitForRender(generation.id);
  const failed = service.get(generation.id)!;
  assert.equal(failed.outputs.every((output) => output.status === 'failed'), true);
  assert.equal(failed.outputs.every((output) => /binary re-home failed/.test(output.error ?? '')), true);
  failCopy = false;
  service.retryOutput(failed.outputs.find((output) => output.format === 'pptx')!.id);
  await service.waitForRender(generation.id);
  assert.equal(service.get(generation.id)?.outputs.find((output) => output.format === 'pptx')?.status, 'completed');
});

test('confirmed generations cannot add new consent/assets, and media fetch drains before deletion', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '媒体删除竞态', status: 'complete' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')), pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore,
    imageFetchImpl: async (_url, init) => {
      await gate;
      void init;
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
  });
  const draft = await service.createDraft(conversation.id);
  const consent = service.createImageConsent(draft.id, 'https://images.example.test/race.png');
  const media = service.fetchSourceImage({ generationId: draft.id, imageUrl: consent.imageUrl, consentId: consent.id });
  await Promise.resolve();
  const deleting = service.deleteGeneration(draft.id);
  await Promise.resolve();
  assert.ok(service.get(draft.id));
  assert.throws(() => service.createImageConsent(draft.id, 'https://images.example.test/new.png'), /being deleted/);
  release();
  await assert.rejects(() => media, /Artifact generation deleted/);
  assert.equal(await deleting, true);
  assert.equal(service.get(draft.id), undefined);

  const immutableDraft = await service.createDraft(conversation.id);
  const immutable = service.startRender(immutableDraft.id);
  await service.waitForRender(immutable.id);
  assert.throws(() => service.createImageConsent(immutable.id, 'https://images.example.test/immutable.png'), /planning or awaiting-confirmation/);
});

test('confirmation rejects a slow source-image task and only clones the asset after it settles', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '确认与来源图并发', status: 'complete' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    renderers: { pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')), pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore,
    imageFetchImpl: async () => {
      await gate;
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
  });
  const draft = await service.createDraft(conversation.id);
  const consent = service.createImageConsent(draft.id, 'https://images.example.test/slow-source.png');
  const media = service.fetchSourceImage({
    generationId: draft.id,
    imageUrl: consent.imageUrl,
    consentId: consent.id
  });
  await Promise.resolve();
  assert.throws(
    () => service.startRender(draft.id),
    /image operations to finish/
  );
  assert.equal(service.list(conversation.id).length, 1);
  release();
  await media;
  const confirmed = service.startRender(draft.id);
  await service.waitForRender(confirmed.id);
  assert.equal(listArtifactAssets(confirmed.id).length, 1);
  assert.equal(service.get(draft.id)?.status, 'superseded');
});

test('confirmation rejects a slow provider task and re-homes its binary after it settles', async () => {
  const conversation = createResearchConversation();
  createResearchMessage({ conversationId: conversation.id, role: 'user', content: '确认与 provider 并发', status: 'complete' });
  const providerStore = createImageProviderStore(undefined, createCredentialCipher(generateCredentialKey()));
  const provider = providerStore.save({
    name: 'slow-provider',
    baseUrl: 'https://images.example.test/v1',
    model: 'fake-model',
    apiKey: 'slow-key'
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const binary = new Map<string, Buffer>();
  const binaryStore: ArtifactBinaryStore = {
    put: async (key, value) => { binary.set(key, value); },
    get: async (key) => binary.get(key) ?? null,
    delete: async (key) => { binary.delete(key); }
  };
  const service = createArtifactGenerationService({
    model: 'test',
    agent: createArtifactAgent({ model: 'test' }),
    imageProviders: providerStore,
    imageFetchImpl: async () => {
      await gate;
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    renderers: { pptx: fakeRenderer('pptx', Buffer.from('PK\x03\x04')), pdf: fakeRenderer('pdf', Buffer.from('%PDF-1.7')) },
    qualityInspector: { inspect: async () => ({ ok: true, diagnostics: [] }) },
    binaryStore
  });
  const draft = await service.createDraft(conversation.id);
  const media = service.generateImage({ generationId: draft.id, providerId: provider.id, prompt: 'slow visual' });
  await Promise.resolve();
  assert.throws(() => service.startRender(draft.id), /image operations to finish/);
  release();
  await media;
  const confirmed = service.startRender(draft.id);
  await service.waitForRender(confirmed.id);
  const assets = listArtifactAssets(confirmed.id);
  assert.equal(assets.length, 1);
  assert.deepEqual(binary.get(assets[0]!.storageKey), png);
});

function fakeRenderer(format: ArtifactFormat, buffer: Buffer): ArtifactRenderer {
  const result: RendererResult = {
    buffer,
    fileName: `test.${format}`,
    contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  return { render: async () => result };
}
