import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiFetch } from './api-client';

const ok = z.object({ ok: z.literal(true) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('sends credentials and validates the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/x', ok)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/x$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('throws ApiError with the error envelope on non-2xx', async () => {
    const envelope = { code: 'not_found', message: 'Not found' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 404 })),
    );

    const error = await apiFetch('/x', ok).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, body: envelope });
  });
});
