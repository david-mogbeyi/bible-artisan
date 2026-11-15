import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  acceptAiProposalRequestSchema,
  type AcceptAiProposalResponse,
  acceptAiSuggestionRequestSchema,
  type AcceptAiSuggestionResponse,
  AI_SUGGESTION_EXPIRED,
  AI_SUGGESTION_NOT_PROPOSED,
  type AiProposal,
  type AiProposalListResponse,
  type AiSuggestion as AiSuggestionDto,
  type AiSuggestionListResponse,
  listAiProposalsQuerySchema,
  listAiSuggestionsQuerySchema,
  type QuestionsJobOutput,
  rejectAiSuggestionRequestSchema,
  type RelationshipsJobOutput,
} from '@bible-artisan/contracts';
import { fn, literal, Op, type Transaction, type WhereOptions } from 'sequelize';
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
import {
  AiSuggestion,
  type AiSuggestionCapability,
} from '../../database/models/ai-suggestion.model';
import type { StudyEdge } from '../../database/models/study-edge.model';
import { connectNodes, EdgesService } from '../graph/edges.service';
import { NodesService } from '../graph/nodes.service';
import { StudyAccessService } from '../study/study-access.service';
import type {
  ValidPassageProposal,
  ValidQuestionProposal,
} from './capabilities/insights.capability';
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

const EDGE_CAPABILITIES: readonly AiSuggestionCapability[] = ['relationships', 'tensions'];
const ITEM_CAPABILITIES: readonly AiSuggestionCapability[] = ['questions', 'passages'];

/**
 * AI suggestions (BIB-42 relationships; BIB-44 tensions and open questions; BIB-45 passages; PRD
 * sections 12, 16, 23 AISuggestion, 24). Suggestions live outside the canonical graph: only the
 * user's explicit accept turns one into an edge or a node, and AI code never changes a node's
 * status or a conclusion.
 *
 * - `store*` (the worker, inside its publishing transaction): replaces the scope's open
 *   suggestions with the new validated proposals, suppressing any already in the study or whose
 *   signature the user rejected (unless they asked to regenerate).
 * - `accept` / `acceptProposal` / `reject`: study mutations (`MutationService.execute`:
 *   Idempotency-Key receipt, study lock, lifecycle guard, one event in the same transaction).
 *   `expectedRevision` is the suggestion's. Accepting an already accepted suggestion replays its
 *   edge or node without writing, so retries make exactly one (FR-AI-003).
 */
