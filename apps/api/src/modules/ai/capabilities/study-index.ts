import type { NodeSummary, SummaryEvidenceRef } from '@bible-artisan/contracts';
import type { ManifestEntry } from '../../../database/models/context-manifest.model';
import type { AssembledContext } from '../context/assemble-context';
import type { StudyContext } from '../context/context-candidates.service';
import { claimsCertainty, quoteMatches } from './output-validation';

/**
 * The study items one study-wide AI job actually sent (BIB-43..45): only what is in the job's
 * owner-scoped manifest, so an id the model cites from anywhere else fails `assertInManifest`
 * (FR-AI-006) and every evidence reference is typed from stored data, never from model text.
 */
export interface StudyIndex {
  manifestIds: Set<string>;
  kinds: Map<string, ManifestEntry['kind']>;
  nodes: Map<string, NodeSummary>;
  notes: Map<string, { revision: number; preview: string }>;
  events: Map<string, { sequence: string }>;
  references: StudyContext['references'];
  /** Id → the stored texts sent for it (what a quote must copy exactly). */
  quotable: Map<string, string[]>;
}

export function studyIndex(gathered: StudyContext, context: AssembledContext): StudyIndex {
  const kinds = new Map(context.entries.map((entry) => [entry.id, entry.kind]));
  const nodes = new Map(
    gathered.nodes.filter((node) => kinds.get(node.id) === 'node').map((node) => [node.id, node]),
  );
  const notes = new Map(
    gathered.notes
      .filter((note) => kinds.get(note.id) === 'note')
      .map((note) => [note.id, { revision: note.revision, preview: note.preview }]),
  );
  const events = new Map(
    gathered.events
      .filter((event) => kinds.get(event.id) === 'event')
      .map((event) => [event.id, { sequence: event.sequence }]),
  );
  const quotable = new Map<string, string[]>();
  for (const node of nodes.values()) quotable.set(node.id, [node.label]);
  for (const [id, note] of notes) quotable.set(id, [note.preview]);
  return {
    manifestIds: new Set(kinds.keys()),
    kinds,
    nodes,
    notes,
    events,
    references: gathered.references,
    quotable,
  };
}

export interface ModelEvidence {
  id: string;
  quote?: string | undefined;
}

/** Lower-cased evidence with quotes as stored-or-null. */
export function normalizeEvidence(evidence: readonly ModelEvidence[]) {
  return evidence.map((item) => ({ id: item.id.toLowerCase(), quote: item.quote ?? null }));
}

/**
 * Evidence a user may see: study content only (a node or a note; for summaries also an event),
 * and every quote an exact substring of the cited item's stored text. Item-level: a failure drops
 * the item, never the whole output (FR-AI-005).
 */
export function evidenceAcceptable(
  evidence: readonly { id: string; quote: string | null }[],
  index: StudyIndex,
  allowEvents = false,
): boolean {
  return evidence.every((item) => {
    const kind = index.kinds.get(item.id);
    const allowed = kind === 'node' || kind === 'note' || (allowEvents && kind === 'event');
    if (!allowed) return false;
    return item.quote === null || quoteMatches(item.quote, index.quotable.get(item.id));
  });
}

/** Unsupported certainty in any of these texts (outside quotation marks). */
export function anyCertainty(...texts: readonly string[]): boolean {
  return texts.some((text) => claimsCertainty(text));
}

/** A typed section 17 evidence reference from stored data (never from model text). */
export function evidenceRef(
  item: { id: string; quote: string | null },
  index: StudyIndex,
): SummaryEvidenceRef | null {
  const node = index.nodes.get(item.id);
  if (node) {
    if (node.type === 'scripture') {
      const reference = node.referenceId ? index.references.get(node.referenceId) : undefined;
      return {
        type: 'scripture',
        nodeId: node.id,
        referenceId: node.referenceId,
        editionId: reference?.editionId ?? null,
        label: reference?.label ?? node.label,
        quote: item.quote,
      };
    }
    return {
      type: node.type === 'source' ? 'source' : 'node_version',
      nodeId: node.id,
      revision: node.revision,
      quote: item.quote,
    };
  }
  const note = index.notes.get(item.id);
  if (note)
    return { type: 'note_version', noteId: item.id, revision: note.revision, quote: item.quote };
  const event = index.events.get(item.id);
  if (event) return { type: 'event', eventId: item.id, sequence: event.sequence };
  return null;
}

/** The node revisions some evidence rests on, keyed by node id (proposal expiry, BIB-44). */
export function nodeRevisions(
  evidence: readonly { id: string }[],
  index: StudyIndex,
): Record<string, number> {
  const revisions: Record<string, number> = {};
  for (const item of evidence) {
    const node = index.nodes.get(item.id);
    if (node) revisions[node.id] = node.revision;
  }
  return revisions;
}
