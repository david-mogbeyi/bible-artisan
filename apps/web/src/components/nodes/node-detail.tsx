'use client';

import {
  EXCERPT_KIND_NAMES,
  httpUrlSchema,
  MAX_NODE_TEXT_LENGTH,
  NODE_ORIGIN_NAMES,
  NODE_STATUS_NAMES,
  NODE_TYPE_NAMES,
  NODE_UNCHANGED,
  type NodeResponse,
  type NodeSummary,
  OBSERVATION_KIND_NAMES,
  OBSERVATION_KINDS,
  type ObservationKind,
  type Source,
  SOURCE_KIND_NAMES,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  type UpdateNodeRequest,
  updateNodeRequestSchema,
} from '@bible-artisan/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { invalidateGraph } from '@/lib/graph';
import { ApiError } from '@/lib/api-client';
import { bibleHref, fetchTranslations, TRANSLATIONS_QUERY_KEY } from '@/lib/bible';
import { fetchNode, formatNodeTime, nodeQueryKey, nodesQueryKey, updateNode } from '@/lib/nodes';
import { invalidateLibrary } from '@/lib/studies';
import {
  type FieldErrors,
  fieldErrorsOf,
  type SourceDraft,
  sourceDraftOf,
  SourceFields,
  sourceInputOf,
  TextAreaField,
} from './node-fields';
import { Branches } from './branches';
import { Relationships } from './relationships';

export const NODE_DETAIL_COPY = {
  conflict: 'This node changed somewhere else, so your edit was not saved.',
  unknown: "Couldn't confirm the edit was saved. Retry won't save it twice.",
  unchanged: 'No changes to save.',
  failed: "Couldn't save the edit.",
  reloadConfirm: 'Replace your draft with the version saved elsewhere?',
} as const;

const LOAD_COPY: ProblemCopy = {
  notFound: "This node isn't available.",
  refused: "Couldn't load this node.",
  unavailable: "Couldn't load this node.",
};

type EditableNode = Extract<NodeResponse, { type: 'observation' | 'thought' | 'source' }>;

interface Draft {
  text: string;
  observationKind: ObservationKind;
  source: SourceDraft | null;
}

function draftOf(node: EditableNode): Draft {
  return {
    text: node.type === 'source' ? '' : node.text,
    observationKind: node.type === 'observation' ? node.observationKind : 'textual_observation',
    source: node.type === 'source' ? sourceDraftOf(node.source) : null,
  };
}

const isEditable = (node: NodeResponse): node is EditableNode =>
  node.type === 'observation' || node.type === 'thought' || node.type === 'source';

/**
 * One node's detail (BIB-25): type, origin and status or kind as separate text fields, the full
 * content with its whitespace, and the times. A Scripture node links to the reader in this study
 * (the reader shows the verse text; this panel never does). Observations, thoughts and sources of
 * an active study can be edited; "Saved" is announced only after the server's 200. A deliberate
 * duplicate Scripture node (BIB-26) says "Duplicate of <passage>" with "Show the original".
 * Its Relationships (BIB-27) list, connect, edit and remove this node's typed relationships, and
 * its Branches (BIB-60) add it to or remove it from branches, or start one at it.
 * It reports an open edit with unsaved changes (`onUnsavedChange`), so the section keeps it open
 * when the canvas selection moves away (BIB-28).
 */
