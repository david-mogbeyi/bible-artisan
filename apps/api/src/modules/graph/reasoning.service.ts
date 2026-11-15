import { Controller, Get, Header, Injectable, Param } from '@nestjs/common';
import {
  REASONING_GAP_MESSAGES,
  type ReasoningGapCode,
  type ReasoningPathResponse,
  type ReasoningStep,
} from '@bible-artisan/contracts';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { StudyAccessService } from '../study/study-access.service';
import { ThreadReadService } from '../thread/thread-read.service';
import { NodesService } from './nodes.service';

/** Most history events one reasoning path shows. */
export const REASONING_EVENT_LIMIT = 200;

/**
 * The deterministic reasoning path of a node (BIB-45; PRD section 16 "Reasoning reconstruction":
 * "deterministic path retrieval is available without AI"; section 18: the prior conclusion's
 * path opens even when no AI request succeeds). Built only from what was recorded: a
 * conclusion's immutable versions with the evidence snapshot each was written with, and the
 * Study Thread events about the node, oldest first. What is missing is stated as a gap with fixed
 * copy (a version without evidence, evidence removed or changed since, a version no event
 * records), never inferred as a fact.
 */
@Injectable()
export class ReasoningService {
  constructor(
    private readonly access: StudyAccessService,
    private readonly nodes: NodesService,
    private readonly thread: ThreadReadService,
  ) {}

  async path(ownerId: string, studyId: string, nodeId: string): Promise<ReasoningPathResponse> {
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId);
    const versions = (await this.nodes.versions(ownerId, studyId, node.id)).items.slice().reverse();
    const events = await this.thread.nodeHistory(
      ownerId,
      node.studyId,
      node.id,
      versions.map((version) => version.id),
      REASONING_EVENT_LIMIT,
    );
    const eventByVersion = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.versionId && !eventByVersion.has(event.versionId)) {
        eventByVersion.set(event.versionId, event);
      }
    }
    const gaps: ReasoningPathResponse['gaps'] = [];
    const gap = (code: ReasoningGapCode, versionId: string | null, edgeId: string | null) =>
      gaps.push({ code, message: REASONING_GAP_MESSAGES[code], versionId, edgeId });

    const steps: { at: string; sequence: bigint; step: ReasoningStep }[] = [];
    for (const version of versions) {
      const event = eventByVersion.get(version.id) ?? null;
      if (version.evidence.length === 0) gap('no_evidence_recorded', version.id, null);
      for (const evidence of version.evidence) {
        if (!evidence.edgeLive) gap('evidence_removed', version.id, evidence.edgeId);
        else if (!evidence.nodeLive || evidence.nodeChangedSince) {
          gap('evidence_changed', version.id, evidence.edgeId);
        }
      }
      if (!event) gap('no_event_recorded', version.id, null);
      steps.push({
        at: version.createdAt,
        sequence: event ? BigInt(event.sequence) : 0n,
        step: {
          kind: 'version',
          versionId: version.id,
          versionNumber: version.versionNumber,
          action: version.action,
          statement: version.statement,
          status: version.status,
          established: version.established,
          createdAt: version.createdAt,
          eventId: event?.id ?? null,
          eventSequence: event?.sequence ?? null,
          evidence: version.evidence.map((evidence) => ({
            edgeId: evidence.edgeId,
            edgeType: evidence.edgeType,
            nodeId: evidence.nodeId,
            label: evidence.label,
            edgeLive: evidence.edgeLive,
            nodeLive: evidence.nodeLive,
            nodeChangedSince: evidence.nodeChangedSince,
          })),
        },
      });
    }
    const recordedVersions = new Set(eventByVersion.values());
    for (const event of events) {
      if (recordedVersions.has(event)) continue;
      steps.push({
        at: event.occurredAt.toISOString(),
        sequence: BigInt(event.sequence),
        step: {
          kind: 'event',
          eventId: event.id,
          sequence: event.sequence,
          eventType: event.eventType,
          occurredAt: event.occurredAt.toISOString(),
        },
      });
    }
    steps.sort((a, b) =>
      a.at === b.at
        ? a.sequence < b.sequence
          ? -1
          : a.sequence > b.sequence
            ? 1
            : 0
        : a.at < b.at
          ? -1
          : 1,
    );
    if (steps.length <= 1 && versions.length === 0) gap('no_history', null, null);
    return { nodeId: node.id, steps: steps.map((entry) => entry.step), gaps };
  }
}

/** `GET /v1/studies/:studyId/nodes/:nodeId/reasoning` (BIB-45). */
@Controller('studies/:studyId/nodes/:nodeId/reasoning')
export class ReasoningController {
  constructor(private readonly reasoning: ReasoningService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
  ): Promise<ReasoningPathResponse> {
    return this.reasoning.path(ownerId, studyId, nodeId);
  }
}
