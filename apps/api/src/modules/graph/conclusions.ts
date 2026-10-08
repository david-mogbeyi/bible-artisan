import {
  CHANGE_REASON_REQUIRED,
  CONCLUSION_EVIDENCE_REQUIRED,
  CONCLUSION_NOT_SUPPORTED,
  CONCLUSION_TEXT_TOO_LONG,
  type ConclusionAction,
  type ConclusionStatus,
  type EvidenceRole,
  MAX_QUESTION_LENGTH,
  NODE_UNCHANGED,
  type NodeWarning,
  STATUS_NOT_FOR_NODE_TYPE,
  type UpdateNodeRequest,
} from '@bible-artisan/contracts';
import { fn, Op } from 'sequelize';
import { NodeRuleError, ValidationError } from '../../common/errors/domain-errors';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { NodeVersion } from '../../database/models/node-version.model';
import { NodeVersionEvidence } from '../../database/models/node-version-evidence.model';
import { StudyEdge } from '../../database/models/study-edge.model';
import { StudyNode } from '../../database/models/study-node.model';

/**
 * Conclusion versions, evidence and "Established by me" (BIB-30; PRD sections 8, 12, 23;
 * FR-CONCLUSION-001...005). Only the owner's `PATCH /nodes/:nodeId` changes a conclusion's status
 * or sets the marker; the evidence-loss rule below can only clear the marker. No other module
 * calls these functions, and no AI code path may (AGENTS rule 7).
 */

/** Conclusion events, ids, enums, booleans and integers only (NFR-PRIV-001). All thread-visible. */
export const CONCLUSION_EVENTS = {
  created: 'conclusion_created',
  updated: 'conclusion_updated',
  challenged: 'conclusion_challenged',
  abandoned: 'conclusion_abandoned',
  established: 'conclusion_established',
  establishmentCleared: 'conclusion_establishment_cleared',
} as const;

/** The edge types that count as evidence for a conclusion, and which end it sits on. */
const CHALLENGING_TYPES = ['contradicts', 'qualifies'] as const;

/** Where a conclusion stands before a request. */
export interface ConclusionState {
  text: string;
  status: ConclusionStatus;
  established: boolean;
}

/** The outcome of one request: what the node and its new version become. */
export interface ConclusionPlan {
  text: string;
  status: ConclusionStatus;
  established: boolean;
  action: ConclusionAction;
  eventType: string;
  statementChanged: boolean;
  warnings: NodeWarning[];
}

function invalid(field: string, message: string): ValidationError {
  return new ValidationError('Invalid request', { [field]: [message] });
}

/**
 * What one PATCH does to a conclusion, or why it cannot (PRD section 12; FR-CONCLUSION-002...004).
 * Pure: `liveSupportCount` is the number of live supporting relationships the server counted.
 *
 * Applied as one change: a new statement makes the status `revised`; any status other than
 * `supported` clears the marker; `establishment: 'set'` needs a supported conclusion with live
 * support; marking `supported` needs live support. Checked in order: 400 (a new statement needs
 * its reason and at most 4,000 characters), `CONCLUSION_NOT_SUPPORTED`, `NODE_UNCHANGED` (so
 * re-sending the current status never asks for evidence), `CONCLUSION_EVIDENCE_REQUIRED`.
 */
export function planConclusionChange(
  current: ConclusionState,
  body: Pick<UpdateNodeRequest, 'text' | 'status' | 'establishment' | 'changeReason'>,
  liveSupportCount: number,
): ConclusionPlan {
  if (body.text !== undefined) {
    if (Array.from(body.text).length > MAX_QUESTION_LENGTH) {
      throw invalid('text', CONCLUSION_TEXT_TOO_LONG);
    }
    if (body.text !== current.text && body.changeReason === undefined) {
      throw invalid('changeReason', CHANGE_REASON_REQUIRED);
    }
  }
  const requested = body.status === 'revised' ? undefined : body.status;
  if (requested !== undefined && !isConclusionStatus(requested)) {
    throw invalid('status', STATUS_NOT_FOR_NODE_TYPE);
  }
  const statementChanged = body.text !== undefined && body.text !== current.text;
  const status: ConclusionStatus = statementChanged ? 'revised' : (requested ?? current.status);
  const text = statementChanged ? (body.text ?? current.text) : current.text;

  let established = false;
  if (status === 'supported') {
    if (body.establishment === 'set') established = true;
    else if (body.establishment === 'clear') established = false;
    else established = current.established;
  }

  if (body.establishment === 'set' && status !== 'supported') {
    throw new NodeRuleError(CONCLUSION_NOT_SUPPORTED);
  }
  if (!statementChanged && status === current.status && established === current.established) {
    throw new NodeRuleError(NODE_UNCHANGED);
  }
  const needsEvidence =
    (status === 'supported' && current.status !== 'supported') ||
    (established && !current.established);
  if (needsEvidence && liveSupportCount === 0) {
    throw new NodeRuleError(CONCLUSION_EVIDENCE_REQUIRED);
  }

  const action = actionOf(statementChanged, status, current, established);
  return {
    text,
    status,
    established,
    action,
    eventType: eventOf(action),
    statementChanged,
    warnings: current.established && !established ? ['establishment_cleared'] : [],
  };
}

