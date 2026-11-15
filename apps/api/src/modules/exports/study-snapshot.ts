import type { StudyExport } from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import { Annotation } from '../../database/models/annotation.model';
import { NodeVersionEvidence } from '../../database/models/node-version-evidence.model';
import { NodeVersion } from '../../database/models/node-version.model';
import { NoteVersion } from '../../database/models/note-version.model';
import { Note } from '../../database/models/note.model';
import { StudyBranchMember } from '../../database/models/study-branch-member.model';
import { StudyBranch } from '../../database/models/study-branch.model';
import { StudyEdge } from '../../database/models/study-edge.model';
import { StudyEvent } from '../../database/models/study-event.model';
import { StudyNode } from '../../database/models/study-node.model';
import { StudySummary } from '../../database/models/study-summary.model';
import { StudyTag } from '../../database/models/study-tag.model';
import type { Study } from '../../database/models/study.model';
import { Tag } from '../../database/models/tag.model';
import type { ScriptureExportService } from '../bible-content/passage/scripture-export.service';

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
const byCreation: [string, string][] = [
  ['createdAt', 'ASC'],
  ['id', 'ASC'],
];

/**
 * Reads everything a study export holds (FR-EXPORT-001) for a study the caller already resolved
 * for its owner (`StudyAccessService.requireOwnedStudy`). Read-only: every query is scoped by the
 * study's own `study_id` and `owner_id`, and must run inside the caller's REPEATABLE READ,
 * read-only transaction (it joins it through transaction propagation), so the whole export
 * describes one committed moment.
 *
 * Soft-deleted nodes, edges, notes and highlights are included and marked (`deletedAt`), so
 * evidence that pointed at them stays explainable. The AI summary goes in its own labelled field,
 * never mixed into the user's content. Fixed number of statements per study.
 */
