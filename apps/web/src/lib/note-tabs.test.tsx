import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { noteQueryKey } from './notes';
import { useNoteTabs } from './note-tabs';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const NOTE_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

/** One browser tab: its own query client, with the note open. */
function Tab({ label, onAnnounce }: { label: string; onAnnounce?: (send: () => void) => void }) {
  const tabs = useNoteTabs(STUDY_ID, NOTE_ID);
  onAnnounce?.(() => tabs.announceSaved(5));
  return (
    <p role="status" aria-label={label}>
      {tabs.elsewhere ? 'open elsewhere' : 'only here'}
    </p>
  );
}

function renderTab(label: string, onAnnounce?: (send: () => void) => void) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={client}>
      <Tab label={label} {...(onAnnounce ? { onAnnounce } : {})} />
    </QueryClientProvider>,
  );
  return { invalidate, view };
}

describe('useNoteTabs (BIB-37)', () => {
  it('warns both tabs when the same note is open twice, and stops once the other closes', async () => {
    renderTab('first');
    const second = renderTab('second');
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'first' }).textContent).toBe('open elsewhere');
      expect(screen.getByRole('status', { name: 'second' }).textContent).toBe('open elsewhere');
    });
    second.view.unmount();
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'first' }).textContent).toBe('only here'),
    );
  });

  it("refetches the note in other tabs after one tab's acknowledged save, with ids only", async () => {
    let announce: () => void = () => undefined;
    const saver = renderTab('saver', (send) => (announce = send));
    const other = renderTab('other');
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'other' }).textContent).toBe('open elsewhere'),
    );
    act(() => announce());
    await waitFor(() =>
      expect(other.invalidate).toHaveBeenCalledWith({ queryKey: noteQueryKey(STUDY_ID, NOTE_ID) }),
    );
    expect(saver.invalidate).not.toHaveBeenCalled();
  });
});
