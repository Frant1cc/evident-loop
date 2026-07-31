const defaultEmbeddingBaseUrl = 'https://api.siliconflow.cn/v1';
const defaultEmbeddingModel = 'Qwen/Qwen3-Embedding-4B';

type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
};

const defaultTimeoutMs = 30_000;
const defaultMaxRetries = 3;

class NonRetryableEmbeddingError extends Error {}

export function isEmbeddingConfigured() {
  return Boolean(process.env.EMBEDDING_API_KEY);
}

export function getEmbeddingModel() {
  return process.env.EMBEDDING_MODEL ?? defaultEmbeddingModel;
}

export async function createEmbedding(input: string): Promise<number[]> {
  const embeddings = await createEmbeddings([input]);
  return embeddings[0]!;
}

/** Creates embeddings in one provider request and preserves the input order. */
export async function createEmbeddings(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const apiKey = process.env.EMBEDDING_API_KEY;

  if (!apiKey) {
    throw new Error('EMBEDDING_API_KEY is not configured');
  }

  const baseUrl = (process.env.EMBEDDING_BASE_URL ?? defaultEmbeddingBaseUrl).replace(/\/$/, '');
  const model = process.env.EMBEDDING_MODEL ?? defaultEmbeddingModel;
  const response = await fetchEmbeddingWithRetry(`${baseUrl}/embeddings`, apiKey, model, inputs);

  const data = (await response.json()) as EmbeddingResponse;
  const rows = data.data;

  if (!rows || rows.length !== inputs.length) {
    throw new Error(`Embedding response returned ${rows?.length ?? 0} vectors for ${inputs.length} inputs`);
  }

  const hasIndexes = rows.some((row) => row.index !== undefined);
  if (
    hasIndexes
    && (
      rows.some((row) => !Number.isInteger(row.index) || row.index! < 0 || row.index! >= inputs.length)
      || new Set(rows.map((row) => row.index)).size !== inputs.length
    )
  ) {
    throw new Error('Embedding response returned invalid or duplicate indexes');
  }
  const ordered = hasIndexes
    ? [...rows].sort((left, right) => left.index! - right.index!)
    : rows;
  const embeddings = ordered.map((row) => row.embedding);

  if (embeddings.some((embedding) => !embedding?.length)) {
    throw new Error('Embedding response did not include a vector for every input');
  }

  const dimensions = new Set(embeddings.map((embedding) => embedding!.length));
  if (dimensions.size !== 1) throw new Error('Embedding response returned inconsistent vector dimensions');
  return embeddings as number[][];
}

async function fetchEmbeddingWithRetry(url: string, apiKey: string, model: string, inputs: string[]) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= defaultMaxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), defaultTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ input: inputs, model }),
        signal: controller.signal
      });

      if (response.ok) return response;
      const errorText = await response.text();
      const error = new Error(errorText || `Embedding request failed with status ${response.status}`);
      if (response.status !== 429 && response.status < 500) {
        throw new NonRetryableEmbeddingError(error.message);
      }
      lastError = error;
    } catch (error) {
      if (error instanceof NonRetryableEmbeddingError) throw error;
      if (error instanceof Error && error.name !== 'AbortError' && attempt >= defaultMaxRetries) throw error;
      lastError = error instanceof Error && error.name === 'AbortError'
        ? new Error(`Embedding request timed out after ${defaultTimeoutMs}ms`)
        : error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < defaultMaxRetries) await delay(250 * 2 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error('Embedding request failed');
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
