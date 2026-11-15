'use client';

import { ACCOUNT_PURGE_WITHIN_DAYS, type MeResponse } from '@bible-artisan/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ProblemAlert, type ProblemCopy } from '@/components/bible/problem-alert';
import { ExportControls } from '@/components/exports/export-controls';
import { ApiError } from '@/lib/api-client';
import { startOtp } from '@/lib/auth';
import { clearLocalAccountData, createAccountExport, deleteAccount } from '@/lib/exports';

const EXPORT_COPY: ProblemCopy = {
  notFound: "Couldn't export your account.",
  refused: "Couldn't export your account.",
  unavailable: "Couldn't export your account.",
};
const SEND_COPY: ProblemCopy = {
  notFound: "Couldn't send a confirmation code.",
  refused: "Couldn't send a confirmation code.",
  unavailable: "Couldn't send a confirmation code.",
};
const DELETE_COPY: ProblemCopy = {
  notFound: "Couldn't delete your account.",
  refused: "Couldn't delete your account.",
  unavailable: "Couldn't delete your account.",
};

/** The code refusals said in fixed copy (the server's message is never shown). */
const CODE_ERRORS: Record<string, string> = {
  OTP_INVALID: 'That code is not correct. Check the latest email and try again.',
  OTP_EXPIRED: 'That code has expired or was already used. Send a new code.',
  OTP_ATTEMPTS_EXHAUSTED: 'Too many attempts for this code. Send a new code.',
};

/**
 * The account's data on Settings (BIB-48): export everything, or delete the account. Deletion
 * needs a fresh code sent to the account's email (PRD section 29). On success every cached private
 * response and this browser's local storage are cleared and the user lands on sign-in; downloaded
 * exports stay under their control.
 */
export function AccountDataSettings({ me }: { me: MeResponse }) {
  return (
    <>
      <ExportControls
        label="Export all your data"
        description="Every study with its notes, versions and history, and your account details."
        create={createAccountExport}
        copy={EXPORT_COPY}
      />
      <DeleteAccount me={me} />
    </>
  );
}

function DeleteAccount({ me }: { me: MeResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const codeId = useId();
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const send = useMutation({
    mutationFn: () => startOtp(me.email),
    onSuccess: (started) => {
      setChallengeId(started.challengeId);
      setCode('');
    },
  });
  const remove = useMutation({
    mutationFn: (input: { challengeId: string; code: string }) =>
      deleteAccount(input.challengeId, input.code),
    onSuccess: () => {
      // Nothing private stays in this browser (PRD section 29).
      queryClient.clear();
      clearLocalAccountData();
      router.replace('/sign-in');
    },
  });

  const codeError =
    remove.error instanceof ApiError ? CODE_ERRORS[remove.error.code ?? ''] : undefined;
  const buttonClass = 'rounded border border-accent px-3 py-1 text-accent aria-disabled:opacity-60';

  return (
    <section aria-labelledby={`${codeId}-heading`} className="flex flex-col gap-3">
      <h2 id={`${codeId}-heading`} className="font-serif text-xl">
        Delete your account
      </h2>
      <p>
        This permanently deletes your account, every study, note and export. You are signed out
        everywhere at once, and your data is removed within {ACCOUNT_PURGE_WITHIN_DAYS} days. It
        can&apos;t be undone. Files you already downloaded stay with you.
      </p>
      <div>
        <button
          type="button"
          aria-disabled={send.isPending ? true : undefined}
          onClick={() => {
            if (!send.isPending) send.mutate();
          }}
          className={buttonClass}
        >
          {challengeId ? 'Send a new code' : 'Email me a confirmation code'}
        </button>
      </div>
      {send.isError ? (
        <ProblemAlert error={send.error} copy={SEND_COPY} onRetry={() => send.mutate()} />
      ) : null}
      {challengeId ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!remove.isPending) remove.mutate({ challengeId, code: code.trim() });
          }}
        >
          <p role="status">We sent a 6-digit code to {me.email}.</p>
          <label htmlFor={codeId} className="font-medium">
            Confirmation code
          </label>
          <input
            id={codeId}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? `${codeId}-error` : undefined}
            className="w-40 rounded border border-muted px-2 py-1"
          />
          {codeError ? (
            <p id={`${codeId}-error`} role="alert">
              {codeError}
            </p>
          ) : remove.isError ? (
            <ProblemAlert error={remove.error} copy={DELETE_COPY} />
          ) : null}
          <div>
            <button
              type="submit"
              aria-disabled={remove.isPending ? true : undefined}
              className="rounded bg-accent px-3 py-1 text-canvas aria-disabled:opacity-60"
            >
              Permanently delete my account
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
