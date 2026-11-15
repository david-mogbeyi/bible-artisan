import { Injectable } from '@nestjs/common';
import {
  acceptAiSuggestionRequestSchema,
  type AcceptAiSuggestionResponse,
  AI_SUGGESTION_EXPIRED,
  AI_SUGGESTION_NOT_PROPOSED,
  type AiSuggestion as AiSuggestionDto,
  type AiSuggestionListResponse,
  listAiSuggestionsQuerySchema,
  rejectAiSuggestionRequestSchema,
  type RejectAiSuggestionResponse,
  type RelationshipsJobOutput,
} from '@bible-artisan/contracts';
import { fn, literal, Op, type Transaction } from 'sequelize';
import {
  AiRuleError,
  NotFoundError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { AiSuggestion } from '../../database/models/ai-suggestion.model';
import type { StudyEdge } from '../../database/models/study-edge.model';
import { connectNodes, EdgesService } from '../graph/edges.service';
import { NodesService } from '../graph/nodes.service';
import { StudyAccessService } from '../study/study-access.service';
import {
  proposalSignature,
  type RelationshipPair,
  type ValidProposal,
} from './capabilities/relationships.capability';

/** Thread events for a decision on an AI suggestion (ids and enums only). */
export const AI_SUGGESTION_EVENTS = {
  accepted: 'ai_suggestion_accepted',
  rejected: 'ai_suggestion_rejected',
} as const;

interface StoreScope {
  jobId: string;
  ownerId: string;
  studyId: string;
  basisRevision: number;
  modelId: string;
  promptVersion: string;
}

/**
 * AI relationship suggestions (BIB-42; PRD sections 12, 16, 23 AISuggestion, 24). Suggestions
 * live outside the canonical graph: only the user's explicit accept turns one into an edge, and
 * AI code never changes a node's status or a conclusion.
 *
 * - `storeProposals` (the worker, inside its publishing transaction): replaces the pair's open
 *   suggestions with the new validated proposals, suppressing any that already exist as a live
 *   edge or whose signature the user rejected (unless they asked to regenerate).
 * - `accept` / `reject`: study mutations (`MutationService.execute`: Idempotency-Key receipt,
 *   study lock, lifecycle guard, one event in the same transaction). `expectedRevision` is the
 *   suggestion's. Accepting an already accepted suggestion replays its edge without writing, so
 *   retries make exactly one edge and one acceptance event (FR-AI-003).
 */
@Injectable()
export class AiSuggestionsService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly nodes: NodesService,
    private readonly edges: EdgesService,
  ) {}

  async storeProposals(
    transaction: Transaction,
    scope: StoreScope,
    input: {
      proposals: ValidProposal[];
      dropped: number;
      pair: RelationshipPair;
      regenerate: boolean;
    },
  ): Promise<RelationshipsJobOutput> {
    const { ownerId, studyId } = scope;
    const { pair } = input;
    const between = {
      [Op.or]: [
        { sourceNodeId: pair.sourceNodeId, targetNodeId: pair.targetNodeId },
        { sourceNodeId: pair.targetNodeId, targetNodeId: pair.sourceNodeId },
      ],
    };
    // A newer request replaces the pair's open proposals.
    await AiSuggestion.update(
      { status: 'expired', revision: literal('revision + 1') },
      { where: { ownerId, studyId, status: 'proposed', ...between }, transaction },
    );
    const rejected = input.regenerate
      ? new Set<string>()
      : new Set(
          (
            await AiSuggestion.findAll({
              where: { ownerId, studyId, status: 'rejected', ...between },
              attributes: ['signature'],
              transaction,
            })
          ).map((row) => row.signature),
        );
    const existingEdges = await this.edges.liveEdgeKeys(ownerId, studyId, [
      pair.sourceNodeId,
      pair.targetNodeId,
    ]);
    const suggestionIds: string[] = [];
    let suppressedCount = 0;
    for (const proposal of input.proposals) {
      const signature = proposalSignature(proposal, pair.revisions);
      const edgeKey = `${proposal.sourceNodeId}:${proposal.targetNodeId}:${proposal.type}`;
      if (rejected.has(signature) || existingEdges.has(edgeKey)) {
        suppressedCount += 1;
        continue;
      }
      const row = await AiSuggestion.create(
        {
          ownerId,
          studyId,
          jobId: scope.jobId,
          capability: 'relationships',
          sourceNodeId: proposal.sourceNodeId,
          targetNodeId: proposal.targetNodeId,
          edgeType: proposal.type,
          proposalJson: { rationale: proposal.rationale, evidence: proposal.evidence },
          signature,
          basisContentRevision: scope.basisRevision,
          dependencyVersions: Object.fromEntries(pair.revisions),
          modelId: scope.modelId,
          promptVersion: scope.promptVersion,
        },
        { transaction },
      );
      suggestionIds.push(row.id);
    }
    return { suggestionIds, suppressedCount, droppedCount: input.dropped };
  }

  /**
   * `GET /studies/:id/ai/suggestions?nodeId=`: the open suggestions touching that live node,
   * oldest first. One whose node changed or was removed since is shown as `expired`.
   */
  async list(ownerId: string, studyId: string, query: unknown): Promise<AiSuggestionListResponse> {
    const { nodeId } = parseBody(listAiSuggestionsQuerySchema, query);
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId.toLowerCase());
    const rows = await AiSuggestion.findAll({
      where: {
        ownerId,
        studyId: node.studyId,
        status: 'proposed',
        [Op.or]: [{ sourceNodeId: node.id }, { targetNodeId: node.id }],
      },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const revisions = await this.nodes.liveRevisions(
      ownerId,
      node.studyId,
      rows.flatMap((row) => [row.sourceNodeId, row.targetNodeId]),
    );
    return { items: rows.map((row) => toDto(row, isCurrent(row, revisions))) };
  }

  /**
   * `POST /studies/:id/ai/suggestions/:suggestionId/accept`. Order: 404, an accepted suggestion
   * replays its edge (200 `existing`, no write), 422 not open, 409 stale revision, 422 expired,
   * then the edge rules of `connectNodes` (a question-only type into a non-question, the edge
   * cap). Creates the edge with `origin: 'ai'`, the suggestion and the owner as adopter; if the
   * same live edge already exists it is linked instead (no second edge). One
   * `ai_suggestion_accepted` event (plus `node_connected` when an edge is created).
   */
  accept(
    ownerId: string,
    studyId: string,
    suggestionId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(acceptAiSuggestionRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const suggestion = await this.find(m, suggestionId);
        if (suggestion.status === 'accepted' && suggestion.acceptedEdgeId) {
          const edge = await this.edges.findEdge(m.ownerId, m.studyId, suggestion.acceptedEdgeId);
          if (!edge) throw new Error('AiSuggestions: an accepted suggestion lost its edge');
          m.unchanged();
          return { status: 200, body: acceptBody(suggestion, edge, 'existing', null) };
        }
        if (suggestion.status !== 'proposed') {
          throw new AiRuleError(AI_SUGGESTION_NOT_PROPOSED);
        }
        if (suggestion.revision !== expectedRevision) {
          throw new RevisionConflictError(suggestion.revision);
        }
        const revisions = await this.nodes.liveRevisions(m.ownerId, m.studyId, [
          suggestion.sourceNodeId,
          suggestion.targetNodeId,
        ]);
        if (!isCurrent(suggestion, revisions)) throw new AiRuleError(AI_SUGGESTION_EXPIRED);

        const type = body.type ?? suggestion.edgeType;
        const connected = await connectNodes(m, {
          sourceNodeId: suggestion.sourceNodeId,
          targetNodeId: suggestion.targetNodeId,
          type,
          note: body.note ?? null,
          fromSuggestion: { suggestionId: suggestion.id, acceptedBy: m.ownerId },
        });
        const accepted = await m.updateWithExpectedRevision(AiSuggestion, {
          id: suggestion.id,
          expectedRevision,
          values: {
            status: 'accepted',
            decidedAt: fn('now'),
            decidedBy: m.ownerId,
            acceptedEdgeId: connected.edge.id,
          },
        });
        const event = await m.appendEvent({
          eventType: AI_SUGGESTION_EVENTS.accepted,
          payload: {
            suggestionId: suggestion.id,
            edgeId: connected.edge.id,
            sourceNodeId: connected.edge.sourceNodeId,
            targetNodeId: connected.edge.targetNodeId,
            edgeType: connected.edge.type,
            proposedEdgeType: suggestion.edgeType,
            edited: type !== suggestion.edgeType || (body.note ?? null) !== null,
            outcome: connected.outcome,
          },
          nodeId: connected.edge.targetNodeId,
          fromNodeId: connected.edge.sourceNodeId,
        });
        return {
          status: 200,
          body: acceptBody(accepted, connected.edge, connected.outcome, event.sequence),
        };
      },
    });
  }

  /**
   * `POST /studies/:id/ai/suggestions/:suggestionId/reject`. Order: 404, 422 when not open
   * (already decided or replaced), 409 stale revision. The signature then
   * suppresses the same proposal until a node changes or the user regenerates (FR-AI-004).
   */
  reject(
    ownerId: string,
    studyId: string,
    suggestionId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(rejectAiSuggestionRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const suggestion = await this.find(m, suggestionId);
        if (suggestion.status !== 'proposed') {
          throw new AiRuleError(AI_SUGGESTION_NOT_PROPOSED);
        }
        if (suggestion.revision !== expectedRevision) {
          throw new RevisionConflictError(suggestion.revision);
        }
        const rejected = await m.updateWithExpectedRevision(AiSuggestion, {
          id: suggestion.id,
          expectedRevision,
          values: {
            status: 'rejected',
            decidedAt: fn('now'),
            decidedBy: m.ownerId,
          },
        });
        const event = await m.appendEvent({
          eventType: AI_SUGGESTION_EVENTS.rejected,
          payload: {
            suggestionId: suggestion.id,
            sourceNodeId: suggestion.sourceNodeId,
            targetNodeId: suggestion.targetNodeId,
            edgeType: suggestion.edgeType,
          },
          nodeId: suggestion.targetNodeId,
          fromNodeId: suggestion.sourceNodeId,
        });
        const response: RejectAiSuggestionResponse = {
          suggestionId: rejected.id,
          status: 'rejected',
          revision: rejected.revision,
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }

  /** The suggestion, owner- and study-scoped from the lock: absent and another user's are 404. */
  private async find(m: StudyMutation, suggestionId: string): Promise<AiSuggestion> {
    if (!isResourceId(suggestionId)) throw new NotFoundError();
    const suggestion = await AiSuggestion.findOne({
      where: { id: suggestionId, studyId: m.studyId, ownerId: m.ownerId },
    });
    if (!suggestion) throw new NotFoundError();
    return suggestion;
  }
}

/** Both endpoints still live, at the revisions the proposal was made against. */
function isCurrent(row: AiSuggestion, revisions: ReadonlyMap<string, number>): boolean {
  return [row.sourceNodeId, row.targetNodeId].every(
    (id) => revisions.get(id) !== undefined && revisions.get(id) === row.dependencyVersions[id],
  );
}

function toDto(row: AiSuggestion, current: boolean): AiSuggestionDto {
  return {
    id: row.id,
    studyId: row.studyId,
    capability: 'relationships',
    status: row.status === 'proposed' && !current ? 'expired' : row.status,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    type: row.edgeType,
    rationale: row.proposalJson.rationale,
    evidence: row.proposalJson.evidence.map((e) => ({ id: e.id, quote: e.quote })),
    revision: row.revision,
    basisRevision: row.basisContentRevision,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    acceptedEdgeId: row.acceptedEdgeId,
  };
}

/** The accept response: ids and enums only (it is stored on the Idempotency-Key receipt). */
function acceptBody(
  suggestion: AiSuggestion,
  edge: StudyEdge,
  outcome: 'created' | 'existing',
  lastEventSequence: string | null,
): AcceptAiSuggestionResponse {
  return {
    suggestionId: suggestion.id,
    status: 'accepted',
    revision: suggestion.revision,
    outcome,
    edge: {
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type: edge.type,
      origin: edge.origin,
      suggestionId: edge.suggestionId,
      revision: edge.revision,
    },
    lastEventSequence,
  };
}
