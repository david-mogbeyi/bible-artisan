import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_MAX_DELAY_DAYS,
  PHRASE_SELECTED,
  type RecordActivityResponse,
  recordActivityRequestSchema,
  SCRIPTURE_OPENED,
  SEARCH_PERFORMED,
} from '@bible-artisan/contracts';
import {
  IdempotencyKeyReusedError,
  NotFoundError,
  ReferenceNotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../../common/mutation/mutation.service';
import type { StudyMutation } from '../../../common/mutation/study-mutation';
import { parseBody } from '../../../common/validation/parse-body';
import { StudyEvent } from '../../../database/models/study-event.model';
import { ReferenceService } from '../../bible-content/reference/reference.service';
import { StudyAccessService } from '../../study/study-access.service';
import { StudyGraphService } from '../../study/study-graph.service';

/** A client clock may run a little ahead; anything further is clamped to the server's now. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = ACTIVITY_MAX_DELAY_DAYS * 24 * 60 * 60 * 1000;

function response(event: StudyEvent | { id: string; sequence: string }, eventType: string) {
  const body: RecordActivityResponse = {
    eventId: event.id,
    eventType,
    sequence: event.sequence,
    lastEventSequence: event.sequence,
  };
  return body;
}

/**
 * `POST /studies/:id/activity` (BIB-55; PRD sections 13, 24; FR-THREAD-002/003/004): deliberate
 * visits, committed selections and searches, each one event appended to the thread. The old event
 * a visit came from is never changed: a new event is appended that names it as its origin.
 *
 * Revision-free (`navigation: true`): reading never 409s another tab's edit, and never moves the
 * study revision or content revision. Idempotent by `clientMutationId`, which is the request's
 * Idempotency-Key: a retry with the identical body replays the first response, a different body
 * is 422. After the receipt expires, a retry still finds the stored event by its unique
 * `(owner_id, client_mutation_id)` and returns it (200) without writing a second.
 *
 * Every id in the body is checked against the session's study: a node, branch or event of
 * another study or user is the same 404 as an absent one. Only the active study accepts activity
 * (the pipeline's lifecycle guard).
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly graph: StudyGraphService,
    private readonly references: ReferenceService,
  ) {}

  async record(
    ownerId: string,
    studyId: string,
    request: MutationRequestInfo,
  ): Promise<MutationResult> {
    const body = parseBody(recordActivityRequestSchema, request.body);
    if (request.idempotencyKey !== null && request.idempotencyKey !== body.clientMutationId) {
      throw new ValidationError('Invalid request', {
        clientMutationId: ['Must match the Idempotency-Key header'],
      });
    }
    const occurredAt = this.occurredAt(body.occurredAt);
    const eventType =
      body.kind === 'visit'
        ? SCRIPTURE_OPENED
        : body.kind === 'selection'
          ? PHRASE_SELECTED
          : SEARCH_PERFORMED;

    return this.mutations.execute(
      ownerId,
      { ...request, idempotencyKey: body.clientMutationId },
      {
        studyId,
        bumpsContentRevision: false,
        navigation: true,
        work: async (m) => {
          const existing = await StudyEvent.findOne({
            where: { ownerId: m.ownerId, clientMutationId: body.clientMutationId },
          });
          if (existing) {
            if (existing.studyId !== m.studyId || existing.eventType !== eventType) {
              throw new IdempotencyKeyReusedError();
            }
            m.unchanged();
            return { status: 200, body: { ...response(existing, eventType) } };
          }

          const nodeIds = [
            ...(body.kind === 'visit' && body.nodeId ? [body.nodeId] : []),
            ...(body.kind === 'visit' && body.origin.nodeId ? [body.origin.nodeId] : []),
          ];
          await this.requireNodes(m, nodeIds);
          if (body.branchId) await this.requireBranch(m, body.branchId);
          const eventIds = [
            ...(body.parentVisitEventId ? [body.parentVisitEventId] : []),
            ...(body.kind === 'visit' && body.origin.eventId ? [body.origin.eventId] : []),
          ];
          await this.requireEvents(m, eventIds);

          let payload: Record<string, unknown>;
          if (body.kind === 'search') {
            payload = { query: body.query };
          } else {
            const referenceLabel = await this.referenceLabel(body.referenceId);
            payload = { referenceId: body.referenceId, referenceLabel };
            if (body.kind === 'visit') {
              const { origin } = body;
              payload.originKind = origin.kind;
              if (origin.eventId) payload.originEventId = origin.eventId;
              if (origin.referenceId) {
                payload.originReferenceId = origin.referenceId;
                payload.originReferenceLabel = await this.referenceLabel(origin.referenceId);
              }
            }
          }

          const event = await m.appendEvent({
            eventType,
            payload,
            occurredAt,
            nodeId: body.kind === 'visit' ? (body.nodeId ?? null) : null,
            fromNodeId: body.kind === 'visit' ? (body.origin.nodeId ?? null) : null,
            branchId: body.branchId ?? null,
            versionId: null,
            parentVisitEventId: body.parentVisitEventId ?? null,
            sessionId: body.sessionId ?? null,
            clientMutationId: body.clientMutationId,
          });
          return { status: 201, body: { ...response(event, eventType) } };
        },
      },
    );
  }

  private occurredAt(value: string | undefined): Date {
    const now = Date.now();
    if (value === undefined) return new Date(now);
    const time = Date.parse(value);
    if (time < now - MAX_DELAY_MS) {
      throw new ValidationError('Invalid request', {
        occurredAt: [`Must be within the last ${ACTIVITY_MAX_DELAY_DAYS} days`],
      });
    }
    if (time > now + FUTURE_TOLERANCE_MS) {
      throw new ValidationError('Invalid request', { occurredAt: ['Must not be in the future'] });
    }
    return new Date(Math.min(time, now));
  }

  private async referenceLabel(referenceId: string): Promise<string> {
    try {
      return (await this.references.storedReference(referenceId)).reference.label;
    } catch (error) {
      if (error instanceof NotFoundError) throw new ReferenceNotFoundError();
      throw error;
    }
  }

  /** Nodes of this study (a deleted one still counts: a tombstone can be followed from). */
  private async requireNodes(m: StudyMutation, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.access.ownedNodesIncludingDeleted(m.ownerId, m.studyId, ids);
    if (found.length !== new Set(ids).size) throw new NotFoundError();
  }

  private async requireBranch(m: StudyMutation, branchId: string): Promise<void> {
    const branches = await this.graph.listBranches(m.ownerId, m.studyId);
    if (!branches.some((branch) => branch.id === branchId)) throw new NotFoundError();
  }

  private async requireEvents(m: StudyMutation, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const count = await StudyEvent.count({
      where: { id: unique, studyId: m.studyId, ownerId: m.ownerId },
    });
    if (count !== unique.length) throw new NotFoundError();
  }
}
