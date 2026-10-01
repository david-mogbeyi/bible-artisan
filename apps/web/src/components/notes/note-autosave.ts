import {
  MAX_NOTE_CHARACTERS,
  NOTE_TRASHED,
  NOTE_UNCHANGED,
  noteCharacterCount,
  type NoteDocument,
  type NoteMutationResponse,
  notePlainText,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  type UpdateNoteRequest,
} from '@bible-artisan/contracts';
import { ApiError } from '@/lib/api-client';

/** PRD section 27: text saves after 750 ms idle, at most five seconds after the first change. */
export const AUTOSAVE_IDLE_MS = 750;
export const AUTOSAVE_MAX_DELAY_MS = 5000;

/**
 * What the editor shows about saving (PRD section 27 save indicator). Only `saved` says Saved,
 * and only once the server acknowledged the latest content (NFR-REL-001).
 */
export type SaveState =
  | { kind: 'saved' }
  /** Edited, waiting for the idle delay. */
  | { kind: 'pending' }
  | { kind: 'saving' }
  /** The outcome is unknown (network, 5xx, 429, 503): Retry resends the identical request. */
  | { kind: 'failed'; error: unknown }
  /** 409: the note changed elsewhere. Autosave stops; the draft stays. */
  | { kind: 'conflict' }
  /** Over the character limit: nothing is sent; the draft stays. */
  | { kind: 'too_long' }
  /** The document fails the allowlist (should not happen with the restricted editor). */
  | { kind: 'invalid' }
  /** The study was archived or trashed, or the note trashed, elsewhere. Autosave stops. */
  | { kind: 'locked'; code: typeof STUDY_ARCHIVED | typeof STUDY_TRASHED | typeof NOTE_TRASHED }
  /** 404: the note or study is gone. */
  | { kind: 'gone' }
  /** "Save version" when the newest version already holds this content. */
  | { kind: 'already_versioned' };

/** One PATCH as sent: frozen until its outcome is known, so a retry is byte-identical. */
interface Attempt {
  key: string;
  body: UpdateNoteRequest;
}

export interface NoteAutosaveOptions {
  /** The note as last loaded: its revision and content are the starting point. */
  revision: number;
  content: NoteDocument;
  send: (body: UpdateNoteRequest, idempotencyKey: string) => Promise<NoteMutationResponse>;
  onState: (state: SaveState) => void;
  /** After every acknowledged save (refresh lists, versions, library). */
  onSaved: (response: NoteMutationResponse) => void;
  newKey?: () => string;
}

/** JSON with object keys sorted, so documents compare by value whatever built them. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, current: unknown) =>
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : current,
  );

const sameContent = (a: NoteDocument, b: NoteDocument): boolean => canonical(a) === canonical(b);

export const characterCount = (doc: NoteDocument): number => noteCharacterCount(notePlainText(doc));

/**
 * Autosave for one open note (BIB-23; PRD section 27). One request in flight at a time; edits made
 * meanwhile are sent next, coalesced into one request. Each request is frozen with its
 * Idempotency-Key until its outcome is known: after an unknown outcome the identical request is
 * resent first (on Retry, or on the next save), so a save that committed but lost its response is
 * replayed rather than applied twice or refused with 409. A definite refusal (4xx) discards it.
 * Nothing is ever kept in browser storage (offline queueing is BIB-36).
 */
export class NoteAutosave {
  private revision: number;
  /** The content the server holds, as far as this editor knows. */
  private acknowledged: NoteDocument;
  /** The editor's current content (null when it fails the allowlist). */
  private latest: NoteDocument | null;
  private inFlight: Attempt | null = null;
  private frozen: Attempt | null = null;
  private checkpointWanted = false;
  /** Autosave is stopped by a conflict, a lifecycle refusal or a 404 until the user acts. */
  private stopped = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SaveState = { kind: 'saved' };
  private readonly newKey: () => string;

  constructor(private readonly options: NoteAutosaveOptions) {
    this.revision = options.revision;
    this.acknowledged = options.content;
    this.latest = options.content;
    this.newKey = options.newKey ?? (() => crypto.randomUUID());
  }

  get current(): SaveState {
    return this.state;
  }

  /** The note revision the next request is based on. */
  get currentRevision(): number {
    return this.revision;
  }

  /** True while something the user wrote is not acknowledged by the server. */
  get unsaved(): boolean {
    return (
      this.inFlight !== null ||
      this.frozen !== null ||
      this.latest === null ||
      !sameContent(this.latest, this.acknowledged)
    );
  }

