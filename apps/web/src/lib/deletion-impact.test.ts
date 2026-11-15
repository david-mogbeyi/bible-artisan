import type { GraphResponse } from '@bible-artisan/contracts';
import { describe, expect, it } from 'vitest';
import { deletionImpact } from './deletion-impact';

const T = '2026-10-01T12:00:00.000Z';
const node = (id: string, type: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    origin: 'user',
    label: id,
    status: null,
    observationKind: null,
    referenceId: null,
    canonicalNodeId: null,
    established: false,
    evidenceIncomplete: false,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }) as GraphResponse['nodes'][number];
const edge = (id: string, sourceNodeId: string, targetNodeId: string, type: string) =>
  ({ id, sourceNodeId, targetNodeId, type }) as GraphResponse['edges'][number];

describe('deletionImpact (BIB-31)', () => {
  const nodes = [
    node('x', 'observation'),
    node('y', 'thought'),
    node('c1', 'conclusion', { status: 'supported', established: true }),
    node('c2', 'conclusion', { status: 'supported' }),
    node('c3', 'conclusion', { status: 'tentative' }),
  ];

  it('counts relationships and finds conclusions that use the node as evidence, saying which are left without any', () => {
    const impact = deletionImpact(
      {
        nodes,
        edges: [
          edge('e1', 'x', 'c1', 'supports'),
          edge('e2', 'c2', 'x', 'inference_from'),
          edge('e3', 'y', 'c2', 'supports'),
          edge('e4', 'x', 'c3', 'contradicts'),
          edge('e5', 'x', 'y', 'explains'),
        ],
        branches: [],
      },
      'x',
      null,
    );
    expect(impact).toStrictEqual({
      edgeCount: 4,
      affectedConclusions: [
        { node: nodes[2], leftWithoutEvidence: true, losesEstablished: true },
        { node: nodes[3], leftWithoutEvidence: false, losesEstablished: false },
      ],
      isMainQuestion: false,
      isBranchRoot: false,
      duplicateCount: 0,
    });
  });

  it('flags the main question, a branch root and live duplicate copies', () => {
    const passage = node('p', 'scripture');
    const copy = node('d', 'scripture', { canonicalNodeId: 'p' });
    const impact = deletionImpact(
      {
        nodes: [passage, copy],
        edges: [],
        branches: [{ id: 'b', rootNodeId: 'p', memberNodeIds: [], revision: 1, createdAt: T }],
      },
      'p',
      'p',
    );
    expect(impact).toStrictEqual({
      edgeCount: 0,
      affectedConclusions: [],
      isMainQuestion: true,
      isBranchRoot: true,
      duplicateCount: 1,
    });
  });
});