export function NodeDetail({
  studyId,
  nodeId,
  editable,
  focusOnLoad,
  onFocused,
  onSaved,
  onLocked,
  labelOf,
  onShowNode,
  nodes,
  studyRevision,
  onUnsavedChange,
}: {
  studyId: string;
  nodeId: string;
  editable: boolean;
  focusOnLoad: boolean;
  onFocused: () => void;
  onSaved: () => void;
  onLocked: () => void;
  /** Another listed node's label, for "Duplicate of …". */
  labelOf: (nodeId: string) => string | null;
  /** Selects another node and focuses its heading. */
  onShowNode: (nodeId: string) => void;
  /** The study's live nodes, for the Relationships labels and the Connect dialog (BIB-27, BIB-29). */
  nodes: NodeSummary[];
  /** The study's current revision: connecting is a study change. */
  studyRevision: number;
  /** Told whether an open edit holds changes not yet saved (a changed draft or a save pending). */
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const node = useQuery({
    queryKey: nodeQueryKey(studyId, nodeId),
    queryFn: () => fetchNode(studyId, nodeId),
  });

  useEffect(() => {
    if (!focusOnLoad || !node.data) return;
    heading.current?.focus();
    onFocused();
  }, [focusOnLoad, node.data, onFocused]);

  if (node.isError) {
    return <ProblemAlert error={node.error} copy={LOAD_COPY} onRetry={() => void node.refetch()} />;
  }
  if (!node.data) {
    return (
      <p role="status" className="text-muted">
        Loading the node…
      </p>
    );
  }
  const data = node.data;
  const state =
    data.type === 'question' || data.type === 'conclusion'
      ? { label: 'Status', value: NODE_STATUS_NAMES[data.status] }
      : data.type === 'observation'
        ? { label: 'Kind', value: OBSERVATION_KIND_NAMES[data.observationKind] }
        : null;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded border border-muted p-4"
    >
      <h3 id={headingId} ref={heading} tabIndex={-1} className="font-serif text-xl">
        {NODE_TYPE_NAMES[data.type]}
      </h3>
      {data.canonicalNodeId ? (
        <DuplicateOf
          canonicalNodeId={data.canonicalNodeId}
          label={labelOf(data.canonicalNodeId)}
          onShow={onShowNode}
        />
      ) : null}
      <dl className="flex flex-col gap-2">
        <Row label="Type">{NODE_TYPE_NAMES[data.type]}</Row>
        <Row label="Origin">{NODE_ORIGIN_NAMES[data.origin]}</Row>
        {state ? <Row label={state.label}>{state.value}</Row> : null}
        <Content node={data} studyId={studyId} />
        <Row label="Created">{formatNodeTime(data.createdAt)}</Row>
        <Row label="Updated">{formatNodeTime(data.updatedAt)}</Row>
      </dl>
      {editable && isEditable(data) ? (
        <EditNode
          key={data.id}
          studyId={studyId}
          node={data}
          onSaved={onSaved}
          onLocked={onLocked}
          refetch={() => node.refetch()}
          onUnsavedChange={onUnsavedChange}
        />
      ) : null}
      <Relationships
        studyId={studyId}
        node={data}
        nodes={nodes}
        studyRevision={studyRevision}
        editable={editable}
        onLocked={onLocked}
        onShowNode={onShowNode}
      />
      <Branches
        studyId={studyId}
        node={data}
        studyRevision={studyRevision}
        editable={editable}
        onLocked={onLocked}
      />
    </section>
  );
}