export async function readStudyExport(
  study: Study,
  scripture: ScriptureExportService,
): Promise<StudyExport> {
  const scope = { studyId: study.id, ownerId: study.ownerId };
  // One after another: they share the snapshot transaction's single connection.
  const nodes = await StudyNode.findAll({ where: scope, order: byCreation });
  const edges = await StudyEdge.findAll({ where: scope, order: byCreation });
  const branches = await StudyBranch.findAll({ where: scope, order: byCreation });
  const members = await StudyBranchMember.findAll({
    where: scope,
    order: [
      ['createdAt', 'ASC'],
      ['nodeId', 'ASC'],
    ],
  });
  const versions = await NodeVersion.findAll({
    where: scope,
    order: [
      ['nodeId', 'ASC'],
      ['versionNumber', 'ASC'],
    ],
  });
  const evidence = await NodeVersionEvidence.findAll({
    where: scope,
    order: [
      ['versionId', 'ASC'],
      ['edgeId', 'ASC'],
    ],
  });
  const notes = await Note.findAll({ where: scope, order: byCreation });
  const noteVersions = await NoteVersion.findAll({
    where: scope,
    order: [
      ['noteId', 'ASC'],
      ['versionNumber', 'ASC'],
    ],
  });
  const highlights = await Annotation.findAll({ where: scope, order: byCreation });
  const events = await StudyEvent.findAll({ where: scope, order: [['sequence', 'ASC']] });
  // The AI summary the study page shows (AiSummaryService.get): the current one, else the latest.
  const newestFirst: [string, string][] = [
    ['createdAt', 'DESC'],
    ['id', 'DESC'],
  ];
  const summary =
    (await StudySummary.findOne({
      where: { ...scope, publishedCurrent: true },
      order: newestFirst,
    })) ?? (await StudySummary.findOne({ where: scope, order: newestFirst }));
  const tagLinks = await StudyTag.findAll({ where: scope, attributes: ['tagId'] });
  const tags =
    tagLinks.length === 0
      ? []
      : await Tag.findAll({
          where: { ownerId: study.ownerId, id: { [Op.in]: tagLinks.map((link) => link.tagId) } },
          order: [['normalizedName', 'ASC']],
        });

  const referenceIds = [
    study.startingReferenceId,
    ...nodes.map((node) => node.scriptureReferenceId),
    ...notes.map((note) => note.targetReferenceId),
    ...highlights.map((highlight) => highlight.referenceId),
  ].filter((id): id is string => id !== null);

  const evidenceByVersion = new Map<
    string,
    StudyExport['conclusionVersions'][number]['evidence']
  >();
  for (const row of evidence) {
    const list = evidenceByVersion.get(row.versionId) ?? [];
    list.push({
      edgeId: row.edgeId,
      edgeType: row.edgeType,
      role: row.role,
      nodeId: row.nodeId,
      nodeRevision: row.nodeRevision,
      nodeVersionId: row.nodeVersionId,
    });
    evidenceByVersion.set(row.versionId, list);
  }
  const versionsByNote = new Map<string, StudyExport['notes'][number]['versions']>();
  for (const row of noteVersions) {
    const list = versionsByNote.get(row.noteId) ?? [];
    list.push({
      id: row.id,
      versionNumber: row.versionNumber,
      content: row.richTextJson,
      plainText: row.plainText,
      schemaVersion: row.schemaVersion,
      createdAt: iso(row.createdAt),
    });
    versionsByNote.set(row.noteId, list);
  }

  return {
    study: {
      id: study.id,
      title: study.title,
      description: study.description,
      lifecycle: study.lifecycle,
      tags: tags.map((tag) => tag.name),
      startingReferenceId: study.startingReferenceId,
      originalQuestionNodeId: study.originalQuestionNodeId,
      mainQuestionNodeId: study.mainQuestionNodeId,
      createdAt: iso(study.createdAt),
      updatedAt: iso(study.updatedAt),
      archivedAt: isoOrNull(study.archivedAt),
      deletedAt: isoOrNull(study.deletedAt),
    },
    basis: {
      revision: study.revision,
      contentRevision: study.contentRevision,
      lastEventSequence: String(study.lastEventSequence),
    },
    summary: summary
      ? {
          generatedBy: 'ai',
          stale: summary.basisContentRevision < study.contentRevision,
          content: summary.summaryJson,
        }
      : null,
    scripture: await scripture.passages(referenceIds),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      origin: node.origin,
      title: node.title,
      body: node.body,
      observationKind: node.observationKind,
      questionStatus: node.questionStatus,
      conclusionStatus: node.conclusionStatus,
      establishedAt: isoOrNull(node.establishedAt),
      scriptureReferenceId: node.scriptureReferenceId,
      canonicalNodeId: node.canonicalNodeId,
      derivedFromNoteId: node.derivedFromNoteId,
      source: node.payloadJson,
      revision: node.revision,
      createdAt: iso(node.createdAt),
      updatedAt: iso(node.updatedAt),
      deletedAt: isoOrNull(node.deletedAt),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type: edge.type,
      origin: edge.origin,
      suggestionId: edge.suggestionId,
      acceptedBy: edge.acceptedBy,
      note: edge.note,
      revision: edge.revision,
      createdAt: iso(edge.createdAt),
      updatedAt: iso(edge.updatedAt),
      deletedAt: isoOrNull(edge.deletedAt),
    })),
    branches: branches.map((branch) => ({
      id: branch.id,
      rootNodeId: branch.rootNodeId,
      memberNodeIds: members
        .filter((member) => member.branchId === branch.id)
        .map((member) => member.nodeId),
      createdAt: iso(branch.createdAt),
    })),
    conclusionVersions: versions.map((version) => ({
      id: version.id,
      nodeId: version.nodeId,
      versionNumber: version.versionNumber,
      action: version.action,
      statement: version.statement,
      conclusionStatus: version.conclusionStatus,
      established: version.established,
      changeReason: version.changeReason,
      createdAt: iso(version.createdAt),
      evidence: evidenceByVersion.get(version.id) ?? [],
    })),
    notes: notes.map((note) => ({
      id: note.id,
      targetNodeId: note.targetNodeId,
      targetReferenceId: note.targetReferenceId,
      targetAnchor: note.targetAnchorJson,
      content: note.richTextJson,
      plainText: note.plainText,
      schemaVersion: note.schemaVersion,
      revision: note.revision,
      latestVersionNumber: note.latestVersionNumber,
      createdAt: iso(note.createdAt),
      updatedAt: iso(note.updatedAt),
      deletedAt: isoOrNull(note.deletedAt),
      versions: versionsByNote.get(note.id) ?? [],
    })),
    highlights: highlights.map((highlight) => ({
      id: highlight.id,
      referenceId: highlight.referenceId,
      anchor: highlight.anchorJson,
      colorToken: highlight.colorToken,
      label: highlight.label,
      createdAt: iso(highlight.createdAt),
      updatedAt: iso(highlight.updatedAt),
      deletedAt: isoOrNull(highlight.deletedAt),
    })),
    events: events.map((event) => ({
      id: event.id,
      sequence: String(event.sequence),
      eventType: event.eventType,
      payload: event.payloadJson,
      occurredAt: iso(event.occurredAt),
    })),
  };
}
