import {
  type AiProvider,
  AiProviderError,
  type AiProviderErrorKind,
  type AiProviderRequest,
  type AiProviderResponse,
} from './ai-provider';

/** One scripted outcome for the next call (tests). */
export type FakeBehaviour =
  | 'ok'
  | Exclude<AiProviderErrorKind, 'aborted'>
  /** Valid JSON that cites an id outside the manifest. */
  | 'invented-id'
  /** Not JSON at all. */
  | 'invalid-json'
  /** Never answers until the request is aborted. */
  | 'hang'
  /** Answers exactly this text (BIB-41's validation fixtures). */
  | { text: string };

const ID_PATTERN = /id="([0-9a-f-]{36})"/g;
const PAIR_PATTERN = /between node "([0-9a-f-]{36})" and node "([0-9a-f-]{36})"/;

/**
 * A deterministic, in-process provider for development and tests (PRD section 38: AI tests never
 * need a real provider or key). Its answer is computed from the prompt alone: a fixed overview
 * citing the first three ids in the context, so the same context always gives the same output.
 * For a relationships prompt (BIB-42) it proposes one `related_to` edge between the two requested
 * nodes, citing both.
 * Nothing leaves the process. Tests script failures with `script(...)` and observe `calls`.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'Fake (development)';
  readonly modelId = 'fake-model-1';
  /** Number of `generate` calls made, so tests can prove "no call". */
  calls = 0;
  private queue: FakeBehaviour[] = [];
  /** Runs inside `generate` before it answers (e.g. a test revoking consent mid-call). */
  beforeAnswer: (() => Promise<void>) | null = null;

  script(...behaviours: FakeBehaviour[]): void {
    this.queue.push(...behaviours);
  }

  reset(): void {
    this.calls = 0;
    this.queue = [];
    this.beforeAnswer = null;
  }

  countTokens(request: Omit<AiProviderRequest, 'maxOutputTokens'>): Promise<number> {
    return Promise.resolve(estimateTokens(request.system) + estimateTokens(request.prompt));
  }

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    this.calls += 1;
    const behaviour = this.queue.shift() ?? 'ok';
    if (behaviour === 'hang') {
      await new Promise<never>((_, reject) => {
        const abort = () => reject(new AiProviderError('aborted'));
        if (request.signal.aborted) abort();
        request.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (this.beforeAnswer) await this.beforeAnswer();
    if (request.signal.aborted) throw new AiProviderError('aborted');
    if (typeof behaviour === 'object') {
      return {
        text: behaviour.text,
        inputTokens: estimateTokens(request.system) + estimateTokens(request.prompt),
        outputTokens: estimateTokens(behaviour.text),
      };
    }
    if (
      behaviour === 'transient' ||
      behaviour === 'timeout' ||
      behaviour === 'refused' ||
      behaviour === 'fatal'
    ) {
      throw new AiProviderError(behaviour);
    }
    const ids = [...request.prompt.matchAll(ID_PATTERN)].map((match) => match[1] ?? '');
    const unique = [...new Set(ids)].slice(0, 3);
    const pair = PAIR_PATTERN.exec(request.prompt);
    const invented = '00000000-0000-4000-8000-000000000000';
    const output =
      behaviour === 'invalid-json'
        ? 'not json'
        : pair
          ? JSON.stringify({
              proposals: [
                {
                  sourceNodeId: pair[1],
                  targetNodeId: pair[2],
                  type: 'related_to',
                  rationale: 'These two items may address a shared theme.',
                  evidence: [
                    { id: behaviour === 'invented-id' ? invented : pair[1] },
                    { id: pair[2] },
                  ],
                },
              ],
            })
          : JSON.stringify({
              overview: `Summary of ${new Set(ids).size} study items.`,
              citedIds:
                behaviour === 'invented-id'
                  ? [...unique, '00000000-0000-4000-8000-000000000000']
                  : unique,
            });
    return {
      text: output,
      inputTokens: estimateTokens(request.system) + estimateTokens(request.prompt),
      outputTokens: estimateTokens(output),
    };
  }

  costMicros(inputTokens: number, outputTokens: number): number {
    return inputTokens + outputTokens;
  }
}

/** A conservative local estimate (about four characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