/** A duplicate's link back to its canonical node, in text (WCAG 1.4.1: never color alone). */
function DuplicateOf({
  canonicalNodeId,
  label,
  onShow,
}: {
  canonicalNodeId: string;
  label: string | null;
  onShow: (nodeId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p>
        <span className="rounded border border-ink px-1">Duplicate</span> of{' '}
        {label ?? 'another node in this study'}
      </p>
      <button
        type="button"
        onClick={() => onShow(canonicalNodeId)}
        className="rounded border border-accent px-3 py-1 text-accent"
      >
        Show the original
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function Content({ node, studyId }: { node: NodeResponse; studyId: string }) {
  switch (node.type) {
    case 'scripture':
      return <ScriptureContent reference={node.reference} studyId={studyId} />;
    case 'question':
    case 'conclusion':
      return <Row label="Statement">{node.text}</Row>;
    case 'observation':
    case 'thought':
      return <Row label="Text">{node.text}</Row>;
    case 'source':
      return <SourceContent source={node.source} />;
  }
}

function ScriptureContent({
  reference,
  studyId,
}: {
  reference: Extract<NodeResponse, { type: 'scripture' }>['reference'];
  studyId: string;
}) {
  const translations = useQuery({ queryKey: TRANSLATIONS_QUERY_KEY, queryFn: fetchTranslations });
  if (!reference) {
    return <Row label="Passage">This passage&apos;s translation is no longer available.</Row>;
  }
  const edition = translations.data?.translations.find((t) => t.id === reference.editionId);
  return (
    <>
      <Row label="Passage">{reference.label}</Row>
      {edition ? <Row label="Translation">{edition.name}</Row> : null}
      <div>
        <Link href={bibleHref(reference.id, studyId)} className="text-accent underline">
          Open in reader <span className="sr-only">{reference.label}</span>
        </Link>
      </div>
    </>
  );
}

/** A citation's URL as a link only when it is a safe http(s) URL; otherwise plain text. */
function SourceUrl({ url }: { url: string }) {
  if (!httpUrlSchema.safeParse(url).success) return <>{url}</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-accent underline"
    >
      {url} <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function SourceContent({ source }: { source: Source }) {
  return (
    <>
      <Row label="Title">{source.title}</Row>
      <Row label="Kind">{SOURCE_KIND_NAMES[source.kind]}</Row>
      {source.author ? <Row label="Author">{source.author}</Row> : null}
      {source.workTitle ? <Row label="Work title">{source.workTitle}</Row> : null}
      {source.publicationDetails ? (
        <Row label="Publication details">{source.publicationDetails}</Row>
      ) : null}
      {source.url ? (
        <Row label="URL">
          <SourceUrl url={source.url} />
        </Row>
      ) : null}
      {source.locator ? <Row label="Locator">{source.locator}</Row> : null}
      {source.excerpt && source.excerptKind ? (
        <Row label={`${EXCERPT_KIND_NAMES[source.excerptKind]} (External Source)`}>
          {source.excerpt}
        </Row>
      ) : null}
    </>
  );
}

function EditNode({
  studyId,
  node,
  onSaved,
  onLocked,
  refetch,
  onUnsavedChange,
}: {
  studyId: string;
  node: EditableNode;
  onSaved: () => void;
  onLocked: () => void;
  refetch: () => Promise<unknown>;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const kindId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(node));
  const [base, setBase] = useState(node);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{
    text: string;
    retry?: boolean;
    reload?: boolean;
  } | null>(null);
  const frozen = useRef<{ json: string; key: string; body: UpdateNodeRequest } | null>(null);
  const returnFocus = useRef(false);

  const unsaved = editing && (pending || JSON.stringify(draft) !== JSON.stringify(draftOf(base)));
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [editing]);

  function open() {
    setDraft(draftOf(node));
    setBase(node);
    setErrors({});
    setProblem(null);
    setEditing(true);
  }

  function close() {
    returnFocus.current = true;
    setEditing(false);
  }

  function requestOf(): UpdateNodeRequest | null {
    const expectedRevision = base.revision;
    const body: UpdateNodeRequest =
      base.type === 'source'
        ? { expectedRevision, source: sourceInputOf(draft.source ?? sourceDraftOf(base.source)) }
        : base.type === 'observation'
          ? { expectedRevision, text: draft.text, observationKind: draft.observationKind }
          : { expectedRevision, text: draft.text };
    const parsed = updateNodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrorsOf(parsed.error.issues));
      return null;
    }
    setErrors({});
    return body;
  }

  async function save(retry = false) {
    if (pending) return;
    let attempt = frozen.current;
    if (!retry || attempt === null) {
      const body = requestOf();
      if (!body) return;
      const json = JSON.stringify(body);
      attempt = attempt?.json === json ? attempt : { json, key: crypto.randomUUID(), body };
      frozen.current = attempt;
    }
    setPending(true);
    setProblem(null);
    try {
      await updateNode(studyId, node.id, attempt.body, attempt.key);
      frozen.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodeQueryKey(studyId, node.id) }),
        queryClient.invalidateQueries({ queryKey: nodesQueryKey(studyId) }),
        invalidateGraph(queryClient, studyId),
        // An edit is study activity: the library's "recent" order moves, as after a create.
        invalidateLibrary(queryClient),
      ]);
      close();
      onSaved();
    } catch (error) {
      const definite = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (definite) frozen.current = null;
      const code = error instanceof ApiError ? error.code : undefined;
      if (!definite) setProblem({ text: NODE_DETAIL_COPY.unknown, retry: true });
      else if (error.status === 409) {
        setProblem({ text: NODE_DETAIL_COPY.conflict, reload: true });
      } else if (code === NODE_UNCHANGED) setProblem({ text: NODE_DETAIL_COPY.unchanged });
      else if (code === STUDY_ARCHIVED || code === STUDY_TRASHED) {
        // The section turns read-only and says why; this form closes with it.
        onLocked();
      } else setProblem({ text: NODE_DETAIL_COPY.failed });
    } finally {
      setPending(false);
    }
  }

  /** After a 409: replace the draft with the saved version, only once the user confirms. */
  async function reloadNode() {
    if (!window.confirm(NODE_DETAIL_COPY.reloadConfirm)) return;
    const fresh = await refetch();
    const latest = (fresh as { data?: NodeResponse }).data;
    if (latest && isEditable(latest)) {
      setBase(latest);
      setDraft(draftOf(latest));
      setProblem(null);
    }
  }

  if (!editing) {
    return (
      <div>
        <button
          type="button"
          ref={editButton}
          onClick={open}
          className="rounded border border-accent px-3 py-1 text-accent"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      aria-label={`Edit ${NODE_TYPE_NAMES[node.type].toLowerCase()}`}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {base.type === 'observation' ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Kind</legend>
          <div className="flex flex-wrap gap-4">
            {OBSERVATION_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${kindId}-kind`}
                  value={kind}
                  checked={draft.observationKind === kind}
                  onChange={() => setDraft({ ...draft, observationKind: kind })}
                />
                {OBSERVATION_KIND_NAMES[kind]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {base.type === 'source' && draft.source ? (
        <SourceFields
          value={draft.source}
          onChange={(source) => setDraft({ ...draft, source })}
          errors={errors}
        />
      ) : (
        <TextAreaField
          label="Text"
          value={draft.text}
          onChange={(text) => setDraft({ ...draft, text })}
          max={MAX_NODE_TEXT_LENGTH}
          error={errors.text}
        />
      )}
      {problem ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{problem.text}</p>
          {problem.retry ? (
            <button type="button" onClick={() => void save(true)} className="underline">
              Retry
            </button>
          ) : null}
          {problem.reload ? (
            <button type="button" onClick={() => void reloadNode()} className="underline">
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          aria-disabled={pending ? true : undefined}
          onClick={(event) => {
            if (pending) event.preventDefault();
          }}
          className="rounded border border-accent bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={close} className="rounded border border-muted px-3 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}