function isConclusionStatus(status: string): status is ConclusionStatus {
  return ['tentative', 'supported', 'challenged', 'revised', 'abandoned'].includes(status);
}

/** The version's action, by precedence: statement, abandoned, challenged, marker set, any other. */
function actionOf(
  statementChanged: boolean,
  status: ConclusionStatus,
  current: ConclusionState,
  established: boolean,
): ConclusionAction {
  if (statementChanged) return 'revised';
  if (status === 'abandoned' && current.status !== 'abandoned') return 'abandoned';
  if (status === 'challenged' && current.status !== 'challenged') return 'challenged';
  if (established && !current.established) return 'established';
  return 'updated';
}

function eventOf(action: ConclusionAction): string {
  switch (action) {
    case 'abandoned':
      return CONCLUSION_EVENTS.abandoned;
    case 'challenged':
      return CONCLUSION_EVENTS.challenged;
    case 'established':
      return CONCLUSION_EVENTS.established;
    default:
      return CONCLUSION_EVENTS.updated;
  }
}

/** One live relationship for or against a conclusion, with the node at its other end. */
export interface LiveEvidence {
  conclusionId: string;
  edgeId: string;
  edgeType: StudyEdge['type'];
  role: EvidenceRole;
  nodeId: string;
  nodeType: StudyNode['type'];
  nodeRevision: number;
}

/**
 * The live evidence of these conclusions, the one definition every caller shares (the node list,
 * the graph snapshot, a node's detail, a version's snapshot and the evidence-loss rule). Live
 * supporting evidence is an incoming `supports` or an outgoing `inference_from` edge; challenging
 * is an incoming `contradicts` or `qualifies`. Both need a live edge and a live node at the other
 * end. Two statements whatever the count (the edges, then the other nodes), bounded by the edge
 * cap; inside a managed transaction both join it.
 */
export async function liveEvidence(
  scope: { studyId: string; ownerId: string },
  conclusionIds: readonly string[],
): Promise<LiveEvidence[]> {
  if (conclusionIds.length === 0) return [];
  const ids = [...conclusionIds];
  const edges = await StudyEdge.findAll({
    where: {
      studyId: scope.studyId,
      ownerId: scope.ownerId,
      deletedAt: null,
      [Op.or]: [
        { type: 'supports', targetNodeId: ids },
        { type: 'inference_from', sourceNodeId: ids },
        { type: [...CHALLENGING_TYPES], targetNodeId: ids },
      ],
    },
    attributes: ['id', 'type', 'sourceNodeId', 'targetNodeId'],
  });
  if (edges.length === 0) return [];
  const sides = edges.map((edge) => {
    const conclusionIsSource = edge.type === 'inference_from';
    return {
      edge,
      conclusionId: conclusionIsSource ? edge.sourceNodeId : edge.targetNodeId,
      otherId: conclusionIsSource ? edge.targetNodeId : edge.sourceNodeId,
    };
  });
  const others = await StudyNode.findAll({
    where: {
      studyId: scope.studyId,
      ownerId: scope.ownerId,
      deletedAt: null,
      id: [...new Set(sides.map((side) => side.otherId))],
    },
    attributes: ['id', 'type', 'revision'],
  });
  const byId = new Map(others.map((node) => [node.id, node]));
  return sides.flatMap(({ edge, conclusionId, otherId }) => {
    const other = byId.get(otherId);
    if (!other) return [];
    const role: EvidenceRole =
      edge.type === 'supports' || edge.type === 'inference_from' ? 'supporting' : 'challenging';
    return [
      {
        conclusionId,
        edgeId: edge.id,
        edgeType: edge.type,
        role,
        nodeId: other.id,
        nodeType: other.type,
        nodeRevision: other.revision,
      },
    ];
  });
}

/** How many live supporting relationships each conclusion has (0 for one with none). */
export function supportCounts(
  evidence: readonly LiveEvidence[],
  conclusionIds: readonly string[],
): Map<string, number> {
  const counts = new Map(conclusionIds.map((id) => [id, 0]));
  for (const row of evidence) {
    if (row.role === 'supporting')
      counts.set(row.conclusionId, (counts.get(row.conclusionId) ?? 0) + 1);
  }
  return counts;
}

/** A supported conclusion with no live supporting evidence (derived, never stored). */
export function isEvidenceIncomplete(status: ConclusionStatus | null, supportCount: number) {
  return status === 'supported' && supportCount === 0;
}

