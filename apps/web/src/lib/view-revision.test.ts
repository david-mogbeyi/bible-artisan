import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '@/test/render';
import { graphQueryKey, savePositions } from './graph';
import { inViewLane, noteViewRevision, patchViewState } from './view-revision';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NODE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

function viewStateReply(viewRevision: number) {
  return jsonResponse(200, {
    viewState: {
      viewRevision,
      selectedNodeId: NODE_ID,
      activeBranchId: null,
      activeQuestionNodeId: null,
      readerReferenceId: null,
      viewport: null,
      panes: null,
      contextSavedAt: '2026-10-01T12:00:00.000Z',
    },
    lastEventSequence: '9',
  });
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    path: new URL(url).pathname.replace(/^\/v1/, ''),
    body: init?.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
  }));

describe('the view-revision lane', () => {
  it('holds a view-state save until the position save ahead of it answers, then sends the revision it left (no self-inflicted 409)', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(graphQueryKey(STUDY_ID), { viewRevision: 3 });
    let answerPositions: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answerPositions = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(() => Promise.resolve(viewStateReply(5)));

    // A drag's save is in flight on revision 3 …
    const positions = inViewLane(STUDY_ID, async () => {
      const saved = await savePositions(
        STUDY_ID,
        { expectedRevision: 3, positions: [{ nodeId: NODE_ID, x: 1, y: 2 }] },
        crypto.randomUUID(),
      );
      noteViewRevision(queryClient, STUDY_ID, saved.viewRevision);
    });
    // … when a selection is saved.
    const selection = patchViewState(queryClient, STUDY_ID, { selectedNodeId: NODE_ID });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answerPositions(jsonResponse(200, { viewRevision: 4, lastEventSequence: '8' }));
    await positions;
    await selection;
    expect(sent()).toStrictEqual([
      {
        path: `/studies/${STUDY_ID}/positions`,
        body: { expectedRevision: 3, positions: [{ nodeId: NODE_ID, x: 1, y: 2 }] },
      },
      {
        path: `/studies/${STUDY_ID}/view-state`,
        body: { expectedRevision: 4, selectedNodeId: NODE_ID },
      },
    ]);
    expect(
      (queryClient.getQueryData(graphQueryKey(STUDY_ID)) as { viewRevision: number }).viewRevision,
    ).toBe(5);
  });

  it('keeps going after a failed write: the next one still runs', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(graphQueryKey(STUDY_ID), { viewRevision: 1 });
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('offline')));
    fetchMock.mockImplementationOnce(() => Promise.resolve(viewStateReply(2)));
    await expect(
      patchViewState(queryClient, STUDY_ID, { selectedNodeId: NODE_ID }),
    ).rejects.toMatchObject({ message: 'offline' });
    await patchViewState(queryClient, STUDY_ID, { selectedNodeId: NODE_ID });
    expect(sent().map((call) => call.body)).toStrictEqual([
      { expectedRevision: 1, selectedNodeId: NODE_ID },
      { expectedRevision: 1, selectedNodeId: NODE_ID },
    ]);
  });

  it('reads the saved revision first when the tab knows none, so the first save does not 409 (the reader opened on its own)', async () => {
    const queryClient = new QueryClient();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse(200, {
          studyId: STUDY_ID,
          title: 'T',
          lifecycle: 'active',
          lastActivityAt: '2026-10-01T12:00:00.000Z',
          activeQuestion: null,
          activeBranch: null,
          lastPassage: null,
          recentConclusion: null,
          openQuestions: { items: [], total: 0 },
          target: {
            kind: 'study',
            nodeId: null,
            referenceId: null,
            branchId: null,
            fallback: false,
          },
          viewState: {
            viewRevision: 22,
            selectedNodeId: null,
            activeBranchId: null,
            activeQuestionNodeId: null,
            readerReferenceId: null,
            viewport: null,
            panes: null,
            contextSavedAt: null,
          },
        }),
      ),
    );
    fetchMock.mockImplementationOnce(() => Promise.resolve(viewStateReply(23)));
    fetchMock.mockImplementationOnce(() => Promise.resolve(viewStateReply(24)));

    await patchViewState(queryClient, STUDY_ID, { selectedNodeId: NODE_ID });
    // The next save already knows the revision: no second read.
    await patchViewState(queryClient, STUDY_ID, { selectedNodeId: null });
    expect(sent()).toStrictEqual([
      { path: `/studies/${STUDY_ID}/resume`, body: undefined },
      {
        path: `/studies/${STUDY_ID}/view-state`,
        body: { expectedRevision: 22, selectedNodeId: NODE_ID },
      },
      {
        path: `/studies/${STUDY_ID}/view-state`,
        body: { expectedRevision: 23, selectedNodeId: null },
      },
    ]);
  });
});
