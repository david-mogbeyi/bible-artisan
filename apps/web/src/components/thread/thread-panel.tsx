'use client';

import type {
  StudyEventItem,
  StudyResponse,
  ThreadFilter,
  ThreadOrder,
} from '@bible-artisan/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { bibleHref } from '@/lib/bible';
import {
  fetchThreadPage,
  groupThreadCards,
  type ThreadCard,
  type ThreadListing,
  threadQueryKey,
} from '@/lib/thread';

const LOAD_COPY: ProblemCopy = {
  notFound: "This study's thread isn't available.",
  refused: "Couldn't load the thread.",
  unavailable: "Couldn't load the thread.",
};

const FILTER_LABELS: Record<ThreadFilter, string> = {
  all: 'Everything',
  questions: 'Questions',
  conclusions: 'Conclusions',
  navigation: 'Navigation',
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The Study Thread (BIB-32; PRD sections 11, 13): what happened in the study, newest first by
 * default, 50 records a page. One action's records (same correlation id) read as one card that
 * expands to its raw records; an old event's "Open passage" opens the reader with that event as
 * the origin, so the visit is appended as a new event and the old one never moves. Internal-only
 * records are hidden unless asked for. Copy says only what was recorded.
 */
export function ThreadPanel({ study }: { study: StudyResponse }) {
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [order, setOrder] = useState<ThreadOrder>('desc');
  const [includeInternal, setIncludeInternal] = useState(false);
  const listing: ThreadListing = { filter, order, includeInternal, branchId: null };
  const ids = { filter: useId(), order: useId(), heading: useId() };

  const thread = useInfiniteQuery({
    queryKey: threadQueryKey(study.id, listing),
    queryFn: ({ pageParam }) => fetchThreadPage(study.id, listing, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });

  const items = useMemo(
    () => thread.data?.pages.flatMap((page) => page.items) ?? [],
    [thread.data],
  );
  const cards = useMemo(() => groupThreadCards(items), [items]);

  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-4">
      <h2 id={ids.heading} className="font-serif text-2xl">
        Study thread
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.filter} className="text-sm font-medium">
            Show
          </label>
          <select
            id={ids.filter}
            value={filter}
            onChange={(event) => setFilter(event.target.value as ThreadFilter)}
            className="rounded border border-muted bg-canvas px-2 py-1"
          >
            {(Object.keys(FILTER_LABELS) as ThreadFilter[]).map((value) => (
              <option key={value} value={value}>
                {FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.order} className="text-sm font-medium">
            Order
          </label>
          <select
            id={ids.order}
            value={order}
            onChange={(event) => setOrder(event.target.value as ThreadOrder)}
            className="rounded border border-muted bg-canvas px-2 py-1"
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInternal}
            onChange={(event) => setIncludeInternal(event.target.checked)}
          />
          Include internal records
        </label>
      </div>

      {thread.isError ? (
        <ProblemAlert error={thread.error} copy={LOAD_COPY} onRetry={() => void thread.refetch()} />
      ) : null}
      {thread.isPending ? (
        <p role="status" className="text-muted">
          Loading the thread…
        </p>
      ) : null}
      {thread.isSuccess && cards.length === 0 ? (
        <p className="text-muted">
          Nothing recorded here yet. What you do in this study is captured automatically.
        </p>
      ) : null}
      {cards.length > 0 ? (
        <ol aria-label="Thread events" className="flex flex-col gap-3">
          {cards.map((card) => (
            <li key={card.key}>
              <ThreadCardView card={card} study={study} />
            </li>
          ))}
        </ol>
      ) : null}
      {thread.hasNextPage ? (
        <button
          type="button"
          onClick={() => void thread.fetchNextPage()}
          disabled={thread.isFetchingNextPage}
          className="self-start rounded border border-muted px-3 py-1"
        >
          {thread.isFetchingNextPage ? 'Loading more…' : 'Load more events'}
        </button>
      ) : null}
    </section>
  );
}

function ThreadCardView({ card, study }: { card: ThreadCard; study: StudyResponse }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { primary, events } = card;
  const target = primary.targetRef;
  return (
    <article className="flex flex-col gap-2 rounded border border-muted p-3">
      <p className="break-words">{primary.displayText}</p>
      <p className="flex flex-wrap gap-x-3 text-sm text-muted">
        <time dateTime={primary.occurredAt}>{timeFormat.format(new Date(primary.occurredAt))}</time>
        {primary.delayedSync ? <span>Synced later</span> : null}
        {primary.visibility === 'internal' ? <span>Internal record</span> : null}
        {primary.actorKind === 'ai' ? <span>AI suggested</span> : null}
        {target?.deleted ? <span>No longer in the graph</span> : null}
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        {target?.kind === 'node' && !target.deleted ? (
          <Link
            href={`/studies/${encodeURIComponent(study.id)}?node=${encodeURIComponent(target.id)}`}
            className="text-accent underline"
          >
            Show in study
          </Link>
        ) : null}
        {target?.kind === 'reference' && study.lifecycle === 'active' ? (
          <Link href={bibleHref(target.id, study.id, primary.id)} className="text-accent underline">
            Open passage
          </Link>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
          className="text-accent underline"
        >
          {open
            ? 'Hide details'
            : `Show details (${events.length} ${events.length === 1 ? 'record' : 'records'})`}
        </button>
      </div>
      {open ? (
        <ul id={detailsId} aria-label="Raw records" className="flex flex-col gap-1 text-sm">
          {events.map((event) => (
            <li key={event.id}>
              <RawRecord event={event} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function RawRecord({ event }: { event: StudyEventItem }) {
  return (
    <span>
      #{event.sequence} · {event.type} · {event.displayText} · recorded{' '}
      <time dateTime={event.recordedAt}>{timeFormat.format(new Date(event.recordedAt))}</time>
    </span>
  );
}
