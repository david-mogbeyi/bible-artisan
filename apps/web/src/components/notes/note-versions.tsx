'use client';

import type { NoteDocument } from '@bible-artisan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  fetchNoteVersion,
  formatNoteTime,
  listNoteVersions,
  noteVersionsQueryKey,
} from '@/lib/notes';
import { NoteContent } from './note-content';

/**
 * A note's kept versions (BIB-23), newest first, behind a disclosure so nothing loads until the
 * user asks. Opening a version renders it read-only; "Restore this version" puts its content back
 * in the editor and saves it as a new version (versions are never rewritten).
 */
export function NoteVersions({
  studyId,
  noteId,
  canRestore,
  onRestore,
}: {
  studyId: string;
  noteId: string;
  canRestore: boolean;
  onRestore: (content: NoteDocument) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const versions = useQuery({
    queryKey: noteVersionsQueryKey(studyId, noteId),
    queryFn: () => listNoteVersions(studyId, noteId),
    enabled: open,
  });
  const version = useQuery({
    queryKey: [...noteVersionsQueryKey(studyId, noteId), selected],
    queryFn: () => fetchNoteVersion(studyId, noteId, selected ?? ''),
    enabled: selected !== null,
  });

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="self-start text-accent underline"
      >
        Versions
      </button>
      {open ? (
        <div id={listId} className="flex flex-col gap-2">
          {versions.isError ? (
            <p role="alert">
              Couldn&apos;t load the versions.{' '}
              <button type="button" onClick={() => void versions.refetch()} className="underline">
                Retry
              </button>
            </p>
          ) : !versions.data ? (
            <p role="status">Loading versions…</p>
          ) : (
            <ul aria-label="Versions" className="flex flex-col gap-1">
              {versions.data.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(item.id)}
                    className="text-left underline aria-pressed:font-semibold"
                  >
                    Version {item.versionNumber}, {formatNoteTime(item.createdAt)}
                  </button>
                  <span className="block text-sm text-muted">{item.preview || 'Empty'}</span>
                </li>
              ))}
            </ul>
          )}
          {selected !== null && version.data ? (
            <div className="flex flex-col gap-2 rounded border border-muted p-3">
              <NoteContent
                doc={version.data.content}
                label={`Version ${version.data.versionNumber}`}
              />
              {canRestore ? (
                <button
                  type="button"
                  onClick={() => onRestore(version.data.content)}
                  className="self-start rounded border border-accent px-3 py-1 text-accent"
                >
                  Restore this version
                </button>
              ) : null}
            </div>
          ) : selected !== null && version.isError ? (
            <p role="alert">Couldn&apos;t load this version.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
