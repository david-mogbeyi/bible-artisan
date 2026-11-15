'use client';

import {
  AI_CONSENT_COPY,
  AI_CONSENT_VERSION,
  type AiConsentResponse,
  type UpdateAiConsentRequest,
} from '@bible-artisan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { AI_CONSENT_QUERY_KEY, fetchAiConsent, updateAiConsent } from '@/lib/ai';
import { ApiError } from '@/lib/api-client';

export const AI_UNAVAILABLE_TEXT =
  'AI features are not available yet. Every study feature works fully without them.';
export const AI_CHANGED_ELSEWHERE =
  'Your AI settings changed on another device. Review them and try again.';
export const AI_SAVE_FAILED = "We couldn't save your AI settings. Try again.";
export const AI_RENEWAL_NEEDED =
  'The AI terms have changed since you agreed. AI stays off until you review and agree again.';

/**
 * The account's AI consent (BIB-40, PRD section 29): what is sent, to whom, and how to turn it
 * off, then one explicit control. The state shown is always the server's: a change is reported
 * only after the API confirms it.
 */
export function AiConsentSettings() {
  const queryClient = useQueryClient();
  const consent = useQuery({ queryKey: AI_CONSENT_QUERY_KEY, queryFn: fetchAiConsent });
  const [notice, setNotice] = useState<string | null>(null);
  // One key per intended change, reused by retries of the same body.
  const attempt = useRef<{ json: string; key: string } | null>(null);

  const change = useMutation({
    mutationFn: (body: UpdateAiConsentRequest) => {
      const json = JSON.stringify(body);
      if (attempt.current?.json !== json) attempt.current = { json, key: crypto.randomUUID() };
      return updateAiConsent(body, attempt.current.key);
    },
    onSuccess: (saved) => {
      attempt.current = null;
      setNotice(
        saved.enabled
          ? 'AI features are on.'
          : saved.cancelledJobCount > 0
            ? `AI features are off. ${saved.cancelledJobCount} waiting AI ${saved.cancelledJobCount === 1 ? 'request was' : 'requests were'} cancelled.`
            : 'AI features are off.',
      );
      void queryClient.invalidateQueries({ queryKey: AI_CONSENT_QUERY_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        attempt.current = null;
        setNotice(AI_CHANGED_ELSEWHERE);
        void queryClient.invalidateQueries({ queryKey: AI_CONSENT_QUERY_KEY });
      } else {
        setNotice(AI_SAVE_FAILED);
      }
    },
  });

  return (
    <section aria-labelledby="ai-settings-heading" className="flex flex-col gap-4">
      <h2 id="ai-settings-heading" className="font-serif text-2xl">
        AI features
      </h2>
      {consent.isPending ? <p>Loading your AI settings…</p> : null}
      {consent.isError ? (
        <div role="alert" className="flex flex-col gap-2">
          <p>We couldn&apos;t load your AI settings.</p>
          <button
            type="button"
            onClick={() => void consent.refetch()}
            className="self-start rounded border border-accent px-3 py-1 text-accent"
          >
            Try again
          </button>
        </div>
      ) : null}
      {consent.data ? (
        <ConsentBody
          state={consent.data}
          saving={change.isPending}
          onChange={(enabled) =>
            change.mutate({
              expectedRevision: consent.data.revision,
              enabled,
              ...(enabled ? { consentVersion: AI_CONSENT_VERSION } : {}),
            })
          }
        />
      ) : null}
      <p role="status" className="min-h-6">
        {notice}
      </p>
    </section>
  );
}

function ConsentBody({
  state,
  saving,
  onChange,
}: {
  state: AiConsentResponse;
  saving: boolean;
  onChange: (enabled: boolean) => void;
}) {
  if (!state.providerAvailable) return <p>{AI_UNAVAILABLE_TEXT}</p>;
  return (
    <>
      <p>
        <strong>{state.enabled ? 'AI features are on.' : 'AI features are off.'}</strong>
      </p>
      {state.needsRenewal ? <p>{AI_RENEWAL_NEEDED}</p> : null}
      <dl className="flex flex-col gap-2">
        <dt className="font-semibold">What AI is for</dt>
        <dd>{AI_CONSENT_COPY.purpose}</dd>
        <dt className="font-semibold">What is sent</dt>
        <dd>{AI_CONSENT_COPY.whatIsSent}</dd>
        <dt className="font-semibold">Who receives it</dt>
        <dd>
          {AI_CONSENT_COPY.provider} Provider: {state.provider} (model {state.modelId}).
        </dd>
        <dt className="font-semibold">Turning it off</dt>
        <dd>{AI_CONSENT_COPY.revocation}</dd>
      </dl>
      {state.enabled ? (
        <p>
          AI requests left: {state.remaining.thisHour} this hour, {state.remaining.today} today.
        </p>
      ) : null}
      <button
        type="button"
        disabled={saving}
        onClick={() => onChange(!state.enabled)}
        className="self-start rounded border border-accent px-3 py-1 text-accent disabled:opacity-60"
      >
        {saving
          ? 'Saving…'
          : state.enabled
            ? 'Turn off AI features'
            : 'Agree and turn on AI features'}
      </button>
      <p className="text-sm text-muted">Consent version {AI_CONSENT_VERSION}</p>
    </>
  );
}
