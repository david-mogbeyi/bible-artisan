import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { RequireAuth } from './require-auth';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const CORRELATION = '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replace.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/studies/42?tab=graph');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const content = (me: { email: string }) => <p>Private content for {me.email}</p>;

describe('RequireAuth', () => {
  it('shows a status while checking, then renders the signed-in content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ME));
    renderWithQuery(<RequireAuth>{content}</RequireAuth>);
    expect(screen.getByRole('status').textContent).toContain('Checking your session…');
    expect(await screen.findByText('Private content for reader@example.test')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects to sign-in with the current route as next on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue',
        retryable: false,
        correlationId: CORRELATION,
      }),
    );
    renderWithQuery(<RequireAuth>{content}</RequireAuth>);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/sign-in?next=%2Fstudies%2F42%3Ftab%3Dgraph'),
    );
    expect(screen.queryByText(/Private content/)).toBeNull();
  });

  it('offers Retry on other errors without redirecting', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(503, {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'x',
          retryable: true,
          correlationId: CORRELATION,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'x',
          retryable: true,
          correlationId: CORRELATION,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, ME));
    renderWithQuery(<RequireAuth>{content}</RequireAuth>);
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain(
      "We couldn't check your session.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Private content for reader@example.test')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