  /** The editor changed: remember it and save after the idle delay. */
  edited(doc: NoteDocument | null): void {
    this.latest = doc;
    if (this.stopped) return;
    if (doc === null) return this.setState({ kind: 'invalid' });
    if (characterCount(doc) > MAX_NOTE_CHARACTERS) {
      this.clearTimers();
      return this.setState({ kind: 'too_long' });
    }
    if (!this.unsaved) return this.setState({ kind: 'saved' });
    if (this.inFlight === null) this.setState({ kind: 'pending' });
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flush(), AUTOSAVE_IDLE_MS);
    this.maxTimer ??= setTimeout(() => this.flush(), AUTOSAVE_MAX_DELAY_MS);
  }

  /** "Save version": save the current content now as a checkpoint. */
  checkpoint(): void {
    this.checkpointWanted = true;
    this.flush();
  }

  /** Saves now: resends a frozen request first, else sends the latest content if unsaved. */
  flush(): void {
    this.clearTimers();
    if (this.stopped || this.inFlight !== null) return;
    let attempt = this.frozen;
    if (attempt === null) {
      const doc = this.latest;
      if (doc === null) return this.setState({ kind: 'invalid' });
      if (characterCount(doc) > MAX_NOTE_CHARACTERS) return this.setState({ kind: 'too_long' });
      const checkpoint = this.checkpointWanted;
      if (!checkpoint && sameContent(doc, this.acknowledged)) {
        return this.setState({ kind: 'saved' });
      }
      attempt = {
        key: this.newKey(),
        body: {
          expectedRevision: this.revision,
          content: doc,
          ...(checkpoint ? { checkpoint: true as const } : {}),
        },
      };
      this.checkpointWanted = false;
    }
    this.inFlight = attempt;
    this.frozen = attempt;
    this.setState({ kind: 'saving' });
    const sent = attempt;
    this.options.send(sent.body, sent.key).then(
      (response) => this.succeeded(sent, response),
      (error: unknown) => this.failed(sent, error),
    );
  }

  /**
   * After a conflict: continue from the server's current revision with this editor's content,
   * saved as a new checkpoint ("Keep mine": an explicit choice, with a new key).
   */
  keepMine(serverRevision: number): void {
    this.revision = serverRevision;
    this.frozen = null;
    this.stopped = false;
    this.checkpointWanted = true;
    this.flush();
  }

  /** The editor now shows `content` as the server holds it at `revision` ("Reload latest"). */
  reset(revision: number, content: NoteDocument): void {
    this.clearTimers();
    this.revision = revision;
    this.acknowledged = content;
    this.latest = content;
    this.frozen = null;
    this.stopped = false;
    this.checkpointWanted = false;
    this.setState({ kind: 'saved' });
  }

  /** Replaces the content (restoring a version) and saves it at once as a checkpoint. */
  restore(content: NoteDocument): void {
    this.latest = content;
    this.checkpoint();
  }

  /** The editor is closing or unmounting: send what is unsaved, then stop the timers. */
  dispose(): void {
    if (this.unsaved && this.inFlight === null) this.flush();
    this.clearTimers();
  }

  private succeeded(attempt: Attempt, response: NoteMutationResponse): void {
    this.inFlight = null;
    if (this.frozen === attempt) this.frozen = null;
    this.revision = response.revision;
    if (attempt.body.content) this.acknowledged = attempt.body.content;
    this.options.onSaved(response);
    if (this.checkpointWanted || this.unsaved) this.flush();
    else this.setState({ kind: 'saved' });
  }

  private failed(attempt: Attempt, error: unknown): void {
    this.inFlight = null;
    const definite = error instanceof ApiError && error.status >= 400 && error.status < 500;
    const retryable = error instanceof ApiError && error.status === 429;
    if (definite && !retryable && this.frozen === attempt) this.frozen = null;
    if (!(error instanceof ApiError) || error.status >= 500 || retryable) {
      return this.setState({ kind: 'failed', error });
    }
    if (error.status === 409) {
      this.stopped = true;
      return this.setState({ kind: 'conflict' });
    }
    if (error.status === 404) {
      this.stopped = true;
      return this.setState({ kind: 'gone' });
    }
    if (error.status === 413) return this.setState({ kind: 'too_long' });
    if (error.status === 422) {
      const code = error.code;
      if (code === STUDY_ARCHIVED || code === STUDY_TRASHED || code === NOTE_TRASHED) {
        this.stopped = true;
        return this.setState({ kind: 'locked', code });
      }
      if (code === NOTE_UNCHANGED) {
        if (this.unsaved) return this.flush();
        return this.setState({ kind: 'already_versioned' });
      }
    }
    // Any other refusal (400): the content cannot be saved as it is.
    this.setState({ kind: 'invalid' });
  }

  private setState(state: SaveState): void {
    this.state = state;
    this.options.onState(state);
  }

  private clearTimers(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);
    this.idleTimer = null;
    this.maxTimer = null;
  }
}