/** The owner-and-study scope of a locked mutation, for `liveEvidence`. */
function scopeOf(m: StudyMutation) {
  return { studyId: m.studyId, ownerId: m.ownerId };
}

/**
 * Inserts the conclusion's next version (numbers from 1 without gaps, read under the study lock)
 * with a snapshot of its live evidence right now, and returns it. `node` is the conclusion as
 * just written. Version 1 of a new conclusion has no evidence.
 */
export async function writeConclusionVersion(
  m: StudyMutation,
  node: StudyNode,
  action: ConclusionAction,
  reason: string | null,
): Promise<NodeVersion> {
  const latest = await NodeVersion.max<number, NodeVersion>('versionNumber', {
    where: { nodeId: node.id, studyId: m.studyId, ownerId: m.ownerId },
  });
  const version = await m.createChild(NodeVersion, {
    nodeId: node.id,
    versionNumber: (latest ?? 0) + 1,
    action,
    statement: required(node.title),
    conclusionStatus: required(node.conclusionStatus),
    established: node.establishedAt !== null,
    changeReason: reason,
  });
  const evidence = await liveEvidence(scopeOf(m), [node.id]);
  if (evidence.length > 0) {
    // Another conclusion's newest version, so the snapshot can say which one it saw.
    const conclusionIds = evidence
      .filter((row) => row.nodeType === 'conclusion')
      .map((r) => r.nodeId);
    const newest = new Map<string, string>();
    if (conclusionIds.length > 0) {
      const versions = await NodeVersion.findAll({
        where: { studyId: m.studyId, ownerId: m.ownerId, nodeId: conclusionIds },
        attributes: ['id', 'nodeId', 'versionNumber'],
        order: [['versionNumber', 'ASC']],
      });
      for (const row of versions) newest.set(row.nodeId, row.id);
    }
    await NodeVersionEvidence.bulkCreate(
      evidence.map((row) => ({
        versionId: version.id,
        studyId: m.studyId,
        ownerId: m.ownerId,
        edgeId: row.edgeId,
        edgeType: row.edgeType,
        role: row.role,
        nodeId: row.nodeId,
        nodeRevision: row.nodeRevision,
        nodeVersionId: newest.get(row.nodeId) ?? null,
      })),
    );
  }
  return version;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('conclusion row is missing a column its type requires');
  return value;
}

/** An edge as it was before an edge mutation, enough to know which conclusion it supported. */
export interface EdgeBefore {
  id: string;
  type: StudyEdge['type'];
  sourceNodeId: string;
  targetNodeId: string;
}

/**
 * The evidence-loss rule (PRD section 23: "If all live incoming supports and outgoing
 * inference-from edges of a supported conclusion disappear, retain the user's status but clear
 * establishment"). Called by an edge's removal or retype, after the edge write and in its
 * transaction, with the edge as it was before. When that edge counted as supporting evidence for a
 * conclusion that is established and now has none, this clears `established_at` (a revisioned
 * update, so a stale client edit gets 409), writes an `evidence_removed` version and appends
 * `conclusion_establishment_cleared`. The status is kept. Returns the cleared conclusion ids.
 */
export async function releaseLostEvidence(m: StudyMutation, before: EdgeBefore): Promise<string[]> {
  let conclusionId: string;
  if (before.type === 'supports') conclusionId = before.targetNodeId;
  else if (before.type === 'inference_from') conclusionId = before.sourceNodeId;
  else return [];
  const conclusion = await StudyNode.findOne({
    where: {
      id: conclusionId,
      studyId: m.studyId,
      ownerId: m.ownerId,
      type: 'conclusion',
      deletedAt: null,
      establishedAt: { [Op.ne]: null },
    },
  });
  if (!conclusion) return [];
  const remaining = (await liveEvidence(scopeOf(m), [conclusion.id])).filter(
    (row) => row.role === 'supporting',
  );
  if (remaining.length > 0) return [];
  const cleared = await m.updateWithExpectedRevision(StudyNode, {
    id: conclusion.id,
    expectedRevision: conclusion.revision,
    values: { establishedAt: null },
    where: { deletedAt: null },
  });
  const version = await writeConclusionVersion(m, cleared, 'evidence_removed', null);
  await m.appendEvent({
    eventType: CONCLUSION_EVENTS.establishmentCleared,
    payload: {
      nodeId: cleared.id,
      versionId: version.id,
      versionNumber: version.versionNumber,
      edgeId: before.id,
    },
  });
  return [cleared.id];
}

/** `established_at` for a request: the database clock when it becomes established. */
export function establishedAtFor(plan: ConclusionPlan, current: StudyNode) {
  if (!plan.established) return null;
  return current.establishedAt ?? fn('now');
}
