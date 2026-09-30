import { Module } from '@nestjs/common';

/**
 * Notes bounded context (PRD §26). Owns Note, NoteVersion, Annotation. Placeholder module — its
 * tables and endpoints ship with Notes' own tickets.
 */
@Module({})
export class NotesModule {}
