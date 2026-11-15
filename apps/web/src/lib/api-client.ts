import { TAB_INSTANCE_HEADER } from '@bible-artisan/contracts';
import type { z } from 'zod';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

/**
 * An absolute URL for a path the API returned (e.g. an export's `/v1/exports/…/download?…`), for
 * a top-level navigation such as a file download that `apiFetch` cannot make.
 */
export function apiHref(path: string): string {
  return new URL(path, API_URL).href;
}

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

const TAB_STORAGE_KEY = 'bible-artisan.tab-instance-id';
let memoryTabId: string | null = null;

/**
 * This browser tab's id (BIB-33): a random UUID kept in `sessionStorage`, so it survives a reload
 * of the tab but no other tab shares it. Falls back to memory when storage is unavailable. Sent
 * on every request as `X-Tab-Instance-Id`; the API groups a tab's meaningful actions into study
 * sessions with it. Never content: just an opaque id.
 */
export function tabInstanceId(): string {
  if (memoryTabId) return memoryTabId;
  try {
    const stored = window.sessionStorage.getItem(TAB_STORAGE_KEY);
    if (stored) {
      memoryTabId = stored;
      return stored;
    }
    memoryTabId = crypto.randomUUID();
    window.sessionStorage.setItem(TAB_STORAGE_KEY, memoryTabId);
  } catch {
    memoryTabId ??= crypto.randomUUID();
  }
  return memoryTabId;
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
    headers: {
      'content-type': 'application/json',
      [TAB_INSTANCE_HEADER]: tabInstanceId(),
      ...init?.headers,
    },
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
