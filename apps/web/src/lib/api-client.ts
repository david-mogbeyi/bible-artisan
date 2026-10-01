import type { z } from 'zod';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    /** From the `Retry-After` header on 429/503 responses, when present. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`API request failed with ${status}`);
    this.name = 'ApiError';
  }

  /** The shared error envelope's `code`, when the body is an envelope. */
  get code(): string | undefined {
    const body = this.body as { code?: unknown } | null | undefined;
    return typeof body?.code === 'string' ? body.code : undefined;
  }
}

/**
 * Typed fetch against /v1. Sends the session cookie and validates the response with the shared
 * contract schema, so a drifted API fails loudly instead of rendering bad data.
 */
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ApiError(
      res.status,
      body,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return schema.parse(body);
}
