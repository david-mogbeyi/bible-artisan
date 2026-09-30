import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OpenApiModule } from './openapi/openapi.module';
import { AiModule } from './modules/ai/ai.module';
import { BibleContentModule } from './modules/bible-content/bible-content.module';
import { ExportsModule } from './modules/exports/exports.module';
import { GraphModule } from './modules/graph/graph.module';
import { IdentityModule } from './modules/identity/identity.module';
import { NotesModule } from './modules/notes/notes.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { StudyModule } from './modules/study/study.module';
import { ThreadModule } from './modules/thread/thread.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    OpenApiModule,
    IdentityModule,
    StudyModule,
    BibleContentModule,
    GraphModule,
    ThreadModule,
    NotesModule,
    AiModule,
    ExportsModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
