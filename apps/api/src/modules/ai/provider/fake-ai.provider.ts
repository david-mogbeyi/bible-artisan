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

const PAIR_PATTERN = /between node "([0-9a-f-]{36})" and node "([0-9a-f-]{36})"/;
const TASK_PATTERN = /Task: ([a-z]+)\./;
const BLOCK_PATTERN = /<(study|node|note|event|edge) ([^>]*)>/g;
const ATTRIBUTE_PATTERN = /([a-z]+)="([^"]*)"/g;
const INVENTED = '00000000-0000-4000-8000-000000000000';

interface FakeBlock {
  tag: string;
  id: string;
  attributes: Record<string, string>;
}

function blocksOf(prompt: string): FakeBlock[] {
  return [...prompt.matchAll(BLOCK_PATTERN)].map((match) => {
    const attributes = Object.fromEntries(
      [...(match[2] ?? '').matchAll(ATTRIBUTE_PATTERN)].map((a) => [a[1] ?? '', a[2] ?? '']),
    );
    return { tag: match[1] ?? '', id: attributes.id ?? '', attributes };
  });
}

/**
 * The deterministic answer for a prompt's task (computed from the blocks alone):
 * - relationships (BIB-42): one `related_to` between the requested pair, citing both;
 * - summary (BIB-43): a focus, a tentative finding citing the first two nodes, a key passage per
 *   Scripture node, an established finding per node marked established, one next direction;
 * - tensions (BIB-44): `qualifies` between the first two observation/conclusion/thought nodes;
 * - questions (BIB-44): every open question id, plus one proposed question;
 * - passages (BIB-45): "Romans 8:16" and "Hezekiah 1:1" (which no corpus resolves).
 * `invented` adds an id that is in no manifest.
 */
function fakeAnswer(prompt: string, invented: boolean): unknown {
  const pair = PAIR_PATTERN.exec(prompt);
  const nodes = blocksOf(prompt).filter((block) => block.tag === 'node');
  if (pair) {
    return {
      proposals: [
        {
          sourceNodeId: pair[1],
          targetNodeId: pair[2],
          type: 'related_to',
          rationale: 'These two items may address a shared theme.',
          evidence: [{ id: invented ? INVENTED : pair[1] }, { id: pair[2] }],
        },
      ],
    };
  }
  const task = TASK_PATTERN.exec(prompt)?.[1] ?? 'summary';
  const cite = (ids: string[]) => [
    ...ids.map((id) => ({ id })),
    ...(invented ? [{ id: INVENTED }] : []),
  ];
  switch (task) {
    case 'tensions': {
      const claims = nodes.filter((node) =>
        ['observation', 'conclusion', 'thought'].includes(node.attributes.type ?? ''),
      );
      const [first, second] = claims;
      return {
        tensions:
          first && second
            ? [
                {
                  firstNodeId: first.id,
                  secondNodeId: second.id,
                  type: 'qualifies',
                  explanation: 'These two statements may pull in different directions.',
                  caveat: 'This is one possible reading; the two may be compatible.',
                  evidence: cite([first.id, second.id]),
                },
              ]
            : [],
      };
    }
    case 'questions':
      return {
        existingOpenQuestionIds: nodes
          .filter(
            (node) => node.attributes.type === 'question' && node.attributes.status === 'open',
          )
          .map((node) => node.id),
        proposedQuestions: [
          {
            text: 'What does the surrounding passage add to this question?',
            rationale: 'The study has not recorded the surrounding context yet.',
            evidence: cite(nodes.slice(0, 1).map((node) => node.id)),
          },
        ],
      };
    case 'passages':
      return {
        passages: [
          { reference: 'Romans 8:16', reason: 'This passage may speak about inner witness.' },
          { reference: 'Hezekiah 1:1', reason: 'This reference may not exist.' },
        ],
      };
    default: {
      const scripture = nodes.filter((node) => node.attributes.type === 'scripture');
      const established = nodes.filter((node) => node.attributes.established === 'true');
      const firstTwo = nodes.slice(0, 2).map((node) => node.id);
      return {
        focus: `A study of ${nodes.length} items`,
        keyPassages: scripture.map((node) => ({
          text: 'A passage this study returns to.',
          attribution: 'user_statement',
          evidence: [{ id: node.id }],
        })),
        textualObservations: [],
        establishedFindings: established.map((node) => ({
          text: 'A finding you marked as established.',
          attribution: 'user_statement',
          evidence: [{ id: node.id }],
        })),
        tentativeFindings:
          firstTwo.length > 0
            ? [
                {
                  text: 'These items may be connected.',
                  attribution: 'ai_synthesis',
                  evidence: cite(firstTwo),
                },
              ]
            : [],
        tensions: [],
        abandonedHypotheses: [],
        nextDirections: [
          {
            text: 'Consider reading the surrounding chapter.',
            attribution: 'ai_synthesis',
            evidence: [],
          },
        ],
        proposedQuestions: [],
      };
    }
  }
}

/**
 * A deterministic, in-process provider for development and tests (PRD section 38: AI tests never
 * need a real provider or key). Its answer is computed from the prompt alone (`fakeAnswer`), so
 * the same context always gives the same output.
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
    const output =
      behaviour === 'invalid-json'
        ? 'not json'
        : JSON.stringify(fakeAnswer(request.prompt, behaviour === 'invented-id'));
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
