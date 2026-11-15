import type { StudyExport } from '@bible-artisan/contracts';

type ExportNode = StudyExport['nodes'][number];

const TYPE_HEADINGS: Record<string, string> = {
  question: 'Questions',
  scripture: 'Scripture',
  observation: 'Observations',
  thought: 'Thoughts',
  conclusion: 'Conclusions',
  source: 'Sources',
};
const TYPE_ORDER = ['question', 'scripture', 'observation', 'conclusion', 'thought', 'source'];

/** Words for an enum value, e.g. `supported_by` -> `supported by`. */
const words = (value: string): string => value.replaceAll('_', ' ');

/** One line of user text as Markdown: line breaks kept, leading block syntax neutralized. */
function inline(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').trim();
}

/** A multi-line block of user text, each line quoted so it can never become a heading. */
function quoted(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Renders a study export as a readable Markdown outline (FR-EXPORT-002; PRD section 29): the
 * study, Scripture with its edition attribution, every item grouped by type with its status and
 * relationships, conclusion versions with their evidence, notes, highlights, and the chronological
 * Study Thread. Deleted items and evidence that is no longer available are labeled, never
 * silently dropped. Scripture text appears only when the edition permits export; otherwise the
 * reference stays with a label saying the text was left out.
 */
export function renderStudyMarkdown(data: StudyExport, exportedAt: string): string {
  const out: string[] = [];
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const scripture = new Map(data.scripture.map((passage) => [passage.referenceId, passage]));

  const nodeLabel = (node: ExportNode | undefined): string => {
    if (!node) return 'Unavailable item';
    const reference = node.scriptureReferenceId ? scripture.get(node.scriptureReferenceId) : null;
    const text =
      node.title ?? node.body ?? reference?.label ?? (node.source?.url as string | undefined);
    const label = text ? inline(text).slice(0, 120) : words(node.type);
    return node.deletedAt ? `${label} (deleted, unavailable)` : label;
  };

  out.push(`# ${inline(data.study.title)}`, '');
  out.push(
    `Exported from Bible Artisan on ${exportedAt}. Study revision ${data.basis.revision}, content revision ${data.basis.contentRevision}, through Study Thread event ${data.basis.lastEventSequence}.`,
    '',
  );
  out.push(`- Status: ${data.study.lifecycle}`);
  if (data.study.tags.length > 0) out.push(`- Tags: ${data.study.tags.map(inline).join(', ')}`);
  const main = data.study.mainQuestionNodeId ? nodes.get(data.study.mainQuestionNodeId) : undefined;
  if (main) out.push(`- Main question: ${nodeLabel(main)}`);
  if (data.study.startingReferenceId) {
    const start = scripture.get(data.study.startingReferenceId);
    if (start) out.push(`- Starting passage: ${start.label} (${start.edition.abbreviation})`);
  }
  if (data.study.description) out.push('', quoted(data.study.description));
  out.push('');

  if (data.scripture.length > 0) {
    out.push('## Scripture', '');
    for (const passage of data.scripture) {
      out.push(`### ${passage.label} (${passage.edition.abbreviation})`, '');
      if (passage.text) {
        out.push(quoted(passage.text.map((verse) => `${verse.verse} ${verse.text}`).join(' ')));
      } else if (passage.textOmitted === 'rights') {
        out.push("_Text not included: this translation's rights do not permit export._");
      } else {
        out.push('_Text unavailable: this translation is no longer available._');
      }
      out.push('', `_${passage.edition.attribution}_`, '');
    }
  }

  const edgesFrom = (nodeId: string) =>
    data.edges.filter(
      (edge) =>
        edge.deletedAt === null && (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId),
    );

  for (const type of TYPE_ORDER) {
    const ofType = data.nodes.filter((node) => node.type === type);
    if (ofType.length === 0) continue;
    out.push(`## ${TYPE_HEADINGS[type] ?? words(type)}`, '');
    for (const node of ofType) {
      const status = [
        node.questionStatus ? `status: ${words(node.questionStatus)}` : null,
        node.conclusionStatus ? `status: ${words(node.conclusionStatus)}` : null,
        node.observationKind ? `kind: ${words(node.observationKind)}` : null,
        node.establishedAt ? 'established by me' : null,
        node.origin === 'ai' ? 'origin: AI suggestion accepted by me' : null,
        node.deletedAt ? 'deleted' : null,
      ].filter(Boolean);
      out.push(`### ${nodeLabel(node)}${status.length > 0 ? ` (${status.join('; ')})` : ''}`, '');
      if (node.title && node.body) out.push(quoted(node.body), '');
      if (node.source) {
        const source = node.source;
        const parts = [
          source.kind,
          source.author,
          source.workTitle,
          source.publicationDetails,
          source.locator,
          source.url,
        ]
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .map(inline);
        if (parts.length > 0) out.push(`Source: ${parts.join(', ')}`, '');
        if (typeof source.excerpt === 'string') out.push(quoted(source.excerpt), '');
      }
      const relationships = edgesFrom(node.id);
      if (relationships.length > 0) {
        out.push('Relationships:');
        for (const edge of relationships) {
          const outgoing = edge.sourceNodeId === node.id;
          const other = nodes.get(outgoing ? edge.targetNodeId : edge.sourceNodeId);
          const arrow = outgoing ? `${words(edge.type)} →` : `← ${words(edge.type)}`;
          const note = edge.note ? ` — ${inline(edge.note)}` : '';
          // AI origin and the user's adoption stay distinct in the export (FR-AI-013).
          const origin = edge.origin === 'ai' ? ' (origin: AI suggestion; adopted by me)' : '';
          out.push(`- ${arrow} ${nodeLabel(other)}${origin}${note}`);
        }
        out.push('');
      }
      if (node.type === 'conclusion') renderVersions(out, data, node.id, nodes, nodeLabel);
    }
  }

  const liveNotes = data.notes.filter((note) => note.deletedAt === null);
  if (liveNotes.length > 0) {
    out.push('## Notes', '');
    for (const note of liveNotes) {
      const target = note.targetNodeId
        ? `On: ${nodeLabel(nodes.get(note.targetNodeId))}`
        : note.targetReferenceId
          ? `On: ${scripture.get(note.targetReferenceId)?.label ?? 'Unavailable passage'}`
          : 'Study note';
      out.push(`### ${target}`, '', note.plainText ? quoted(note.plainText) : '_Empty note_', '');
    }
  }

  const liveHighlights = data.highlights.filter((highlight) => highlight.deletedAt === null);
  if (liveHighlights.length > 0) {
    out.push('## Highlights', '');
    for (const highlight of liveHighlights) {
      const passage = scripture.get(highlight.referenceId);
      const label = highlight.label ? ` — ${inline(highlight.label)}` : '';
      out.push(`- ${passage?.label ?? 'Unavailable passage'} (${highlight.colorToken})${label}`);
    }
    out.push('');
  }

  if (data.branches.length > 0) {
    out.push('## Branches', '');
    for (const branch of data.branches) {
      out.push(
        `- From ${nodeLabel(nodes.get(branch.rootNodeId))}: ${branch.memberNodeIds.length} item(s)`,
      );
    }
    out.push('');
  }

  out.push('## Study Thread', '');
  if (data.events.length === 0) out.push('_No events yet._');
  for (const event of data.events) {
    const subject =
      typeof event.payload.nodeId === 'string' ? nodes.get(event.payload.nodeId) : null;
    out.push(
      `${event.sequence}. ${event.occurredAt} — ${words(event.eventType)}${subject ? `: ${nodeLabel(subject)}` : ''}`,
    );
  }
  out.push('');
  return out.join('\n');
}

function renderVersions(
  out: string[],
  data: StudyExport,
  nodeId: string,
  nodes: Map<string, ExportNode>,
  nodeLabel: (node: ExportNode | undefined) => string,
): void {
  const versions = data.conclusionVersions.filter((version) => version.nodeId === nodeId);
  if (versions.length === 0) return;
  out.push('Versions:');
  for (const version of versions) {
    const marker = version.established ? ', established by me' : '';
    out.push(
      `- Version ${version.versionNumber} (${words(version.action)}, ${words(version.conclusionStatus)}${marker}, ${version.createdAt}): ${inline(version.statement)}`,
    );
    if (version.changeReason) out.push(`  - Reason: ${inline(version.changeReason)}`);
    for (const item of version.evidence) {
      const evidence = nodes.get(item.nodeId);
      const edge = data.edges.find((candidate) => candidate.id === item.edgeId);
      const missing = !evidence || evidence.deletedAt !== null || !edge || edge.deletedAt !== null;
      out.push(
        `  - ${item.role === 'supporting' ? 'Supporting' : 'Challenging'} evidence (${words(item.edgeType)}): ${missing ? `${nodeLabel(evidence)} [evidence unavailable]` : nodeLabel(evidence)}`,
      );
    }
  }
  out.push('');
}
