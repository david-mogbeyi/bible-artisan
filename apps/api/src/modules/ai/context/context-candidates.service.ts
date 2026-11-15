import { Injectable } from '@nestjs/common';
import type { NodeSummary } from '@bible-artisan/contracts';
import { NodesService } from '../../graph/nodes.service';
import { NotesService } from '../../notes/notes.service';
import { StudyAccessService } from '../../study/study-access.service';
import { ThreadReadService } from '../../thread/thread-read.service';
import { block, CONTEXT_CAPS, type ContextCandidate } from './assemble-context';

export interface StudyContextCandidates {
  contentRevision: number;
  candidates: ContextCandidate[];
  /** Excluded by a per-kind cap before the budget is applied. */
  capped: ContextCandidate[];
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
  ) {}

  async gather(ownerId: string, studyId: string): Promise<StudyContextCandidates> {
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

    return { contentRevision: study.contentRevision, candidates, capped };
  }
}
