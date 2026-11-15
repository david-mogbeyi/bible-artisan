import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUndoStore,
  edgeKey,
  inverseOf,
  MAX_UNDO,
  nodeKey,
  useUndoRecorder,
} from '@/lib/undo';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { UNDO_COPY, UndoControls } from './undo-controls';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const OBS = 'bbbbbbbb-2222-4333-8444-555555555551';
const EDGE = 'eeeeeeee-2222-4333-8444-555555555551';
const T = '2026-10-01T12:00:00.000Z';

const nodeBody = (revision: number) => ({
  id: OBS,
  studyId: STUDY_ID,
  type: 'observation',
  origin: 'user',
  revision,
  referenceId: null,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '9',
  versionId: null,
  previousVersionId: null,
  warnings: [],
});
const deleted = (revision: number) => ({
  id: OBS,
  studyId: STUDY_ID,
  type: 'observation',
  revision,
  removedEdgeCount: 0,
  promotedCanonicalNodeId: null,
  mainQuestionCleared: false,
  establishmentClearedNodeIds: [],
  lastEventSequence: '10',
});
const restored = (revision: number) => ({
  ...nodeBody(revision),
  canonicalNodeId: null,
  restoredEdgeIds: [],
  skippedEdges: [],
  establishmentClearedNodeIds: [],
});

type Reply = Response;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown }[];
const reply = (route: string, ...answers: Reply[]) =>
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);

beforeEach(() => {
  replies = new Map();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      requests.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = replies.get(`${method} ${path}`)?.shift();
      if (next) return Promise.resolve(next);
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Records one "Add observation" (node revision 1), as the Add node form does on success. */
function RecordAdd() {
  const record = useUndoRecorder();
  useEffect(() => {
    record(
      { label: 'Add observation', action: { op: 'deleteNode', nodeId: OBS } },
      { [nodeKey(OBS)]: 1 },
    );
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const mutations = () => requests.filter((r) => r.method !== 'GET');

describe('UndoControls (BIB-63)', () => {
  it('undoes an add with a compensating delete at the acknowledged revision, announces it, and redoes it with a restore', async () => {
    reply(`DELETE /studies/${STUDY_ID}/nodes/${OBS}`, jsonResponse(200, deleted(2)));
    reply(`POST /studies/${STUDY_ID}/nodes/${OBS}/restore`, jsonResponse(200, restored(3)));
    renderWithQuery(
      <>
        <RecordAdd />
        <UndoControls studyId={STUDY_ID} editable />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Undo: Add observation' }));
    expect(await screen.findByText(UNDO_COPY.undid('Add observation'))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Redo: Add observation' }));
    expect(await screen.findByText(UNDO_COPY.redid('Add observation'))).toBeTruthy();
    expect(mutations()).toStrictEqual([
      {
        method: 'DELETE',
        path: `/studies/${STUDY_ID}/nodes/${OBS}`,
        body: { expectedRevision: 1 },
      },
      {
        method: 'POST',
        path: `/studies/${STUDY_ID}/nodes/${OBS}/restore`,
        body: { expectedRevision: 2 },
      },
    ]);
    expect(screen.getByRole('button', { name: 'Undo: Add observation' })).toBeTruthy();
  });

  it('never overwrites a change made elsewhere: a 409 drops the command and asks the user to resolve it', async () => {
    reply(
      `DELETE /studies/${STUDY_ID}/nodes/${OBS}`,
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'c',
        currentRevision: 4,
      }),
    );
    renderWithQuery(
      <>
        <RecordAdd />
        <UndoControls studyId={STUDY_ID} editable />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Undo: Add observation' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(UNDO_COPY.conflict('Add observation'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBe(
        'true',
      ),
    );
    expect(screen.getByRole('button', { name: 'Redo' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('undo store', () => {
  it('keeps the last 50 commands, clears redo on a new command, and inverts actions both ways', () => {
    const store = createUndoStore();
    for (let i = 0; i < MAX_UNDO + 5; i += 1) {
      store.getState().record(
        {
          label: `Remove relationship ${i}`,
          action: { op: 'restoreEdge', edgeId: EDGE, sourceNodeId: OBS },
        },
        { [edgeKey(EDGE)]: i + 1 },
      );
    }
    store.getState().settle('undo', { label: 'x', action: { op: 'deleteNode', nodeId: OBS } }, {});
    expect(store.getState().undo).toHaveLength(MAX_UNDO - 1);
    expect(store.getState().undo[0]?.label).toBe('Remove relationship 5');
    expect(store.getState().redo).toHaveLength(1);
    store
      .getState()
      .record(
        { label: 'Add thought', action: { op: 'deleteNode', nodeId: OBS } },
        { [nodeKey(OBS)]: 1, '*edges': null },
      );
    expect(store.getState().redo).toStrictEqual([]);
    expect(store.getState().revisions).toStrictEqual({ [nodeKey(OBS)]: 1 });
    const edit = {
      op: 'editEdge' as const,
      edgeId: EDGE,
      sourceNodeId: OBS,
      body: { type: 'supports' as const, note: null },
      inverse: { type: 'parallels' as const, note: 'n' },
    };
    expect(inverseOf(inverseOf(edit))).toStrictEqual(edit);
    expect(inverseOf({ op: 'removeEdge', edgeId: EDGE, sourceNodeId: OBS })).toStrictEqual({
      op: 'restoreEdge',
      edgeId: EDGE,
      sourceNodeId: OBS,
    });
  });
});