@Injectable()
export class AiSuggestionsService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly nodes: NodesService,
    private readonly edges: EdgesService,
  ) {}

  /** BIB-42: relationships between one pair of nodes. */
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
    const { pair } = input;
    return this.storeEdgeProposals(transaction, scope, {
      capability: 'relationships',
      proposals: input.proposals,
      dropped: input.dropped,
      revisions: pair.revisions,
      regenerate: input.regenerate,
      among: {
        [Op.or]: [
          { sourceNodeId: pair.sourceNodeId, targetNodeId: pair.targetNodeId },
          { sourceNodeId: pair.targetNodeId, targetNodeId: pair.sourceNodeId },
        ],
      },
    });
  }

  /** BIB-44: a study's tension proposals replace its open ones. */
  storeTensions(
    transaction: Transaction,
    scope: StoreScope,
    input: {
      proposals: (ValidProposal & { caveat: string })[];
      dropped: number;
      revisions: ReadonlyMap<string, number>;
      regenerate: boolean;
    },
  ): Promise<RelationshipsJobOutput> {
    return this.storeEdgeProposals(transaction, scope, {
      capability: 'tensions',
      ...input,
      among: {},
    });
  }

  private async storeEdgeProposals(
    transaction: Transaction,
    scope: StoreScope,
    input: {
      capability: 'relationships' | 'tensions';
      proposals: (ValidProposal & { caveat?: string })[];
      dropped: number;
      revisions: ReadonlyMap<string, number>;
      regenerate: boolean;
      among: WhereOptions;
    },
  ): Promise<RelationshipsJobOutput> {
    const { ownerId, studyId } = scope;
    const { capability } = input;
    // A newer request replaces the scope's open proposals.
    await AiSuggestion.update(
      { status: 'expired', revision: literal('revision + 1') },
      { where: { ownerId, studyId, capability, status: 'proposed', ...input.among }, transaction },
    );
    const rejected = input.regenerate
      ? new Set<string>()
      : await this.rejectedSignatures(transaction, ownerId, studyId, capability, input.among);
    const suggestionIds: string[] = [];
    let suppressedCount = 0;
    for (const proposal of input.proposals) {
      const signature = proposalSignature(proposal, input.revisions, capability);
      const existingEdges = await this.edges.liveEdgeKeys(ownerId, studyId, [
        proposal.sourceNodeId,
        proposal.targetNodeId,
      ]);
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
          capability,
          sourceNodeId: proposal.sourceNodeId,
          targetNodeId: proposal.targetNodeId,
          edgeType: proposal.type,
          proposalJson: {
            rationale: proposal.rationale,
            evidence: proposal.evidence,
            ...(proposal.caveat !== undefined ? { caveat: proposal.caveat } : {}),
          },
          signature,
          basisContentRevision: scope.basisRevision,
          dependencyVersions: {
            [proposal.sourceNodeId]: input.revisions.get(proposal.sourceNodeId) ?? 0,
            [proposal.targetNodeId]: input.revisions.get(proposal.targetNodeId) ?? 0,
          },
          modelId: scope.modelId,
          promptVersion: scope.promptVersion,
        },
        { transaction },
      );
      suggestionIds.push(row.id);
    }
    return { suggestionIds, suppressedCount, droppedCount: input.dropped };
  }

  /** BIB-44: proposed questions replace the study's open ones; existing ids are only reported. */
  async storeQuestions(
    transaction: Transaction,
    scope: StoreScope,
    input: {
      existingOpenQuestionIds: string[];
      proposals: ValidQuestionProposal[];
      dropped: number;
      regenerate: boolean;
    },
  ): Promise<QuestionsJobOutput> {
    const stored = await this.storeItems(
      transaction,
      scope,
      'questions',
      input.regenerate,
      input.proposals.map((proposal) => ({
        signature: itemSignature('questions', proposal.text.trim().toLowerCase()),
        proposalJson: {
          text: proposal.text,
          rationale: proposal.rationale,
          evidence: proposal.evidence,
        },
        dependencyVersions: proposal.dependencyVersions,
      })),
    );
    return {
      existingOpenQuestionIds: input.existingOpenQuestionIds,
      ...stored,
      droppedCount: input.dropped,
    };
  }

  /** BIB-45: verified passages replace the study's open passage proposals. */
  async storePassages(
    transaction: Transaction,
    scope: StoreScope,
    input: { proposals: ValidPassageProposal[]; dropped: number; regenerate: boolean },
  ): Promise<RelationshipsJobOutput> {
    const stored = await this.storeItems(
      transaction,
      scope,
      'passages',
      input.regenerate,
      input.proposals.map((proposal) => ({
        signature: itemSignature('passages', proposal.referenceId),
        proposalJson: {
          rationale: proposal.reason,
          evidence: [],
          reference: {
            referenceId: proposal.referenceId,
            editionId: proposal.editionId,
            label: proposal.label,
          },
        },
        dependencyVersions: {},
      })),
    );
    return { ...stored, droppedCount: input.dropped };
  }

  private async storeItems(
    transaction: Transaction,
    scope: StoreScope,
    capability: 'questions' | 'passages',
    regenerate: boolean,
    items: {
      signature: string;
      proposalJson: AiSuggestion['proposalJson'];
      dependencyVersions: Record<string, number>;
    }[],
  ): Promise<{ suggestionIds: string[]; suppressedCount: number }> {
    const { ownerId, studyId } = scope;
    await AiSuggestion.update(
      { status: 'expired', revision: literal('revision + 1') },
      { where: { ownerId, studyId, capability, status: 'proposed' }, transaction },
    );
    const rejected = regenerate
      ? new Set<string>()
      : await this.rejectedSignatures(transaction, ownerId, studyId, capability, {});
    const suggestionIds: string[] = [];
    let suppressedCount = 0;
    for (const item of items) {
      if (rejected.has(item.signature)) {
        suppressedCount += 1;
        continue;
      }
      const row = await AiSuggestion.create(
        {
          ownerId,
          studyId,
          jobId: scope.jobId,
          capability,
          sourceNodeId: null,
          targetNodeId: null,
          edgeType: null,
          proposalJson: item.proposalJson,
          signature: item.signature,
          basisContentRevision: scope.basisRevision,
          dependencyVersions: item.dependencyVersions,
          modelId: scope.modelId,
          promptVersion: scope.promptVersion,
        },
        { transaction },
      );
      suggestionIds.push(row.id);
    }
    return { suggestionIds, suppressedCount };
  }

  private async rejectedSignatures(
    transaction: Transaction,
    ownerId: string,
    studyId: string,
    capability: AiSuggestionCapability,
    among: WhereOptions,
  ): Promise<Set<string>> {
    const rows = await AiSuggestion.findAll({
      where: { ownerId, studyId, capability, status: 'rejected', ...among },
      attributes: ['signature'],
      transaction,
    });
    return new Set(rows.map((row) => row.signature));
  }

  /**
   * `GET /studies/:id/ai/suggestions?nodeId=`: the open relationship and tension suggestions
   * touching that live node, oldest first. `?capability=tensions` (BIB-44): the study's open
   * tension suggestions. One whose node changed or was removed since is shown as `expired`.
   */
  async list(ownerId: string, studyId: string, query: unknown): Promise<AiSuggestionListResponse> {
    const parsed = parseBody(listAiSuggestionsQuerySchema, query);
    let where: WhereOptions;
    let scopeStudyId: string;
    if ('nodeId' in parsed) {
      const node = await this.access.requireOwnedNode(
        ownerId,
        studyId,
        parsed.nodeId.toLowerCase(),
      );
      scopeStudyId = node.studyId;
      where = {
        capability: EDGE_CAPABILITIES,
        [Op.or]: [{ sourceNodeId: node.id }, { targetNodeId: node.id }],
      };
    } else {
      scopeStudyId = (await this.access.requireOwnedStudy(ownerId, studyId)).id;
      where = { capability: 'tensions' };
    }
    const rows = await AiSuggestion.findAll({
      where: { ownerId, studyId: scopeStudyId, status: 'proposed', ...where },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const revisions = await this.nodes.liveRevisions(
      ownerId,
      scopeStudyId,
      rows.flatMap((row) => Object.keys(row.dependencyVersions)),
    );
    return { items: rows.map((row) => toDto(row, isCurrent(row, revisions))) };
  }

  /** `GET /studies/:id/ai/proposals?capability=` (BIB-44/45): open question or passage proposals. */
  async listProposals(
    ownerId: string,
    studyId: string,
    query: unknown,
  ): Promise<AiProposalListResponse> {
    const { capability } = parseBody(listAiProposalsQuerySchema, query);
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const rows = await AiSuggestion.findAll({
      where: { ownerId, studyId: study.id, capability, status: 'proposed' },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const revisions = await this.nodes.liveRevisions(
      ownerId,
      study.id,
      rows.flatMap((row) => Object.keys(row.dependencyVersions)),
    );
    return { items: rows.map((row) => toProposalDto(row, isCurrent(row, revisions))) };
  }

  /**
   * `POST /studies/:id/ai/suggestions/:suggestionId/accept` (relationships and tensions). Order:
   * 404, an accepted suggestion replays its edge (200 `existing`, no write), 422 not open, 409
   * stale revision, 422 expired, then the edge rules of `connectNodes`. Creates the edge with
   * `origin: 'ai'`, the suggestion and the owner as adopter; if the same live edge already exists
   * it is linked instead. One `ai_suggestion_accepted` event (plus `node_connected` when an edge is
   * created). Accepting a tension never changes either claim's status (BIB-44).
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
        const suggestion = await this.find(m, suggestionId, EDGE_CAPABILITIES);
        const sourceNodeId = required(suggestion.sourceNodeId);
        const targetNodeId = required(suggestion.targetNodeId);
        const proposedType = required(suggestion.edgeType);
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
        const revisions = await this.nodes.liveRevisions(
          m.ownerId,
          m.studyId,
          Object.keys(suggestion.dependencyVersions),
        );
        if (!isCurrent(suggestion, revisions)) throw new AiRuleError(AI_SUGGESTION_EXPIRED);

        const type = body.type ?? proposedType;
        const connected = await connectNodes(m, {
          sourceNodeId,
          targetNodeId,
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
            ...(suggestion.capability === 'tensions' ? { capability: 'tensions' } : {}),
            edgeId: connected.edge.id,
            sourceNodeId: connected.edge.sourceNodeId,
            targetNodeId: connected.edge.targetNodeId,
            edgeType: connected.edge.type,
            proposedEdgeType: proposedType,
            edited: type !== proposedType || (body.note ?? null) !== null,
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
   * `POST /studies/:id/ai/proposals/:proposalId/accept` (BIB-44 questions, BIB-45 passages). Same
   * order as `accept`. A question proposal (optionally edited) becomes an open Question node with
   * an AI origin; a passage becomes the study's Scripture node for that verified reference, or
   * focuses the one it already has. One `ai_suggestion_accepted` event (plus the node's created
   * event when a node is created). Never changes any existing node's status.
   */
  acceptProposal(
    ownerId: string,
    studyId: string,
    proposalId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(acceptAiProposalRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const proposal = await this.find(m, proposalId, ITEM_CAPABILITIES);
        const nodeType = proposal.capability === 'questions' ? 'question' : 'scripture';
        if (proposal.status === 'accepted' && proposal.acceptedNodeId) {
          m.unchanged();
          const replay: AcceptAiProposalResponse = {
            proposalId: proposal.id,
            status: 'accepted',
            revision: proposal.revision,
            outcome: 'existing',
            node: { id: proposal.acceptedNodeId, type: nodeType },
            lastEventSequence: null,
          };
          return { status: 200, body: replay };
        }
        if (proposal.status !== 'proposed') throw new AiRuleError(AI_SUGGESTION_NOT_PROPOSED);
        if (proposal.revision !== expectedRevision) {
          throw new RevisionConflictError(proposal.revision);
        }
        const revisions = await this.nodes.liveRevisions(
          m.ownerId,
          m.studyId,
          Object.keys(proposal.dependencyVersions),
        );
        if (!isCurrent(proposal, revisions)) throw new AiRuleError(AI_SUGGESTION_EXPIRED);

        const text = body.text ?? proposal.proposalJson.text ?? '';
        const added =
          proposal.capability === 'questions'
            ? await this.nodes.addFromAiProposal(m, { type: 'question', text })
            : await this.nodes.addFromAiProposal(m, {
                type: 'scripture',
                referenceId: required(proposal.proposalJson.reference?.referenceId ?? null),
              });
        const accepted = await m.updateWithExpectedRevision(AiSuggestion, {
          id: proposal.id,
          expectedRevision,
          values: {
            status: 'accepted',
            decidedAt: fn('now'),
            decidedBy: m.ownerId,
            acceptedNodeId: added.nodeId,
          },
        });
        const event = await m.appendEvent({
          eventType: AI_SUGGESTION_EVENTS.accepted,
          payload: {
            suggestionId: proposal.id,
            capability: proposal.capability,
            nodeId: added.nodeId,
            outcome: added.outcome,
            edited: body.text !== undefined && body.text !== proposal.proposalJson.text,
          },
          nodeId: added.nodeId,
        });
        const response: AcceptAiProposalResponse = {
          proposalId: accepted.id,
          status: 'accepted',
          revision: accepted.revision,
          outcome: added.outcome,
          node: { id: added.nodeId, type: nodeType },
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }

  /**
   * `POST /studies/:id/ai/suggestions/:id/reject` and `…/ai/proposals/:id/reject`. Order: 404 (a
   * proposal through the suggestions route and vice versa is 404), 422 when not open (already
   * decided or replaced), 409 stale revision. The signature then suppresses the same proposal
   * until what it rests on changes or the user regenerates (FR-AI-004).
   */
  reject(
    ownerId: string,
    studyId: string,
    suggestionId: string,
    mutation: MutationRequestInfo,
    family: 'suggestions' | 'proposals' = 'suggestions',
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(rejectAiSuggestionRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const suggestion = await this.find(
          m,
          suggestionId,
          family === 'suggestions' ? EDGE_CAPABILITIES : ITEM_CAPABILITIES,
        );
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
            ...(suggestion.capability !== 'relationships'
              ? { capability: suggestion.capability }
              : {}),
            sourceNodeId: suggestion.sourceNodeId,
            targetNodeId: suggestion.targetNodeId,
            edgeType: suggestion.edgeType,
          },
          nodeId: suggestion.targetNodeId,
          fromNodeId: suggestion.sourceNodeId,
        });
        const id = rejected.id;
        const common = {
          status: 'rejected' as const,
          revision: rejected.revision,
          lastEventSequence: event.sequence,
        };
        return {
          status: 200,
          body:
            family === 'suggestions'
              ? { suggestionId: id, ...common }
              : { proposalId: id, ...common },
        };
      },
    });
  }

  /** The suggestion, owner- and study-scoped from the lock: absent and another user's are 404. */
  private async find(
    m: StudyMutation,
    suggestionId: string,
    capabilities: readonly AiSuggestionCapability[],
  ): Promise<AiSuggestion> {
    if (!isResourceId(suggestionId)) throw new NotFoundError();
    const suggestion = await AiSuggestion.findOne({
      where: {
        id: suggestionId,
        studyId: m.studyId,
        ownerId: m.ownerId,
        capability: [...capabilities],
      },
    });
    if (!suggestion) throw new NotFoundError();
    return suggestion;
  }
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('AiSuggestions: a suggestion is missing a required column');
  return value;
}

