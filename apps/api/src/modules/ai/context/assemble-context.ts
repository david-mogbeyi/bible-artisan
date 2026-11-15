import type {
  ManifestEntry,
  ManifestOmission,
} from '../../../database/models/context-manifest.model';

/**
 * Deterministic context selection (BIB-39, PRD section 25 "Context assembly"). Pure: the same
 * candidates and budget always give the same blocks, manifest and omissions.
 *
 * - Required items (the study objective, its main and original questions, conclusions the user
 *   established) are kept first, whatever their size; if they alone exceed the budget the request
 *   fails rather than silently dropping required evidence.
 * - Optional items follow in priority order, each kind capped (30 graph nodes, 10 open questions,
 *   10 note excerpts, 20 events), and are added while they fit. Everything left out, by a cap or
 *   by the budget, is recorded as an omission with a fixed coverage warning per kind.
 * - Text is rendered as JSON strings inside labelled blocks, so study text cannot close a block or
 *   pose as an instruction (section 25: "Source text is untrusted data").
 */

export const RETRIEVAL_RULES_VERSION = 'context-v1';

export const CONTEXT_CAPS = {
  nodes: 30,
  openQuestions: 10,
  notes: 10,
  events: 20,
} as const;

export interface ContextCandidate {
  kind: ManifestEntry['kind'];
  id: string;
  version: string | null;
  priority: 'required' | 'optional';
  /** The rendered block, e.g. `<node id="…" …>{"text":"…"}</node>`. */
  block: string;
}

export interface AssembledContext {
  /** Blocks in the order they appear in the prompt. Private text: never log it. */
  blocks: string[];
  entries: ManifestEntry[];
  omissions: ManifestOmission[];
  coverageWarnings: string[];
  tokenCount: number;
}

/** Thrown when required context alone does not fit the budget. */
export class ContextBudgetExceededError extends Error {
  constructor() {
    super('Required context exceeds the token budget');
    this.name = 'ContextBudgetExceededError';
  }
}

/**
 * Selects candidates into `budget` tokens. `capped` are candidates already excluded by a per-kind
 * cap; they are reported as omissions too.
 */
export function assembleContext(
  candidates: readonly ContextCandidate[],
  capped: readonly ContextCandidate[],
  budget: number,
  estimate: (text: string) => number,
): AssembledContext {
  const sized = candidates.map((candidate) => ({ candidate, tokens: estimate(candidate.block) }));
  const required = sized.filter(({ candidate }) => candidate.priority === 'required');
  const optional = sized.filter(({ candidate }) => candidate.priority === 'optional');

  let used = required.reduce((sum, { tokens }) => sum + tokens, 0);
  if (used > budget) throw new ContextBudgetExceededError();

  const kept: typeof sized = [...required];
  const omitted: ManifestOmission[] = capped.map((candidate) => ({
    kind: candidate.kind,
    id: candidate.id,
    tokens: estimate(candidate.block),
  }));
  for (const item of optional) {
    if (used + item.tokens <= budget) {
      kept.push(item);
      used += item.tokens;
    } else {
      omitted.push({ kind: item.candidate.kind, id: item.candidate.id, tokens: item.tokens });
    }
  }
  // Prompt order follows the candidates' order, not the selection order.
  const keptIds = new Set(kept.map(({ candidate }) => `${candidate.kind}:${candidate.id}`));
  const ordered = sized.filter(({ candidate }) => keptIds.has(`${candidate.kind}:${candidate.id}`));
  return {
    blocks: ordered.map(({ candidate }) => candidate.block),
    entries: ordered.map(({ candidate, tokens }) => ({
      kind: candidate.kind,
      id: candidate.id,
      version: candidate.version,
      priority: candidate.priority,
      tokens,
    })),
    omissions: omitted,
    coverageWarnings: coverageWarnings(omitted),
    tokenCount: used,
  };
}

const KIND_NAMES: Record<ManifestEntry['kind'], [string, string]> = {
  study: ['study detail', 'study details'],
  node: ['study item', 'study items'],
  note: ['note', 'notes'],
  event: ['activity entry', 'activity entries'],
};

/** One fixed sentence per omitted kind, e.g. "3 notes were left out of this request." */
export function coverageWarnings(omissions: readonly ManifestOmission[]): string[] {
  const counts = new Map<ManifestEntry['kind'], number>();
  for (const omission of omissions) counts.set(omission.kind, (counts.get(omission.kind) ?? 0) + 1);
  return (['node', 'note', 'event', 'study'] as const)
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      const [one, many] = KIND_NAMES[kind];
      return count === 1
        ? `1 ${one} was left out of this request.`
        : `${count} ${many} were left out of this request.`;
    });
}

/** A labelled block whose attributes are fixed tokens and whose text is a JSON string. */
export function block(
  tag: ManifestEntry['kind'],
  attributes: Record<string, string | number | boolean | null>,
  text: Record<string, string | null>,
): string {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}="${String(value).replace(/[^A-Za-z0-9:._ -]/g, '')}"`)
    .join(' ');
  // `<` as \u003c (still valid JSON): study text can never open or close a block.
  const body = JSON.stringify(text).replace(/</g, '\\u003c');
  return `<${tag} ${attrs}>${body}</${tag}>`;
}
