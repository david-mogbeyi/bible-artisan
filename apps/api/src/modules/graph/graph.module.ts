import { Module } from '@nestjs/common';
import { MutationModule } from '../../common/mutation/mutation.module';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { StudyModule } from '../study/study.module';
import { EdgesController } from './edges.controller';
import { EdgesService } from './edges.service';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';
import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';

/**
 * Graph bounded context (PRD §26). Owns node creation, edits and reads (`/studies/:id/nodes`,
 * BIB-25) on `study_node`, whose table the Study context created: Study still inserts the roots
 * at study creation and BIB-20's new main question, and keeps the `StudyAccessService` lookups
 * every module uses. Writes run through `MutationService` (the StudyEvent commits in the same
 * transaction); the study revision check goes through `StudyRevisionService`, never the `study`
 * table, and Scripture references through `ReferenceService`. Graph owns `study_edge` (BIB-27,
 * `/studies/:id/edges`; `connectNodes` composes into other mutations), and the persistent layout
 * (BIB-28, `GET /studies/:id/graph`, `PATCH /studies/:id/positions`): `study_view_state` and
 * `study_node_position`. It reads branches through Study's `StudyGraphService`. NodeVersion and
 * branch membership (BIB-60) arrive with Graph's later tickets.
 */
@Module({
  imports: [MutationModule, StudyModule, BibleContentModule],
  controllers: [NodesController, EdgesController, GraphController],
  providers: [NodesService, EdgesService, GraphService],
})
export class GraphModule {}
