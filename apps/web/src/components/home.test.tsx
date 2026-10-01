import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { Home } from './home';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const SIGN_OUT_ERROR = "You're still signed in. Something went wrong signing out. Try again.";

let logoutResponses: Array<Response | Error>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replace.mockReset();
  logoutResponses = [];
  fetchMock = vi.fn((input: string) => {
    if (input.endsWith('/me')) return Promise.resolve(jsonResponse(200, ME));
    if (input.endsWith('/health')) {
      return Promise.resolve(
        jsonResponse(200, {
          status: 'ok',
          database: 'up',
          migrations: 'current',
          corpus: 'ready',
        }),
      );
    }
    if (input.endsWith('/auth/logout')) {
      const next = logoutResponses.shift();
      if (!next) throw new Error('unexpected logout call');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSignedIn() {
  const rendered = renderWithQuery(<Home />);
  await screen.findByText('Signed in as reader@example.test');
  await screen.findByText('API ok · database up');
  return rendered;
}

const logoutCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/auth/logout'));

describe('Home sign-out', () => {
  it('clears cached private data and goes to sign-in once logout succeeds', async () => {
    logoutResponses.push(jsonResponse(204, null));
    const { queryClient } = await renderSignedIn();
    const clear = vi.spyOn(queryClient, 'clear');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(logoutCalls()).toHaveLength(1);
    const [, init] = logoutCalls()[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [
      'a server error',
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        retryable: true,
        correlationId: '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42',
      }),
    ],
    ['a network failure', new TypeError('Failed to fetch')],
  ])(
    'stays signed in on the page with a focused alert after %s, and can retry',
    async (_label, failure) => {
      logoutResponses.push(failure);
      const { queryClient } = await renderSignedIn();
      const clear = vi.spyOn(queryClient, 'clear');

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(SIGN_OUT_ERROR);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(replace).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(['me'])).toStrictEqual(ME);
      expect(screen.getByText('Signed in as reader@example.test')).toBeTruthy();

      // Retrying works once the API recovers.
      logoutResponses.push(jsonResponse(204, null));
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
      expect(logoutCalls()).toHaveLength(2);
    },
  );
});
