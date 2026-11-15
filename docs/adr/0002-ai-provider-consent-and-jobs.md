# ADR 0002: AI provider gate, consent and leased jobs

- Status: accepted (provider terms review pending)
- Tickets: BIB-39 (jobs, context manifests, quotas), BIB-40 (provider terms, consent)
- PRD: sections 16, 21 (FR-AI-001, FR-AI-012), 22 (NFR-PERF-006, NFR-PRIV-002), 24, 25, 29, 38

## Decision

1. **Adapter, off by default.** AI goes through `AiProvider` (`apps/api/src/modules/ai/provider`).
   `AI_PROVIDER=disabled` is the default. `fake` is a deterministic in-process provider for local
   development and every test (refused in production). `anthropic` uses the Anthropic Messages API
   with model `claude-sonnet-5-5` (`AI_MODEL_ID`), and only when `AI_PROVIDER_TERMS_APPROVED=true`;
   without it the deployment behaves as `disabled`. No test needs a key.
2. **Provider terms are a launch gate.** Before anyone sets `AI_PROVIDER_TERMS_APPROVED=true`,
   product/legal records here: retention period, no training on submitted content, processing
   region, deletion terms, and the cost per request at the configured model. Until that record
   exists, AI stays off in every deployment.

   | Item                                     | Status                                                                                       |
   | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
   | Training on submitted content prohibited | to verify (commercial API terms)                                                             |
   | Retention / zero-retention eligibility   | to verify; do not promise zero retention                                                     |
   | Processing region                        | to verify                                                                                    |
   | Cost                                     | Sonnet 5.5: $2 / $10 per million input / output tokens; capped by `AI_MONTHLY_SPEND_CAP_USD` |

3. **Consent is explicit, versioned and revocable.** `AI_CONSENT_VERSION` and `AI_CONSENT_COPY`
   live in `@bible-artisan/contracts`. `user.ai_enabled` can be true only with a recorded consent
   version (CHECK). A changed version means `needsRenewal`: AI stays off until the user agrees again.
   A study can turn AI off for itself (`study_ai_setting`), overriding the account. Turning either
   off cancels the affected waiting and running jobs in the same transaction.
4. **Three gates, checked three times.** Provider approved, consent current, study switch on: at
   request time (503 / 422), by the worker before any provider call, and under the user row lock
   before a result is published. A revocation that commits first discards the output.
5. **Jobs are PostgreSQL rows.** `ai_job` leased with `SELECT … FOR UPDATE SKIP LOCKED`, two-minute
   lease renewed while working, reclaimed after expiry and failed after three claims. One running
   job per study, two per user (claims are serialized by an advisory lock). Provider calls never run
   inside a transaction. Transient errors retry at most twice with jitter inside the 60-second
   budget. 20 user requests per hour and 50 per day per user, plus the monthly spend cap: 429 with
   Retry-After.
6. **Context is deterministic and recorded.** Required items (objective, main/original question,
   established conclusions) first, then capped optional items within the token budget, measured with
   the provider tokenizer before submission. `context_manifest` stores ids, versions, token counts
   and omissions, never text; omissions become coverage warnings.

## Consequences

- AI requests do not write StudyEvents or move study revisions: they change no study content. The
  study AI switch is a study mutation on its own revisioned row (BIB-28's pattern).
- `PUT /me/ai-consent` is the first owner-scoped mutation: `MutationService.executeForOwner` gives
  it the same receipt, replay and COMMIT-before-reply guarantees without a study lock.
- Deferred to hardening: one constrained repair attempt for invalid JSON, automatic (trigger
  `automatic`) summaries and their 30-per-day cap, server-side refusal fallbacks, per-request
  maximum cost, and prompt-injection evaluation cases.
