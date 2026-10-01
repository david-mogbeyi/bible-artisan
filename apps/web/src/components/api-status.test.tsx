import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { ApiStatus } from './api-status';

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string) => {
    if (!input.endsWith('/health')) throw new Error(`unexpected fetch ${input}`);
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function statusText(): Promise<string> {
  const status = screen.getByRole('status');
  await vi.waitFor(() => expect(status.textContent).not.toBe('Checking API…'));
  return status.textContent ?? '';
}

describe('ApiStatus', () => {
  it('shows the API and database as up when ready', async () => {
    respondWith(
      jsonResponse(200, { status: 'ok', database: 'up', migrations: 'current', corpus: 'ready' }),
    );
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe('API ok · database up');
  });

  it('shows a down database from the 503 readiness body, not "unreachable"', async () => {
    respondWith(
      jsonResponse(503, {
        status: 'unavailable',
        database: 'down',
        migrations: 'unknown',
        corpus: 'unknown',
      }),
    );
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe(
      'API unavailable · database down · migrations unknown · Bible corpus unknown',
    );
  });

  it('shows pending migrations from the 503 readiness body', async () => {
    respondWith(
      jsonResponse(503, {
        status: 'unavailable',
        database: 'up',
        migrations: 'pending',
        corpus: 'unknown',
      }),
    );
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe(
      'API unavailable · database up · migrations pending · Bible corpus unknown',
    );
  });

  it('shows a missing Bible corpus from the 503 readiness body', async () => {
    respondWith(
      jsonResponse(503, {
        status: 'unavailable',
        database: 'up',
        migrations: 'current',
        corpus: 'missing',
      }),
    );
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe('API unavailable · database up · Bible corpus missing');
  });

  it('shows unreachable on a network error', async () => {
    respondWith(new TypeError('Failed to fetch'));
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe('API unreachable');
  });

  it('shows unreachable on a 503 that is not a readiness report (e.g. an error envelope)', async () => {
    respondWith(
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
        retryable: true,
        correlationId: '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42',
      }),
    );
    renderWithQuery(<ApiStatus />);
    expect(await statusText()).toBe('API unreachable');
  });
});
