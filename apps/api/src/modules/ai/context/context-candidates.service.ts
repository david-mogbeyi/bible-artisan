import { Injectable } from '@nestjs/common';
import type { NodeSummary } from '@bible-artisan/contracts';
import { ReferenceService } from '../../bible-content/reference/reference.service';
import { EdgesService } from '../../graph/edges.service';
import { type NodeContextContent, NodesService } from '../../graph/nodes.service';
import { NotesService } from '../../notes/notes.service';
import { StudyAccessService } from '../../study/study-access.service';
import { ThreadReadService } from '../../thread/thread-read.service';
import type { RelationshipPair } from '../capabilities/relationships.capability';
import { block, CONTEXT_CAPS, type ContextCandidate } from './assemble-context';

/** Adjacent edges in a relationships context (BIB-42). */
export const RELATIONSHIP_EDGE_CAP = 20;

export interface PairContextCandidates extends StudyContextCandidates {
  /** Manifest id → the stored texts sent for it, for exact-quote checks. */
  quotable: Map<string, string[]>;
  pair: RelationshipPair | null;
}

export interface StudyContextCandidates {
  contentRevision: number;
  candidates: ContextCandidate[];
  /** Excluded by a per-kind cap before the budget is applied. */
  capped: ContextCandidate[];
}

/**
 * What the study-wide capabilities (summary, tensions, questions, passages; BIB-43..45) need
 * besides the blocks: the items behind them, to type evidence references, check eligibility and
 * check quotes. Private text: never logged.
 */
export interface StudyContext extends StudyContextCandidates {
  studyId: string;
  title: string;
  mainQuestionNodeId: string | null;
  originalQuestionNodeId: string | null;
  startingReferenceId: string | null;
  nodes: NodeSummary[];
  notes: { id: string; revision: number; preview: string }[];
  events: { id: string; sequence: string }[];
  /** Scripture reference id → its edition and label. */
  references: Map<string, { editionId: string; label: string }>;
}

/**
 * Gathers one study's context candidates for the AI, owner-scoped, through the owning modules'
 * exported read services (Study, Graph, Notes, Thread) rather than their tables. Order is the
 * priority order of PRD section 25: objective and questions, established conclusions, then other
 * conclusions, open questions, other nodes, notes, recent events.
 *
 * Scripture appears as its reference label only: passage text is added by the capabilities that
 * quote it (BIB-43), from the corpus, never from event copies.
 */
@Injectable()
export class ContextCandidatesService {
  constructor(
    private readonly access: StudyAccessService,
    private readonly nodes: NodesService,
    private readonly notes: NotesService,
    private readonly thread: ThreadReadService,
    private readonly edges: EdgesService,
    private readonly references: ReferenceService,
  ) {}

