import type { KeywordSearchResult } from './keywordStore.js';
import type { RagSource } from './types.js';

/**
 * Hybrid 检索的融合与多样性控制，全部为纯函数，便于单元测试。
 *
 * RRF（Reciprocal Rank Fusion）：只用名次不用原始分数融合两路召回，
 * 规避 BM25 与余弦相似度分数尺度不可比的问题：
 *
 *   RRF(chunk) = Σ 1 / (k + rank_i)   （rank 从 1 开始，k 为平滑常数，常取 60）
 *
 * 同文档限流：融合后的最终列表中每篇文档最多保留 N 条 chunk，
 * 防止单文档的多个 chunk 挤占 Top-K（dense-baseline 里 multi_document 类失败的主因）。
 */

export const defaultRrfK = 60;
export const defaultMaxChunksPerFile = 2;

export type RrfOptions = {
  k?: number;
  /**
   * 弱关键词命中的权重折减（0~1）。字符 bigram BM25 的尾部噪声较多
   * （hybrid-v1 A/B 显示等权融合会让噪声把 dense 的正确排序挤出 Top-K），
   * 折减后关键词路作为"补充信号"而非平等一路。
   */
  keywordBaseWeight?: number;
  /** bm25 达到该值视为强词法命中（精确术语场景，如 DV01、enable.idempotence），保持满权重 */
  keywordStrongScore?: number;
  /** 关键词 top1 bm25 低于该值视为整路无词法信号（纯改述查询），丢弃关键词路 */
  keywordMinTopScore?: number;
};

export const defaultRrfOptions: Required<RrfOptions> = {
  k: defaultRrfK,
  keywordBaseWeight: 0.5,
  keywordStrongScore: 25,
  keywordMinTopScore: 12
};

/**
 * 融合 Dense 与 Keyword 两路已排序候选（分数感知加权 RRF）。
 * 返回按融合分降序的去重列表：`score` 为融合分，
 * `semanticScore` / `keywordScore` 保留各自原始分数供排序解释与证据元数据使用。
 */
export function rrfFuse(
  dense: RagSource[],
  keyword: KeywordSearchResult[],
  options: RrfOptions = {}
): RagSource[] {
  const { k, keywordBaseWeight, keywordStrongScore, keywordMinTopScore } = { ...defaultRrfOptions, ...options };
  if (k <= 0) throw new Error('RRF smoothing constant k must be positive');
  if (keywordBaseWeight < 0 || keywordBaseWeight > 1) throw new Error('keywordBaseWeight must be within [0, 1]');

  // 关键词列表按 bm25 降序，top1 低于门槛说明查询与语料没有词法重合，整路都是噪声
  const keywordSignal = keyword.length && keyword[0]!.keywordScore >= keywordMinTopScore ? keyword : [];

  const fused = new Map<string, RagSource & { fusedScore: number }>();

  dense.forEach((result, index) => {
    fused.set(result.id, {
      ...result,
      semanticScore: result.semanticScore ?? result.score,
      fusedScore: 1 / (k + index + 1)
    });
  });

  keywordSignal.forEach((result, index) => {
    const weight = result.keywordScore >= keywordStrongScore ? 1 : keywordBaseWeight;
    const contribution = weight / (k + index + 1);
    const existing = fused.get(result.id);
    if (existing) {
      existing.fusedScore += contribution;
      existing.keywordScore = result.keywordScore;
    } else {
      fused.set(result.id, {
        ...result,
        score: 0,
        keywordScore: result.keywordScore,
        fusedScore: contribution
      });
    }
  });

  return [...fused.values()]
    .sort((left, right) =>
      right.fusedScore - left.fusedScore
      || (right.semanticScore ?? 0) - (left.semanticScore ?? 0)
      || left.id.localeCompare(right.id)
    )
    .map(({ fusedScore, ...rest }) => ({ ...rest, score: fusedScore }));
}

/** 保持输入顺序，限制每篇文档最多出现 maxPerFile 条结果 */
export function limitChunksPerFile(results: RagSource[], maxPerFile = defaultMaxChunksPerFile): RagSource[] {
  if (maxPerFile < 1) throw new Error('maxPerFile must be at least 1');

  const counts = new Map<string, number>();
  const limited: RagSource[] = [];

  for (const result of results) {
    const used = counts.get(result.file) ?? 0;
    if (used >= maxPerFile) continue;
    counts.set(result.file, used + 1);
    limited.push(result);
  }

  return limited;
}