function itemSignature(capability: string, key: string): string {
  return createHash('sha256').update(`${capability}|${key}`).digest('hex');
}

/** Every node it rests on still live, at the revision the proposal was made against. */
function isCurrent(row: AiSuggestion, revisions: ReadonlyMap<string, number>): boolean {
  return Object.entries(row.dependencyVersions).every(
    ([id, revision]) => revisions.get(id) !== undefined && revisions.get(id) === revision,
  );
}

function toDto(row: AiSuggestion, current: boolean): AiSuggestionDto {
  return {
    id: row.id,
    studyId: row.studyId,
    capability: row.capability === 'tensions' ? 'tensions' : 'relationships',
    status: row.status === 'proposed' && !current ? 'expired' : row.status,
    sourceNodeId: required(row.sourceNodeId),
    targetNodeId: required(row.targetNodeId),
    type: required(row.edgeType),
    rationale: row.proposalJson.rationale,
    caveat: row.proposalJson.caveat ?? null,
    evidence: row.proposalJson.evidence.map((e) => ({ id: e.id, quote: e.quote })),
    revision: row.revision,
    basisRevision: row.basisContentRevision,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    acceptedEdgeId: row.acceptedEdgeId,
  };
}

function toProposalDto(row: AiSuggestion, current: boolean): AiProposal {
  const common = {
    id: row.id,
    studyId: row.studyId,
    status: row.status === 'proposed' && !current ? ('expired' as const) : row.status,
    revision: row.revision,
    basisRevision: row.basisContentRevision,
    modelId: row.modelId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    acceptedNodeId: row.acceptedNodeId,
  };
  if (row.capability === 'passages') {
    return {
      ...common,
      capability: 'passages',
      reference: required(row.proposalJson.reference ?? null),
      reason: row.proposalJson.rationale,
    };
  }
  return {
    ...common,
    capability: 'questions',
    text: row.proposalJson.text ?? '',
    rationale: row.proposalJson.rationale,
    evidence: row.proposalJson.evidence.map((e) => ({ id: e.id, quote: e.quote })),
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
