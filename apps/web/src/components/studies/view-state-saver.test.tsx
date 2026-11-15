import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphQueryKey } from '@/lib/graph';
import { useGraphViewStore } from '@/lib/graph-store';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { ViewStateSaver } from './view-state-saver';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NODE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const OPENED_ID = 'cccccccc-2222-4333-8444-555555555555';

function viewState(viewRevision: number) {
  return {
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
  };
}

function SelectButton() {
  const store = useGraphViewStore();
  return (
    <button type="button" onClick={() => store.getState().select([NODE_ID], 'list')}>
      Select
    </button>
  );
}

let replies: Response[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replies = [];
  fetchMock = vi.fn(() => {
    const next = replies.shift();
    if (!next) throw new Error('unexpected fetch');
    return Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bodies = () =>
  fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as object,
  );

describe('ViewStateSaver (BIB-34)', () => {
  it('saves nothing for the context the page opened with, then saves a selection on the view revision, resending once on a conflict', async () => {
    replies.push(
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'x',
        currentRevision: 5,
      }),
      jsonResponse(200, viewState(6)),
    );
    const { queryClient } = renderWithQuery(
      <>
        <ViewStateSaver studyId={STUDY_ID} active openedNodeId={OPENED_ID} openedBranchId={null} />
        <SelectButton />
      </>,
    );
    queryClient.setQueryData(graphQueryKey(STUDY_ID), { viewRevision: 3 });
    // Opening (nothing selected yet, then the opened node) is a restore: no save.
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(bodies()).toStrictEqual([
      { expectedRevision: 3, selectedNodeId: NODE_ID, activeBranchId: null },
      { expectedRevision: 5, selectedNodeId: NODE_ID, activeBranchId: null },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/studies/${STUDY_ID}/view-state$`));
    expect(init.method).toBe('PATCH');
    await waitFor(() =>
      expect(
        (queryClient.getQueryData(graphQueryKey(STUDY_ID)) as { viewRevision: number })
          .viewRevision,
      ).toBe(6),
    );
  });

  it('merges a selection and a viewport change into one save, sent at once with keepalive when the page goes', async () => {
    replies.push(jsonResponse(200, viewState(2)));
    function ViewportButton() {
      const store = useGraphViewStore();
      return (
        <button
          type="button"
          onClick={() => store.getState().setViewport({ x: 10, y: -20, zoom: 1.5 })}
        >
          Pan
        </button>
      );
    }
    renderWithQuery(
      <>
        <ViewStateSaver studyId={STUDY_ID} active openedNodeId={null} openedBranchId={null} />
        <SelectButton />
        <ViewportButton />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan' }));
    // Before the debounce: leaving sends what is waiting now.
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()).toStrictEqual([
      {
        expectedRevision: 1,
        selectedNodeId: NODE_ID,
        activeBranchId: null,
        viewport: { x: 10, y: -20, zoom: 1.5 },
      },
    ]);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].keepalive).toBe(true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('saves nothing for an archived study', async () => {
    renderWithQuery(
      <>
        <ViewStateSaver
          studyId={STUDY_ID}
          active={false}
          openedNodeId={null}
          openedBranchId={null}
        />
        <SelectButton />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
