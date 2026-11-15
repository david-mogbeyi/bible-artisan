/**
 * Deterministic, human-readable thread copy (BIB-32; PRD section 13). Built only from what the
 * event recorded and the current labels of the things it names: it never states a motive that
 * was not recorded ("Opened Romans 8:16 from search", not "to check …").
 */

export interface DisplayRef {
  label: string | null;
  deleted: boolean;
  /** How to name it without a label, e.g. "a thought". */
  noun?: string;
}

export interface DisplayInput {
  type: string;
  payload: Record<string, unknown>;
  target: DisplayRef | null;
  origin: DisplayRef | null;
  /** The branch's root label, when the event names a branch. */
  branch: DisplayRef | null;
}

function name(ref: DisplayRef | null, fallback: string): string {
  if (!ref || ref.label === null) {
    const noun = ref?.noun ?? fallback;
    return ref?.deleted ? `${noun} (deleted)` : noun;
  }
  const quoted = `“${ref.label}”`;
  return ref.deleted ? `${quoted} (deleted)` : quoted;
}

function passage(payloadLabel: unknown, ref: DisplayRef | null): string {
  if (typeof payloadLabel === 'string' && payloadLabel.length > 0) return payloadLabel;
  return ref?.label ?? 'a passage';
}

const ORIGIN_COPY: Record<string, string> = {
  search: 'from search',
  reader: 'from the reader',
  study: 'from the study page',
  direct: 'directly',
};

function visitText({ payload, origin, branch }: DisplayInput): string {
  const opened = passage(payload.referenceLabel, null);
  const kind = typeof payload.originKind === 'string' ? payload.originKind : null;
  const investigating = branch?.label ? ` while investigating “${branch.label}”` : '';
  if (kind === 'node' || (kind === 'reader' && typeof payload.originReferenceLabel === 'string')) {
    const from =
      kind === 'node' ? name(origin, 'a node') : (payload.originReferenceLabel as string);
    return `From ${from}, followed ${opened}${investigating}`;
  }
  if (kind === 'event') return `Reopened ${opened} from an earlier thread event${investigating}`;
  const how = kind !== null && ORIGIN_COPY[kind] ? ` ${ORIGIN_COPY[kind]}` : '';
  return `Opened ${opened}${how}${investigating}`;
}

const SIMPLE: Record<string, (input: DisplayInput) => string> = {
  study_created: () => 'Started this study',
  study_renamed: () => 'Renamed the study',
  study_description_changed: (i) =>
    i.payload.cleared === true ? 'Cleared the description' : 'Changed the description',
  study_pinned: () => 'Pinned the study',
  study_unpinned: () => 'Unpinned the study',
  study_tags_changed: () => 'Changed the tags',
  study_archived: () => 'Archived the study',
  study_unarchived: () => 'Unarchived the study',
  study_trashed: () => 'Moved the study to the trash',
  study_restored: () => 'Restored the study from the trash',
  main_question_changed: (i) => `Made ${name(i.target, 'a question')} the main question`,
  question_created: (i) => `Asked ${name(i.target, 'a question')}`,
  question_status_changed: (i) => {
    const status = typeof i.payload.status === 'string' ? ` to ${i.payload.status}` : '';
    return `Changed the status of ${name(i.target, 'a question')}${status}`;
  },
  scripture_added_to_graph: (i) =>
    `Added ${passage(i.payload.referenceLabel, i.target)} to the graph`,
  scripture_revisited: (i) => `Returned to ${passage(i.payload.referenceLabel, i.target)}`,
  scripture_opened: visitText,
  observation_created: (i) => `Recorded ${name(i.target, 'an observation')}`,
  observation_updated: (i) =>
    i.payload.previousEstablished === true
      ? `Edited ${name(i.target, 'an observation')} (“Established by me” cleared)`
      : `Edited ${name(i.target, 'an observation')}`,
  observation_established: (i) => `Marked ${name(i.target, 'an observation')} “Established by me”`,
  node_deleted: (i) => `Deleted ${name(i.target, 'a node')}`,
  node_restored: (i) => `Restored ${name(i.target, 'a node')}`,
  thought_created: (i) => `Wrote ${name(i.target, 'a thought')}`,
  thought_updated: (i) => `Edited ${name(i.target, 'a thought')}`,
  source_created: (i) => `Added the source ${name(i.target, 'a source')}`,
  source_updated: (i) => `Edited the source ${name(i.target, 'a source')}`,
  conclusion_created: (i) => `Drafted the conclusion ${name(i.target, 'a conclusion')}`,
  conclusion_updated: (i) => `Revised the conclusion ${name(i.target, 'a conclusion')}`,
  conclusion_challenged: (i) => `Challenged the conclusion ${name(i.target, 'a conclusion')}`,
  conclusion_established: (i) => `Established the conclusion ${name(i.target, 'a conclusion')}`,
  conclusion_abandoned: (i) => `Abandoned the conclusion ${name(i.target, 'a conclusion')}`,
  conclusion_establishment_cleared: (i) =>
    `Cleared “Established by me” on ${name(i.target, 'a conclusion')}`,
  node_connected: (i) => {
    const type = typeof i.payload.edgeType === 'string' ? ` (${i.payload.edgeType})` : '';
    return `Connected ${name(i.origin, 'a node')} to ${name(i.target, 'a node')}${type}`;
  },
  edge_updated: () => 'Changed a relationship',
  edge_removed: (i) =>
    `Removed the relationship from ${name(i.origin, 'a node')} to ${name(i.target, 'a node')}`,
  branch_created: (i) => `Started a branch at ${name(i.target, 'a node')}`,
  branch_members_changed: () => 'Changed which nodes are in a branch',
  note_created: () => 'Wrote a note',
  note_autosaved: () => 'Saved a note',
  note_trashed: () => 'Moved a note to the trash',
  note_restored: () => 'Restored a note',
  highlight_created: () => 'Highlighted a passage',
  highlight_updated: () => 'Changed a highlight',
  highlight_deleted: () => 'Removed a highlight',
  node_position_saved: () => 'Moved nodes on the canvas',
  phrase_selected: (i) => `Selected text in ${passage(i.payload.referenceLabel, null)}`,
  search_performed: () => 'Searched the Bible',
  session_started: () => 'Started a study session',
  session_ended: (i) =>
    i.payload.reason === 'inactivity'
      ? 'Study session ended after 30 minutes without activity'
      : 'Ended the study session',
  view_state_saved: () => 'Saved the workspace view',
};

export function displayText(input: DisplayInput): string {
  const describe = SIMPLE[input.type];
  if (describe) return describe(input);
  const words = input.type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
