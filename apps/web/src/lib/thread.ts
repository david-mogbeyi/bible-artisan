import {
  type EndSessionResponse,
  endSessionResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type RecordActivityRequest,
  type RecordActivityResponse,
  recordActivityResponseSchema,
  type StudyEventDetail,
  type StudyEventItem,
  studyEventDetailSchema,
  type ThreadEventsResponse,
  threadEventsResponseSchema,
  type ThreadFilter,
  type ThreadOrder,
} from '@bible-artisan/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';

/**
 * Study Thread data access (BIB-55, BIB-32). URLs carry opaque ids and filter names only; a
 * search query or label travels only in a request or response body.
 */

const studyPath = (studyId: string) => `/studies/${encodeURIComponent(studyId)}`;

export interface ThreadListing {
  filter: ThreadFilter;
  order: ThreadOrder;
  includeInternal: boolean;
  branchId: string | null;
}

/** Under the study's key, so refreshing a study refreshes its thread too. */
export function threadQueryKey(studyId: string, listing?: ThreadListing) {
  return listing
    ? (['studies', studyId, 'thread', listing] as const)
    : (['studies', studyId, 'thread'] as const);
}

export function invalidateThread(queryClient: QueryClient, studyId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: threadQueryKey(studyId) });
}

export function fetchThreadPage(
  studyId: string,
  listing: ThreadListing,
  cursor: string | null,
): Promise<ThreadEventsResponse> {
  const params = new URLSearchParams({
    filter: listing.filter,
    order: listing.order,
    includeInternal: String(listing.includeInternal),
  });
  if (listing.branchId) params.set('branchId', listing.branchId);
  if (cursor) params.set('cursor', cursor);
  return apiFetch(`${studyPath(studyId)}/events?${params}`, threadEventsResponseSchema);
}

export function fetchThreadEvent(studyId: string, eventId: string): Promise<StudyEventDetail> {
  return apiFetch(
    `${studyPath(studyId)}/events/${encodeURIComponent(eventId)}`,
    studyEventDetailSchema,
  );
}

/**
 * `POST /studies/:id/activity`. The client mutation id is the Idempotency-Key: a retry resends
 * the identical body, and the server records one event.
 */
export function recordActivity(
  studyId: string,
  body: RecordActivityRequest,
): Promise<RecordActivityResponse> {
  return apiFetch(`${studyPath(studyId)}/activity`, recordActivityResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: body.clientMutationId },
    body: JSON.stringify(body),
  });
}

/**
 * `POST /studies/:id/sessions/end` (BIB-33): ends this tab's open session in the study. Sent as
 * the page goes, so it uses `fetch` with `keepalive` through `apiFetch`, not `sendBeacon`: a beacon
 * cannot send the JSON content type, the tab header or the Idempotency-Key, and every /v1 mutation
 * must be JSON from an allowed Origin (the CSRF rules), which this request still is.
 */
export function endStudySession(
  studyId: string,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<EndSessionResponse> {
  return apiFetch(`${studyPath(studyId)}/sessions/end`, endSessionResponseSchema, {
    method: 'POST',
    keepalive,
    headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
    body: '{}',
  });
}

/** One card: an action's events (one correlation id), newest-or-oldest first as listed. */
export interface ThreadCard {
  key: string;
  primary: StudyEventItem;
  events: StudyEventItem[];
}

/** The event that records the user accepting an AI suggestion (FR-AI-013). */
const AI_ACCEPTED = 'ai_suggestion_accepted';

/**
 * Whether `item` names its action's card rather than `current`: an accepted AI suggestion always
 * does, so the card says the content came from an AI suggestion the user accepted (FR-AI-013,
 * AGENTS.md rule 7) instead of reading as the user's own; otherwise the earliest sequence does.
 */
function namesAction(item: StudyEventItem, current: StudyEventItem): boolean {
  const accepted = item.type === AI_ACCEPTED;
  if (accepted !== (current.type === AI_ACCEPTED)) return accepted;
  return BigInt(item.sequence) < BigInt(current.sequence);
}

/**
 * Groups adjacent events of one action (same correlation id) into one card (FR-THREAD-006). The
 * card reads as the action's first recorded event, or as its AI acceptance when the action
 * accepted an AI suggestion; every raw event stays in `events`.
 */
export function groupThreadCards(items: readonly StudyEventItem[]): ThreadCard[] {
  const cards: ThreadCard[] = [];
  for (const item of items) {
    const last = cards.at(-1);
    if (last && item.correlationId !== null && last.primary.correlationId === item.correlationId) {
      last.events.push(item);
      if (namesAction(item, last.primary)) last.primary = item;
      continue;
    }
    cards.push({ key: item.id, primary: item, events: [item] });
  }
  return cards;
}
