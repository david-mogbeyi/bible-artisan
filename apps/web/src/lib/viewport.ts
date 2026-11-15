'use client';

import { useSyncExternalStore } from 'react';
import { MIN_EDIT_WIDTH } from './graph-view';

/**
 * Below the canvas's editing width (PRD section 11, Study Workspace: "Below 900px show Reader,
 * Notes, Thread, Summary, and Graph Preview tabs"). A CSS media query, so it follows the layout
 * viewport the way the stylesheet does, including browser zoom.
 */
export const NARROW_QUERY = `(max-width: ${MIN_EDIT_WIDTH - 0.02}px)`;

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Whether the viewport is narrower than 900 px (BIB-38). False on the server and wherever
 * `matchMedia` is unavailable, so the desktop layout is the fallback.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery()?.matches ?? false,
    () => false,
  );
}
