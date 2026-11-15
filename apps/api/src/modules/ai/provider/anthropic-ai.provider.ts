import Anthropic from '@anthropic-ai/sdk';
import {
  type AiProvider,
  AiProviderError,
  type AiProviderRequest,
  type AiProviderResponse,
} from './ai-provider';

/** US-dollar micros per token for the configured model (Sonnet 5.5: $2 / $10 per MTok). */
const PRICE_MICROS_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
};
/** Unknown models are costed at a deliberately high rate, so the spend cap errs safe. */
const FALLBACK_PRICE = { input: 10, output: 50 };

/**
 * Anthropic Messages API adapter (PRD section 38). Used only when `AI_PROVIDER=anthropic` and the
 * provider terms are approved (`AI_PROVIDER_TERMS_APPROVED=true`); never needed by tests. The SDK's
 * own retries are off: the job runner owns the retry schedule and the 60-second budget. Errors are
 * mapped to fixed kinds; provider error bodies and model text are never logged or rethrown.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly name = 'Anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly modelId: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async countTokens(request: Omit<AiProviderRequest, 'maxOutputTokens'>): Promise<number> {
    try {
      const counted = await this.client.messages.countTokens(
        {
          model: this.modelId,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        },
        { signal: request.signal },
      );
      return counted.input_tokens;
    } catch (error) {
      throw providerError(error);
    }
  }

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw providerError(error);
    }
    if (message.stop_reason === 'refusal') throw new AiProviderError('refused');
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return {
      text,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }

  costMicros(inputTokens: number, outputTokens: number): number {
    const price = PRICE_MICROS_PER_TOKEN[this.modelId] ?? FALLBACK_PRICE;
    return inputTokens * price.input + outputTokens * price.output;
  }
}

/** Maps an SDK error to a fixed kind. 408/409/429/5xx and connection errors are transient. */
function providerError(error: unknown): AiProviderError {
  if (error instanceof Anthropic.APIUserAbortError) return new AiProviderError('aborted');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError('timeout');
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError('transient');
  if (error instanceof Anthropic.APIError) {
    const raw: unknown = error.status;
    const status = typeof raw === 'number' ? raw : 0;
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return new AiProviderError('transient', retryAfterMs(error.headers as unknown));
    }
    return new AiProviderError('fatal');
  }
  return new AiProviderError('fatal');
}

function retryAfterMs(headers: unknown): number | undefined {
  const value = headers instanceof Headers ? headers.get('retry-after') : null;
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
