'use client';

import type { ExportFormat, ExportResponse } from '@bible-artisan/contracts';
import { useMutation } from '@tanstack/react-query';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { downloadExport } from '@/lib/exports';

const FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: 'Markdown (readable outline)',
  json: 'JSON (complete, versioned)',
};

/** One export request: the format and the Idempotency-Key of the click that asked for it. */
interface ExportRequest {
  format: ExportFormat;
  idempotencyKey: string;
}

/**
 * Export buttons (BIB-47, BIB-48): one per format. Each asks the API for the export, then starts
 * the download through its signed link. The button says when the export is being prepared and an
 * alert offers Retry when it fails; nothing is downloaded until the server has made the file.
 * Every click gets a new Idempotency-Key and Retry resends that click's key, so a retry after a
 * lost response gets the export already made rather than a second one.
 */
export function ExportControls({
  label,
  create,
  copy,
  description,
}: {
  /** The section's accessible name, e.g. "Export this study". */
  label: string;
  create: (format: ExportFormat, idempotencyKey: string) => Promise<ExportResponse>;
  copy: ProblemCopy;
  description?: string;
}) {
  const exporting = useMutation({
    mutationFn: ({ format, idempotencyKey }: ExportRequest) => create(format, idempotencyKey),
    onSuccess: (created) => downloadExport(created),
  });
  const busy = exporting.isPending;
  const buttonClass = 'rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60';

  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 className="font-serif text-xl">{label}</h2>
      {description ? <p className="text-sm text-muted">{description}</p> : null}
      <div className="flex flex-wrap gap-3">
        {(['markdown', 'json'] as const).map((format) => (
          <button
            key={format}
            type="button"
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (!busy) exporting.mutate({ format, idempotencyKey: crypto.randomUUID() });
            }}
            className={buttonClass}
          >
            Export as {FORMAT_LABELS[format]}
          </button>
        ))}
      </div>
      <p role="status" className="text-sm">
        {busy
          ? 'Preparing your export…'
          : exporting.isSuccess
            ? 'Your export is ready. The download should start now.'
            : ''}
      </p>
      {exporting.isError ? (
        <ProblemAlert
          error={exporting.error}
          copy={copy}
          onRetry={() => exporting.variables && exporting.mutate(exporting.variables)}
        />
      ) : null}
    </section>
  );
}
