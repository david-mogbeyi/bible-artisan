import { Inject, Injectable } from '@nestjs/common';
import {
  type GraphResponse,
  INITIAL_VIEW_REVISION,
  savePositionsRequestSchema,
  type SavePositionsResponse,
} from '@bible-artisan/contracts';
import { QueryTypes, Transaction } from 'sequelize';
import { NotFoundError } from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { parseBody } from '../../common/validation/parse-body';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { StudyEdge } from '../../database/models/study-edge.model';
import { StudyNode } from '../../database/models/study-node.model';
import { StudyNodePosition } from '../../database/models/study-node-position.model';
import { StudyViewState } from '../../database/models/study-view-state.model';
import { StudyAccessService } from '../study/study-access.service';
import { StudyGraphService } from '../study/study-graph.service';
import { NodesService } from './nodes.service';

/**
 * `node_position_saved {nodeCount, viewRevision}`: one per position save, counts and numbers only
 * (never coordinates). Internal-only (PRD section 13 lists it as an internal event family), for
 * BIB-55's visibility column. Pan, zoom, selection, filters and focus write no event.
 */
export const NODE_POSITION_SAVED = 'node_position_saved';

/**
 * One statement for the whole batch: insert or overwrite the sent nodes' positions, leaving every
 * other stored position as it is. Owner and study come from the mutation's lock, and the
 * composite FK to `study_node (owner_id, study_id, id)` backs the live-node check in SQL.
 */
const UPSERT_POSITIONS_SQL = `
  INSERT INTO study_node_position (study_id, owner_id, node_id, x, y)
  SELECT $1, $2, p.node_id, p.x, p.y
    FROM unnest($3::uuid[], $4::double precision[], $5::double precision[]) AS p(node_id, x, y)
  ON CONFLICT (study_id, node_id)
  DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = now()`;

/**
 * The graph snapshot and the persistent layout (BIB-28). The layout is presentation: a position
 * save checks the study's **view revision** (`study_view_state.revision`) through the ordinary
 * pipeline, never the study revision, and declares no content change, so `study.revision` and
 * `content_revision` stay put (see modules/README.md, "A presentation revision").
 */
@Injectable()
export class GraphService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly nodes: NodesService,
    private readonly studyGraph: StudyGraphService,
  ) {}

  /**
   * `GET /studies/:studyId/graph`: one REPEATABLE READ, read-only transaction, so every row and
   * both revisions describe the same committed moment, even while a mutation commits between two
   * of its statements. A fixed number of statements whatever the study's size (no per-node
   * query); unpaginated, bounded by the node and edge caps.
   */
  snapshot(ownerId: string, studyId: string): Promise<GraphResponse> {
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async () => {
        await this.db.query('SET TRANSACTION READ ONLY');
        const study = await this.access.requireOwnedStudy(ownerId, studyId);
        const scope = { studyId, ownerId };
        const nodes = await this.nodes.liveSummaries(ownerId, studyId);
        const live = new Set(nodes.map((node) => node.id));
        const edges = await StudyEdge.findAll({
          where: { ...scope, deletedAt: null },
          attributes: ['id', 'sourceNodeId', 'targetNodeId', 'type', 'origin'],
          order: [
            ['createdAt', 'ASC'],
            ['id', 'ASC'],
          ],
        });
        const branches = await this.studyGraph.listBranches(ownerId, studyId);
        const positions = await StudyNodePosition.findAll({
          where: scope,
          attributes: ['nodeId', 'x', 'y'],
          order: [['nodeId', 'ASC']],
        });
        const viewState = await StudyViewState.findOne({
          where: scope,
          attributes: ['revision'],
        });
        return {
          studyId: study.id,
          contentRevision: study.contentRevision,
          viewRevision: viewState?.revision ?? INITIAL_VIEW_REVISION,
          nodes,
          edges: edges
            .filter((edge) => live.has(edge.sourceNodeId) && live.has(edge.targetNodeId))
            .map((edge) => ({
              id: edge.id,
              sourceNodeId: edge.sourceNodeId,
              targetNodeId: edge.targetNodeId,
              type: edge.type,
              origin: edge.origin,
            })),
          branches: branches.map((branch) => ({
            id: branch.id,
            rootNodeId: branch.rootNodeId,
            createdAt: branch.createdAt.toISOString(),
          })),
          positions: positions
            .filter((position) => live.has(position.nodeId))
            .map((position) => ({ nodeId: position.nodeId, x: position.x, y: position.y })),
        };
      },
    );
  }

  /**
   * `PATCH /studies/:studyId/positions`. Under the study lock (so the lazy view-state insert
   * cannot race another save): 428/400 first, then the pipeline's lifecycle guard (422), then the
   * view revision (409), then every node live in this study and owner (404), then one upsert and
   * one internal event. Nothing else moves: not `study.revision`, not `content_revision`, not a
   * node's revision or `updated_at`, not an edge.
   */
  savePositions(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(savePositionsRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const viewState = await this.viewRevisionCheck(m, expectedRevision);
        const nodeIds = body.positions.map((position) => position.nodeId);
        const live = await StudyNode.count({
          where: { id: nodeIds, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
        });
        if (live !== nodeIds.length) throw new NotFoundError();
        await this.db.query(UPSERT_POSITIONS_SQL, {
          bind: [
            m.studyId,
            m.ownerId,
            nodeIds,
            body.positions.map((position) => position.x),
            body.positions.map((position) => position.y),
          ],
          type: QueryTypes.INSERT,
          transaction: m.transaction,
        });
        const event = await m.appendEvent({
          eventType: NODE_POSITION_SAVED,
          payload: { nodeCount: nodeIds.length, viewRevision: viewState.revision },
        });
        const response: SavePositionsResponse = {
          viewRevision: viewState.revision,
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }

  /**
   * The view-revision check: the study's view-state row, created at revision 1 by its first save
   * (the study lock serializes this, so no ON CONFLICT is needed; the unique key is the
   * backstop), then the ordinary conditional update on it. A stale revision is 409 with the view
   * revision as `currentRevision`.
   */
  private async viewRevisionCheck(m: StudyMutation, expectedRevision: number) {
    const existing = await StudyViewState.findOne({
      where: { studyId: m.studyId, ownerId: m.ownerId },
      attributes: ['id'],
    });
    const row = existing ?? (await m.createChild(StudyViewState, {}));
    return m.updateWithExpectedRevision(StudyViewState, {
      id: row.id,
      expectedRevision,
      values: {},
    });
  }
}
