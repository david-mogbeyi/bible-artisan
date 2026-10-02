'use client';

import {
  EXCERPT_KIND_NAMES,
  EXCERPT_KINDS,
  type ExcerptKind,
  MAX_SOURCE_AUTHOR_LENGTH,
  MAX_SOURCE_EXCERPT_LENGTH,
  MAX_SOURCE_LOCATOR_LENGTH,
  MAX_SOURCE_PUBLICATION_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  MAX_SOURCE_WORK_TITLE_LENGTH,
  type Source,
  SOURCE_KIND_NAMES,
  SOURCE_KINDS,
  type SourceInput,
  type SourceKind,
} from '@bible-artisan/contracts';
import { type Ref, useId } from 'react';
import type { z } from 'zod';

/**
 * Field pieces shared by the Add node form and the Edit form (BIB-25). Every message is fixed
 * copy chosen from the rule that failed, never the server's text or the user's input.
 */

/** Field errors keyed by the request path (`text`, `source.url`, ...). */
export type FieldErrors = Record<string, string>;

/** One message per field from a failed parse of the shared contract schema. */
export function fieldErrorsOf(issues: z.ZodError['issues']): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (errors[key]) continue;
    errors[key] = key.endsWith('url')
      ? 'Enter a link that starts with http:// or https://.'
      : issue.code === 'custom'
        ? `${issue.message}.`
        : issue.code === 'too_big'
          ? `Use at most ${Number(issue.maximum).toLocaleString('en-US')} characters.`
          : issue.code === 'too_small'
            ? 'This field is required.'
            : 'Check this field.';
  }
  return errors;
}

/** "12 / 4,000 characters", counted as the server counts (after trimming). */
export function counterText(text: string, max: number): string {
  return `${text.trim().length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} characters`;
}

/** A labelled multi-line text field with a live length counter and an inline error. */
export function TextAreaField({
  label,
  value,
  onChange,
  max,
  error,
  rows = 4,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  error?: string;
  rows?: number;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <textarea
        id={id}
        ref={inputRef}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-count${error ? ` ${id}-error` : ''}`}
        className="w-full rounded border border-muted bg-canvas px-2 py-1"
      />
      <p id={`${id}-count`} className="text-sm text-muted">
        {counterText(value, max)}
      </p>
      {error ? (
        <p id={`${id}-error`} className="text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  error,
  hint,
  max,
  required = false,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  max: number;
  required?: boolean;
  type?: 'text' | 'url';
}) {
  const id = useId();
  // The limit is stated before anything is refused (PRD section 15).
  const help = `${hint ? `${hint} ` : ''}Up to ${max.toLocaleString('en-US')} characters.`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        className="w-full rounded border border-muted bg-canvas px-2 py-1"
      />
      <p id={`${id}-hint`} className="text-sm text-muted">
        {help}
      </p>
      {error ? (
        <p id={`${id}-error`} className="text-accent">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The Source form's state: every field as typed (empty means absent). */
export interface SourceDraft {
  title: string;
  kind: SourceKind;
  author: string;
  workTitle: string;
  publicationDetails: string;
  url: string;
  locator: string;
  excerpt: string;
  excerptKind: ExcerptKind | '';
}

export const EMPTY_SOURCE: SourceDraft = {
  title: '',
  kind: 'book',
  author: '',
  workTitle: '',
  publicationDetails: '',
  url: '',
  locator: '',
  excerpt: '',
  excerptKind: '',
};

export function sourceDraftOf(source: Source): SourceDraft {
  return {
    title: source.title,
    kind: source.kind,
    author: source.author ?? '',
    workTitle: source.workTitle ?? '',
    publicationDetails: source.publicationDetails ?? '',
    url: source.url ?? '',
    locator: source.locator ?? '',
    excerpt: source.excerpt ?? '',
    excerptKind: source.excerptKind ?? '',
  };
}

/** The request's citation: empty optional fields are left for the schema to drop. */
export function sourceInputOf(draft: SourceDraft): SourceInput {
  const { excerptKind, ...rest } = draft;
  return excerptKind === '' ? rest : { ...rest, excerptKind };
}

/** The citation fields (Title and Kind required; a URL or a locator). */
export function SourceFields({
  value,
  onChange,
  errors,
}: {
  value: SourceDraft;
  onChange: (value: SourceDraft) => void;
  errors: FieldErrors;
}) {
  const id = useId();
  const set = <K extends keyof SourceDraft>(key: K, next: SourceDraft[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <div className="flex flex-col gap-3">
      <InputField
        label="Title"
        required
        value={value.title}
        onChange={(next) => set('title', next)}
        max={MAX_SOURCE_TITLE_LENGTH}
        error={errors['source.title']}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-kind`} className="font-medium">
          Kind<span aria-hidden="true"> *</span>
        </label>
        <select
          id={`${id}-kind`}
          value={value.kind}
          onChange={(event) => set('kind', event.target.value as SourceKind)}
          className="rounded border border-muted bg-canvas px-2 py-1"
        >
          {SOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {SOURCE_KIND_NAMES[kind]}
            </option>
          ))}
        </select>
      </div>
      <InputField
        label="Author"
        value={value.author}
        onChange={(next) => set('author', next)}
        max={MAX_SOURCE_AUTHOR_LENGTH}
        error={errors['source.author']}
      />
      <InputField
        label="Work title"
        value={value.workTitle}
        onChange={(next) => set('workTitle', next)}
        max={MAX_SOURCE_WORK_TITLE_LENGTH}
        error={errors['source.workTitle']}
      />
      <InputField
        label="Publication details"
        value={value.publicationDetails}
        onChange={(next) => set('publicationDetails', next)}
        max={MAX_SOURCE_PUBLICATION_LENGTH}
        error={errors['source.publicationDetails']}
      />
      <p id={`${id}-where`} className="text-sm text-muted">
        Add a URL or a locator.
      </p>
      <InputField
        label="URL"
        type="url"
        value={value.url}
        onChange={(next) => set('url', next)}
        max={2048}
        hint="An http or https link. It is saved as you typed it and never opened by the app."
        error={errors['source.url']}
      />
      <InputField
        label="Locator"
        value={value.locator}
        onChange={(next) => set('locator', next)}
        max={MAX_SOURCE_LOCATOR_LENGTH}
        hint="A page, section or paragraph."
        error={errors['source.locator']}
      />
      <TextAreaField
        label="Excerpt"
        value={value.excerpt}
        onChange={(next) => set('excerpt', next)}
        max={MAX_SOURCE_EXCERPT_LENGTH}
        error={errors['source.excerpt']}
        rows={3}
      />
      <fieldset
        className="flex flex-col gap-1"
        aria-describedby={errors['source.excerptKind'] ? `${id}-excerpt-kind-error` : undefined}
      >
        <legend className="font-medium">The excerpt is a</legend>
        <div className="flex flex-wrap gap-4">
          {EXCERPT_KINDS.map((kind) => (
            <label key={kind} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-excerpt-kind`}
                value={kind}
                checked={value.excerptKind === kind}
                onChange={() => set('excerptKind', kind)}
              />
              {EXCERPT_KIND_NAMES[kind]}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted">Required when there is an excerpt.</p>
        {errors['source.excerptKind'] ? (
          <p id={`${id}-excerpt-kind-error`} className="text-accent">
            {errors['source.excerptKind']}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
