/**
 * The AI provider adapter (PRD sections 25, 38: "Provider/model choice is configuration behind an
 * adapter"). Implementations: `FakeAiProvider` (deterministic, in-process; development and tests)
 * and `AnthropicAiProvider`. Only the worker's job runner calls `generate`, never inside a
 * database transaction. Nothing here logs prompt or response text.
 */
export interface AiProviderRequest {
  /** Fixed instructions, schema and trust rules. */
  system: string;
  /** The labelled context blocks and the task. Private study text: never log it. */
  prompt: string;
  /** Provider-enforced output cap. */
  maxOutputTokens: number;
  /** Aborted on timeout, lost lease or consent revocation. */
  signal: AbortSignal;
}

export interface AiProviderResponse {
  /** The raw model text (expected to be JSON). Private: never log it. */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * How a provider call failed. `transient` and `timeout` may be retried within the request budget;
 * `refused` and `fatal` never. `retryAfterMs` carries a provider's Retry-After.
 */
export type AiProviderErrorKind = 'transient' | 'timeout' | 'refused' | 'fatal' | 'aborted';

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiProviderErrorKind,
    readonly retryAfterMs?: number,
  ) {
    // Fixed message: never provider response text.
    super(`AI provider call failed: ${kind}`);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  /** Shown in consent settings, e.g. `Anthropic`. */
  readonly name: string;
  readonly modelId: string;
  /** Input tokens for this request as the provider's tokenizer counts them (PRD section 25). */
  countTokens(request: Omit<AiProviderRequest, 'maxOutputTokens'>): Promise<number>;
  generate(request: AiProviderRequest): Promise<AiProviderResponse>;
  /** Cost of a call in US-dollar micros. */
  costMicros(inputTokens: number, outputTokens: number): number;
}

/**
 * Injection token for the configured provider, or `null` when AI is unavailable in this
 * deployment (`AI_PROVIDER=disabled`, or a real provider whose terms are not approved yet).
 */
export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Injection token for AI limits that tests shorten (lease length, retry delays, timeouts). */
export const AI_RUNTIME = Symbol('AI_RUNTIME');

export interface AiRuntime {
  /** PRD section 25: two-minute lease, renewed while working. */
  leaseMs: number;
  /** How often the worker renews a lease (and notices a cancellation). */
  heartbeatMs: number;
  /** PRD section 22 (NFR-PERF-006): 60-second total request budget. */
  requestBudgetMs: number;
  /** Base delay between provider retries (jittered). */
  retryBaseMs: number;
  /** Worker poll interval when no job is waiting. */
  pollMs: number;
  /** Monthly spend cap in micros. */
  monthlySpendCapMicros: number;
  /** BIB-43 (PRD section 17): automatic summary 30 seconds after the last significant change. */
  summaryDebounceMs?: number;
  /** BIB-43: at most two minutes of waiting during sustained editing. */
  summaryMaxWaitMs?: number;
}

export const SUMMARY_DEBOUNCE_MS = 30_000;
export const SUMMARY_MAX_WAIT_MS = 120_000;

export const DEFAULT_AI_RUNTIME: Omit<AiRuntime, 'monthlySpendCapMicros'> = {
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  requestBudgetMs: 60_000,
  retryBaseMs: 1_000,
  pollMs: 1_000,
};
