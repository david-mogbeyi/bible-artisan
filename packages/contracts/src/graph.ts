import { z } from 'zod';
import { branchSchema } from './branch';
import { EDGE_ORIGINS, EDGE_TYPES } from './edge';
import { eventSequenceSchema, expectedRevisionSchema } from './mutation';
import { nodeSummarySchema } from './node';

/**
 * The graph snapshot and persistent node positions (BIB-28; PRD sections 9, 12, 23, 24, 27;
 * FR-GRAPH-007/008/009). These DTOs are library-independent (AGENTS.md rule 10): no React Flow
 * type or field (`position`, `data`, `selected`, `width`, …) appears here. The web app converts
 * them to its canvas's view objects, and only `{ nodeId, x, y }` ever travels back.
 *
 * Positions are presentation, not content. They are checked against the study's **view
 * revision** (`study_view_state.revision`), never the study revision or content revision, so
 * moving nodes never conflicts with a content edit and never marks anything stale.
 */

/** PRD section 24: `PATCH /studies/:id/positions` batch max 100. */
export const MAX_POSITIONS_PER_REQUEST = 100;

/** Canvas units. A database CHECK enforces the same bound. */
export const MAX_POSITION_COORDINATE = 1_000_000;

/** Above this many live nodes the canvas opens in a focused view (PRD section 12). */
export const FOCUSED_VIEW_NODE_THRESHOLD = 500;

/** The view revision of a study that has never saved a position. */
export const INITIAL_VIEW_REVISION = 1;

export const DUPLICATE_POSITION = 'Each node can appear only once';

/** A finite coordinate within ±1,000,000 (zod numbers already reject NaN and Infinity). */
const coordinateSchema = z.number().min(-MAX_POSITION_COORDINATE).max(MAX_POSITION_COORDINATE);

/** One stored node position, as read and as sent. */
export const nodePositionSchema = z.strictObject({
  /** Lower-cased so duplicate detection matches PostgreSQL's uuid equality. */
  nodeId: z.uuid().transform((id) => id.toLowerCase()),
  x: coordinateSchema,
  y: coordinateSchema,
});

export type NodePosition = z.output<typeof nodePositionSchema>;

/**
 * `PATCH /v1/studies/:studyId/positions`: 1-100 positions of live nodes of the study, each node
 * once. `expectedRevision` is the **view** revision from `GET /graph` (or the last save). Only
 * the sent nodes change; every other stored position stays as it is.
 */
export const savePositionsRequestSchema = z
  .strictObject({
    expectedRevision: expectedRevisionSchema,
    positions: z.array(nodePositionSchema).min(1).max(MAX_POSITIONS_PER_REQUEST),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.positions.forEach((position, index) => {
      if (seen.has(position.nodeId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'nodeId'],
          message: DUPLICATE_POSITION,
        });
      }
      seen.add(position.nodeId);
    });
  });

export type SavePositionsRequest = z.input<typeof savePositionsRequestSchema>;

/** 200 from `PATCH /positions`: the new view revision. Ids and numbers only. */
export const savePositionsResponseSchema = z.object({
  viewRevision: z.number().int().positive(),
  lastEventSequence: eventSequenceSchema,
});

export type SavePositionsResponse = z.infer<typeof savePositionsResponseSchema>;

/** A live edge in the snapshot: compact metadata, never its note. */
export const graphEdgeSchema = z.object({
  id: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.enum(EDGE_TYPES),
  origin: z.enum(EDGE_ORIGINS),
});

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * `GET /v1/studies/:studyId/graph`: one consistent snapshot (read in one transaction), so the
 * rows, `contentRevision` and `viewRevision` describe the same moment.
 * - `nodes`: exactly `GET /nodes`'s items (live nodes, oldest first, ties by id);
 * - `edges`: live edges whose two endpoints are live, oldest first (ties by id), without notes;
 * - `branches`: oldest first (ties by id), each with its revision and live member nodes (BIB-60,
 *   `branchSchema`);
 * - `positions`: stored positions of live nodes, by node id;
 * - `viewRevision`: the view-state revision, 1 before the first position save.
 * Unpaginated, bounded by the 2,000-node and 6,000-edge caps.
 */
export const graphResponseSchema = z.object({
  studyId: z.uuid(),
  contentRevision: z.number().int().positive(),
  viewRevision: z.number().int().positive(),
  nodes: z.array(nodeSummarySchema),
  edges: z.array(graphEdgeSchema),
  branches: z.array(branchSchema),
  positions: z.array(
    z.object({
      nodeId: z.uuid(),
      x: z.number(),
      y: z.number(),
    }),
  ),
});

export type GraphResponse = z.infer<typeof graphResponseSchema>;
