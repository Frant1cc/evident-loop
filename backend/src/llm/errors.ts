export class LlmNotConfiguredError extends Error {
  constructor() {
    super('LLM provider is not configured');
    this.name = 'LlmNotConfiguredError';
  }
}
