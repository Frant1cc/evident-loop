export type SseMessage = {
  event: string;
  data: string;
  id?: string;
};

export async function consumeSse(options: {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  onMessage: (message: SseMessage) => void;
}) {
  const headers = options.body === undefined ? undefined : { 'Content-Type': 'application/json' };
  const response = await fetch(options.url, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
  });

  if (!response.ok || !response.body) {
    throw new Error(await readApiError(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, options.onMessage);
  }

  buffer += decoder.decode();
  parseSseChunk(`${buffer}\n\n`, options.onMessage);
}

export function parseSseJson<T>(message: SseMessage): T {
  try {
    return JSON.parse(message.data) as T;
  } catch {
    throw new Error(`无法解析 SSE 事件“${message.event}”的数据。`);
  }
}

export function parseSseChunk(buffer: string, onMessage: (message: SseMessage) => void) {
  let rest = buffer;

  while (true) {
    const boundary = findEventBoundary(rest);
    if (!boundary) return rest;
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary.length);
    const message = parseSseFrame(frame);
    if (message) onMessage(message);
  }
}

async function readApiError(response: Response) {
  const payload = await response.json().catch(() => null) as { message?: unknown } | null;
  return typeof payload?.message === 'string' && payload.message
    ? payload.message
    : `请求失败：${response.status}`;
}

function findEventBoundary(buffer: string) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseSseFrame(frame: string): SseMessage | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'id' && !value.includes('\0')) id = value;
  }

  if (!data.length) return undefined;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}
