import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_POSITION,
  graphResponseSchema,
  MAX_POSITIONS_PER_REQUEST,
  savePositionsRequestSchema,
} from './graph';

const A = '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const B = '9c0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const T = '2026-10-02T10:00:00.000Z';

function issues(result: { success: boolean; error?: { issues: unknown[] } }) {
  return result.error?.issues.map((issue) => {
    const { path, message } = issue as { path: PropertyKey[]; message: string };
    return { path, message };
  });
}

const position = (nodeId: string, x = 10, y = -20.5) => ({ nodeId, x, y });

describe('savePositionsRequestSchema', () => {
  it('accepts 1 to 100 positions and lower-cases node ids', () => {
    expect(
      savePositionsRequestSchema.parse({
        expectedRevision: 3,
        positions: [position(A.toUpperCase())],
      }),
    ).toStrictEqual({ expectedRevision: 3, positions: [{ nodeId: A, x: 10, y: -20.5 }] });
    const hundred = Array.from({ length: MAX_POSITIONS_PER_REQUEST }, (_, i) =>
      position(`${i.toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-0a1b2c3d4e5f`),
    );
    expect(
      savePositionsRequestSchema.safeParse({ expectedRevision: 1, positions: hundred }).success,
    ).toBe(true);
  });

  it('refuses no positions, more than 100, and the same node twice (in any case)', () => {
    expect(
      savePositionsRequestSchema.safeParse({ expectedRevision: 1, positions: [] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_POSITIONS_PER_REQUEST + 1 }, (_, i) =>
      position(`${i.toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-0a1b2c3d4e5f`),
    );
    expect(
      savePositionsRequestSchema.safeParse({ expectedRevision: 1, positions: many }).success,
    ).toBe(false);
    expect(
      issues(
        savePositionsRequestSchema.safeParse({
          expectedRevision: 1,
          positions: [position(A), position(B), position(A.toUpperCase(), 1, 1)],
        }),
      ),
    ).toStrictEqual([{ path: ['positions', 2, 'nodeId'], message: DUPLICATE_POSITION }]);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['1e7', 1e7],
    ['-1000000.5', -1_000_000.5],
    ['a string', '5'],
  ])('refuses a coordinate of %s', (_name, value) => {
    expect(
      savePositionsRequestSchema.safeParse({
        expectedRevision: 1,
        positions: [{ nodeId: A, x: value, y: 0 }],
      }).success,
    ).toBe(false);
    expect(
      savePositionsRequestSchema.safeParse({
        expectedRevision: 1,
        positions: [{ nodeId: A, x: 0, y: value }],
      }).success,
    ).toBe(false);
  });

  it('accepts the bounds themselves', () => {
    expect(
      savePositionsRequestSchema.safeParse({
        expectedRevision: 1,
        positions: [position(A, 1_000_000, -1_000_000)],
      }).success,
    ).toBe(true);
  });

  it('is strict: unknown keys, React Flow fields and a malformed id are refused', () => {
    for (const body of [
      { expectedRevision: 1, positions: [position(A)], viewport: { zoom: 1 } },
      { expectedRevision: 1, positions: [{ ...position(A), dragging: false }] },
      { expectedRevision: 1, positions: [{ id: A, position: { x: 1, y: 2 } }] },
      { expectedRevision: 1, positions: [position('not-a-node')] },
      { positions: [position(A)] },
    ]) {
      expect(savePositionsRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('graphResponseSchema', () => {
  const snapshot = {
    studyId: A,
    contentRevision: 4,
    viewRevision: 1,
    nodes: [
      {
        id: B,
        type: 'question',
        origin: 'user',
        label: 'What is conscience?',
        status: 'open',
        observationKind: null,
        referenceId: null,
        canonicalNodeId: null,
        revision: 1,
        createdAt: T,
        updatedAt: T,
      },
    ],
    edges: [{ id: A, sourceNodeId: A, targetNodeId: B, type: 'supports', origin: 'user' }],
    branches: [{ id: A, rootNodeId: B, memberNodeIds: [A], revision: 2, createdAt: T }],
    positions: [{ nodeId: B, x: 1.5, y: -2 }],
  };

  it('accepts a full snapshot', () => {
    expect(graphResponseSchema.parse(snapshot)).toStrictEqual(snapshot);
  });

  it('has no React Flow-only keys anywhere in its shape', () => {
    const keys = new Set<string>();
    const walk = (shape: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(shape)) {
        keys.add(key);
        const inner = value as { shape?: Record<string, unknown>; element?: { shape?: unknown } };
        if (inner.shape) walk(inner.shape);
        const element = inner.element as { shape?: Record<string, unknown> } | undefined;
        if (element?.shape) walk(element.shape);
      }
    };
    walk(graphResponseSchema.shape);
    for (const reactFlowKey of [
      'position',
      'data',
      'selected',
      'width',
      'height',
      'measured',
      'dragging',
      'source',
      'target',
      'markerEnd',
      'viewport',
    ]) {
      expect(keys.has(reactFlowKey)).toBe(false);
    }
    expect(keys.has('nodeId')).toBe(true);
    expect(keys.has('sourceNodeId')).toBe(true);
  });
});
