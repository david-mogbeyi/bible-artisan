'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { ME_QUERY_KEY, startOtp, verifyOtp } from '@/lib/auth';
import { safeNext } from '@/lib/safe-next';

const ERROR_COPY: Record<string, string> = {
  OTP_INVALID: "That code isn't right. Check the email and try again.",
  OTP_EXPIRED: 'That code has expired or was already used. Request a new code.',
  OTP_ATTEMPTS_EXHAUSTED: 'Too many attempts for this code. Request a new code.',
  RATE_LIMITED: 'Please wait before requesting another code.',
  VALIDATION: 'Check what you entered and try again.',
};
const GENERIC_ERROR = 'Something went wrong. Try again.';

function messageFor(error: unknown): string {
  return (error instanceof ApiError && error.code && ERROR_COPY[error.code]) || GENERIC_ERROR;
}

/** Seconds until `at` (ms epoch), rounded up; 0 once reached. */
function secondsUntil(at: number | null, now: number): number {
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Email OTP sign-in (FR-AUTH-001/002, PRD §11/§29). Two steps: email, then the 6-digit code.
 * Errors are announced in an alert that takes focus; typed input is never cleared by an error.
 * Paste and one-time-code autofill are allowed (WCAG 2.2 accessible authentication).
 */
export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const ids = { email: useId(), code: useId(), hint: useId() };

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  // Bumped on every failure so a repeated identical message still moves focus to the alert.
  const [errorCount, setErrorCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const errorRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const waitSeconds = secondsUntil(resendAt, now);

  useEffect(() => {
    if (resendAt === null || resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error, errorCount]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const send = useMutation({
    mutationFn: () => startOtp(email),
    onSuccess: (result) => {
      setChallengeId(result.challengeId);
      setResendAt(Date.parse(result.resendAvailableAt));
      setNow(Date.now());
      setError(null);
      if (step === 'code') {
        setCode('');
        setNotice('A new code was sent.');
        codeRef.current?.focus();
      } else {
        setStep('code');
      }
    },
    onError: (err) => {
      setNotice(null);
      if (err instanceof ApiError && err.retryAfterSeconds) {
        setResendAt(Date.now() + err.retryAfterSeconds * 1000);
        setNow(Date.now());
      }
      setError(messageFor(err));
      setErrorCount((count) => count + 1);
    },
  });

  const verify = useMutation({
    mutationFn: () => verifyOtp(challengeId ?? '', code),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_QUERY_KEY, me);
      router.replace(safeNext(searchParams.get('next')));
    },
    onError: (err) => {
      setNotice(null);
      setError(messageFor(err));
      setErrorCount((count) => count + 1);
    },
  });

  function onSubmitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waitSeconds > 0) return;
    send.mutate();
  }

  function onSubmitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    verify.mutate();
  }

  function changeEmail() {
    setStep('email');
    setCode('');
    setChallengeId(null);
    // The resend window is per email; a different address may be sent to right away.
    setResendAt(null);
    setError(null);
    setNotice(null);
  }

  const countdown =
    waitSeconds > 0 ? (
      <p className="text-sm text-muted">You can request a new code in {waitSeconds} s.</p>
    ) : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-16">
      <h1 className="font-serif text-4xl">Sign in</h1>

      {error ? (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="rounded border border-accent px-3 py-2 text-ink"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}

      {step === 'email' ? (
        <form onSubmit={onSubmitEmail} className="flex flex-col gap-3" noValidate>
          <label htmlFor={ids.email} className="font-medium">
            Email address
          </label>
          <input
            id={ids.email}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-muted bg-white px-3 py-2"
          />
          {countdown}
          <button
            type="submit"
            disabled={send.isPending || waitSeconds > 0}
            className="rounded bg-accent px-4 py-2 text-white disabled:opacity-60"
          >
            {send.isPending ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={onSubmitCode} className="flex flex-col gap-3" noValidate>
          <p id={ids.hint}>Enter the 6-digit code sent to {email}.</p>
          <label htmlFor={ids.code} className="font-medium">
            Sign-in code
          </label>
          <input
            ref={codeRef}
            id={ids.code}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-describedby={ids.hint}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded border border-muted bg-white px-3 py-2 tracking-widest"
          />
          <button
            type="submit"
            disabled={verify.isPending}
            className="rounded bg-accent px-4 py-2 text-white disabled:opacity-60"
          >
            {verify.isPending ? 'Signing in…' : 'Sign in'}
          </button>
          {countdown}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => send.mutate()}
              disabled={send.isPending || waitSeconds > 0}
              className="rounded border border-accent px-4 py-2 text-accent disabled:opacity-60"
            >
              Send a new code
            </button>
            <button
              type="button"
              onClick={changeEmail}
              className="rounded px-4 py-2 text-accent underline"
            >
              Use a different email
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
