import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '@/test/render';
import { useEndSessionOnLeave } from './study-session';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';

function Probe({ active }: { active: boolean }) {
  useEndSessionOnLeave(STUDY_ID, active);
  return null;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(jsonResponse(200, { sessionId: null, lastEventSequence: null })),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('useEndSessionOnLeave (BIB-33)', () => {
  it('ends this tab’s session when the page goes, with a keepalive JSON POST', () => {
    render(<Probe active />);
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/v1/studies/${STUDY_ID}/sessions/end`);
    expect({
      method: init.method,
      keepalive: init.keepalive,
      credentials: init.credentials,
      body: init.body,
      contentType: (init.headers as Record<string, string>)['content-type'],
    }).toStrictEqual({
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      body: '{}',
      contentType: 'application/json',
    });
  });

  it('ends it when the app navigates outside the study, not to the study’s own reader', async () => {
    window.history.replaceState(null, '', `/studies/${STUDY_ID}`);
    const toReader = render(<Probe active />);
    window.history.pushState(null, '', `/bible?study=${STUDY_ID}`);
    toReader.unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();

    const toHome = render(<Probe active />);
    window.history.pushState(null, '', '/');
    toHome.unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a study that is not active', () => {
    render(<Probe active={false} />);
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
