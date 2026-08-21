export class RendererUnavailableError extends Error {
  readonly code = 'renderer_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'RendererUnavailableError';
  }
}
