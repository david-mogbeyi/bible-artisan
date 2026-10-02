import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type queries, render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { GraphViewProvider } from '@/lib/graph-store';

/**
 * Renders with a fresh, non-retrying TanStack Query client and a fresh canvas view store (the
 * study page provides one to its Graph and Nodes sections, BIB-28).
 */
export function renderWithQuery(ui: ReactElement): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    // As `wrapper`, so a test's own `rerender(<QueryClientProvider …>)` keeps the same tree.
    ...render<typeof queries>(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
      { wrapper: GraphViewProvider },
    ),
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An element's text with whitespace collapsed, as a user reads it (a plain-assertion helper). */
export function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
