import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as exportsModule from '@/lib/exports';
import { downloadExport } from '@/lib/exports';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { AccountDataSettings } from './account-data-settings';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/exports', async (original) => ({
  ...(await original<typeof exportsModule>()),
  downloadExport: vi.fn(),
}));

/** A request body the app sent, parsed (the app always sends JSON strings). */
const sentBody = (init: unknown): unknown =>
  JSON.parse(
    typeof (init as RequestInit).body === 'string' ? ((init as RequestInit).body as string) : '',
  );

const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};
const CHALLENGE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const EXPORT = {
  id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  kind: 'account',
  studyId: null,
  format: 'json',
  status: 'ready',
  fileName: 'bible-artisan-account-2026-11-15.json',
  byteSize: 10,
  createdAt: '2026-11-15T00:00:00.000Z',
  expiresAt: '2026-11-16T00:00:00.000Z',
  downloadUrl: '/v1/exports/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/download?expires=1&signature=x',
  downloadUrlExpiresAt: '2026-11-15T00:15:00.000Z',
};

let deleteResponses: Response[];
let exportResponses: Response[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replace.mockReset();
  vi.mocked(downloadExport).mockReset();
  deleteResponses = [];
  exportResponses = [];
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input.endsWith('/me') && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse(200, ME));
    }
    if (input.endsWith('/auth/otp/start')) {
      return Promise.resolve(
        jsonResponse(202, {
          challengeId: CHALLENGE,
          expiresAt: '2026-11-15T00:10:00.000Z',
          resendAvailableAt: '2026-11-15T00:01:00.000Z',
        }),
      );
    }
    if (input.endsWith('/me') && init?.method === 'DELETE') {
      const next = deleteResponses.shift();
      if (!next) throw new Error('unexpected delete');
      return Promise.resolve(next);
    }
    if (input.endsWith('/me/exports')) {
      return Promise.resolve(exportResponses.shift() ?? jsonResponse(201, EXPORT));
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const callsTo = (suffix: string, method: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).endsWith(suffix) &&
      ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );

describe('Account data settings (BIB-48)', () => {
  it('deletes the account with a fresh code, then clears every cached and local copy and goes to sign-in', async () => {
    deleteResponses.push(
      jsonResponse(422, {
        code: 'OTP_INVALID',
        message: 'The code is not correct',
        retryable: false,
        correlationId: 'c',
      }),
      jsonResponse(202, {
        deletionRequestedAt: '2026-11-15T00:00:00.000Z',
        purgeBy: '2026-11-22T00:00:00.000Z',
      }),
    );
    window.localStorage.setItem('draft', 'private');
    const { queryClient } = renderWithQuery(<AccountDataSettings me={ME} />);
    const clear = vi.spyOn(queryClient, 'clear');

    fireEvent.click(await screen.findByRole('button', { name: 'Email me a confirmation code' }));
    expect(await screen.findByText('We sent a 6-digit code to reader@example.test.')).toBeTruthy();
    const [, startInit] = callsTo('/auth/otp/start', 'POST')[0] as [string, RequestInit];
    expect(sentBody(startInit)).toStrictEqual({ email: 'reader@example.test' });

    const input = screen.getByLabelText('Confirmation code');
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete my account' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code is not correct. Check the latest email and try again.',
    );
    expect(replace).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete my account' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('draft')).toBeNull();
    const deletes = callsTo('/me', 'DELETE');
    expect(deletes.map(([, init]) => sentBody(init))).toStrictEqual([
      { challengeId: CHALLENGE, code: '000000' },
      { challengeId: CHALLENGE, code: '123456' },
    ]);
  });

  it('exports the whole account and starts the download from the signed link', async () => {
    renderWithQuery(<AccountDataSettings me={ME} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Export as JSON (complete, versioned)' }),
    );
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(EXPORT));
    const [, init] = callsTo('/me/exports', 'POST')[0] as [string, RequestInit];
    expect(sentBody(init)).toStrictEqual({ format: 'json' });
    expect(
      await screen.findByText('Your export is ready. The download should start now.'),
    ).toBeTruthy();
  });

  it('sends a new Idempotency-Key for every export click and the same key when retrying one', async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const keyOf = (call: unknown[]): unknown =>
      ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];
    exportResponses = [
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        retryable: true,
        correlationId: ME.id,
      }),
    ];
    renderWithQuery(<AccountDataSettings me={ME} />);
    const json = await screen.findByRole('button', {
      name: 'Export as JSON (complete, versioned)',
    });

    fireEvent.click(json);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(1));
    fireEvent.click(json);
    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(2));

    const keys = callsTo('/me/exports', 'POST').map(keyOf);
    expect(keys).toStrictEqual([
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
    ]);
    // The retry resent the failed click's key; the second click has its own.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