  /**
   * The relationships context (BIB-42; PRD section 16: "both texts, selected phrases, branch
   * question, adjacent accepted edges"): the study, the two nodes with their full stored text
   * (Scripture as corpus text), the main question, and up to `RELATIONSHIP_EDGE_CAP` live edges
   * touching either node (ids and types only). Owner-scoped through the Graph read services.
   * `pair` is null when either node is no longer a live node of this study.
   */
  async gatherPair(
    ownerId: string,
    studyId: string,
    sourceNodeId: string,
    targetNodeId: string,
    scriptureChars: number,
  ): Promise<PairContextCandidates> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const mainId = study.mainQuestionNodeId;
    const wanted = [sourceNodeId, targetNodeId, ...(mainId ? [mainId] : [])];
    const content = await this.nodes.contextContent(ownerId, studyId, wanted, scriptureChars);
    const source = content.get(sourceNodeId);
    const target = content.get(targetNodeId);
    const quotable = new Map<string, string[]>();
    const candidates: ContextCandidate[] = [
      {
        kind: 'study',
        id: study.id,
        version: String(study.contentRevision),
        priority: 'required',
        block: block(
          'study',
          { id: study.id, source: 'user statement' },
          { title: study.title, description: study.description },
        ),
      },
    ];
    if (!source || !target) {
      return {
        contentRevision: study.contentRevision,
        candidates,
        capped: [],
        quotable,
        pair: null,
      };
    }
    const nodeCandidate = (node: NodeContextContent, role: string): ContextCandidate => {
      quotable.set(
        node.id,
        Object.values(node.text).filter((value): value is string => typeof value === 'string'),
      );
      return {
        kind: 'node',
        id: node.id,
        version: String(node.revision),
        priority: 'required',
        block: block(
          'node',
          {
            id: node.id,
            role,
            type: node.type,
            status: node.status,
            established: node.established,
            source:
              node.type === 'scripture'
                ? 'scripture text'
                : node.type === 'source'
                  ? 'external source'
                  : 'user statement',
          },
          node.text,
        ),
      };
    };
    candidates.push(nodeCandidate(source, 'first'), nodeCandidate(target, 'second'));
    const main = mainId ? content.get(mainId) : undefined;
    if (main && main.id !== source.id && main.id !== target.id) {
      candidates.push(nodeCandidate(main, 'main question'));
    }
    const adjacent = await this.edges.adjacentEdges(
      ownerId,
      studyId,
      [source.id, target.id],
      RELATIONSHIP_EDGE_CAP + 1,
    );
    const capped: ContextCandidate[] = [];
    adjacent.forEach((edge, index) => {
      const candidate: ContextCandidate = {
        kind: 'edge',
        id: edge.id,
        version: null,
        priority: 'optional',
        block: block(
          'edge',
          {
            id: edge.id,
            type: edge.type,
            from: edge.sourceNodeId,
            to: edge.targetNodeId,
            source: 'user graph',
          },
          {},
        ),
      };
      (index < RELATIONSHIP_EDGE_CAP ? candidates : capped).push(candidate);
    });
    return {
      contentRevision: study.contentRevision,
      candidates,
      capped,
      quotable,
      pair: {
        sourceNodeId: source.id,
        targetNodeId: target.id,
        types: new Map([
          [source.id, source.type],
          [target.id, target.type],
        ]),
        revisions: new Map([
          [source.id, source.revision],
          [target.id, target.revision],
        ]),
      },
    };
  }

  async gather(ownerId: string, studyId: string): Promise<StudyContext> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const nodes = await this.nodes.liveSummaries(ownerId, studyId);
    const notes = (await this.notes.list(ownerId, studyId, { state: 'active' })).items;
    const events = await this.thread.recentEvents(ownerId, studyId, CONTEXT_CAPS.events);

    const questionIds = new Set(
      [study.mainQuestionNodeId, study.originalQuestionNodeId].filter(
        (id): id is string => id !== null,
      ),
    );
    const isRequired = (node: NodeSummary) =>
      questionIds.has(node.id) || (node.type === 'conclusion' && node.established);
    const rank = (node: NodeSummary): number => {
      if (isRequired(node)) return 0;
      if (node.type === 'conclusion') return 1;
      if (node.type === 'question' && node.status === 'open') return 2;
      return 3;
    };
    // Stable: equal ranks keep the oldest-first order liveSummaries returns.
    const ranked = [...nodes].sort((a, b) => rank(a) - rank(b));

    const candidates: ContextCandidate[] = [
      {
        kind: 'study',
        id: study.id,
        version: String(study.contentRevision),
        priority: 'required',
        block: block(
          'study',
          { id: study.id, source: 'user statement' },
          { title: study.title, description: study.description },
        ),
      },
    ];
    const capped: ContextCandidate[] = [];

    let optionalNodes = 0;
    let openQuestions = 0;
    for (const node of ranked) {
      const required = isRequired(node);
      const candidate: ContextCandidate = {
        kind: 'node',
        id: node.id,
        version: String(node.revision),
        priority: required ? 'required' : 'optional',
        block: block(
          'node',
          {
            id: node.id,
            type: node.type,
            status: node.status,
            established: node.established,
            main: node.id === study.mainQuestionNodeId ? true : null,
            source: node.type === 'scripture' ? 'scripture reference' : 'user statement',
          },
          { text: node.label },
        ),
      };
      if (required) {
        candidates.push(candidate);
        continue;
      }
      const isOpenQuestion = node.type === 'question' && node.status === 'open';
      const overCap =
        optionalNodes >= CONTEXT_CAPS.nodes ||
        (isOpenQuestion && openQuestions >= CONTEXT_CAPS.openQuestions);
      if (overCap) {
        capped.push(candidate);
        continue;
      }
      optionalNodes += 1;
      if (isOpenQuestion) openQuestions += 1;
      candidates.push(candidate);
    }

    notes.forEach((note, index) => {
      const candidate: ContextCandidate = {
        kind: 'note',
        id: note.id,
        version: String(note.revision),
        priority: 'optional',
        block: block(
          'note',
          { id: note.id, source: 'user statement', excerpt: true },
          { text: note.preview },
        ),
      };
      (index < CONTEXT_CAPS.notes ? candidates : capped).push(candidate);
    });

    events.slice(0, CONTEXT_CAPS.events).forEach((event) => {
      candidates.push({
        kind: 'event',
        id: event.id,
        version: event.sequence,
        priority: 'optional',
        block: block(
          'event',
          {
            id: event.id,
            sequence: event.sequence,
            type: event.eventType,
            at: event.occurredAt.toISOString(),
            source: 'navigation event',
          },
          {},
        ),
      });
    });

    const stored = await this.references.storedReferences(
      [study.startingReferenceId, ...nodes.map((node) => node.referenceId)].filter(
        (id): id is string => id !== null,
      ),
    );
    return {
      contentRevision: study.contentRevision,
      candidates,
      capped,
      studyId: study.id,
      title: study.title,
      mainQuestionNodeId: study.mainQuestionNodeId,
      originalQuestionNodeId: study.originalQuestionNodeId,
      startingReferenceId: study.startingReferenceId,
      nodes,
      notes: notes.map((note) => ({ id: note.id, revision: note.revision, preview: note.preview })),
      events: events.map((event) => ({ id: event.id, sequence: event.sequence })),
      references: new Map(
        [...stored.values()].map((ref) => [ref.id, { editionId: ref.editionId, label: ref.label }]),
      ),
    };
  }
}
