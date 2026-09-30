# Quality gates

Apply only the relevant gates, but decide applicability explicitly. Prefer integration evidence against real PostgreSQL over mocked units.

**Baseline gates always apply** when the ticket touches the relevant surface: repository baseline, API correctness, database and migration safety, PRD invariants, privacy and security, frontend baseline, and testing and verification. **Conditional gates** (concurrency, jobs and AI, offline/autosave, performance) read as "if this applies, do it correctly," not "add this."

## Repository baseline

- Read `AGENTS.md` and any closer-scoped instruction files (e.g. `apps/api/src/modules/README.md`) before editing.
- TypeScript strict; explicit types at boundaries; no `any`, no non-null assertions to silence real nullability.
- NestJS: one module per bounded context under `apps/api/src/modules/`. Modules write only their own tables; other modules go through exported services. Domain logic stays out of controllers.
- In `apps/api`, use normal imports (not `import type`) for injected classes; Nest DI needs runtime metadata. Use `@Inject(TOKEN)` for symbol tokens.
- DTOs are Zod schemas in `packages/contracts`, validated at the API boundary and parsed again in the web client.
- Test naming: unit `*.spec.ts` beside the source; API integration `apps/api/test/**/*.int-spec.ts` (supertest against the real `AppModule` via `test/app.ts`); web `*.test.tsx`.
- Commands (verify against `package.json` at execution time): `pnpm check`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format`, `pnpm db:migrate`, `pnpm --filter @bible-artisan/api db:migrate:make <name>`, `pnpm --filter @bible-artisan/api db:codegen`.

## API correctness

- Explicit request and response schemas for every endpoint; validate every untrusted input (body, params, query, headers) with size limits.
- Routes live under `/v1`. Private responses are not cacheable by intermediaries.
- Status codes per PRD section 24: 400 malformed DTO, 401 unauthenticated, 404 absent **or** another owner's resource, 409 revision/uniqueness conflict, 413 too large, 422 invalid reference or state transition, 428 missing revision, 429 with `Retry-After`, 503 dependency unavailable.
- Every error uses the shared envelope. Error text never reveals whether another user's entity exists.
- Response DTOs carry only what the contract specifies. Never return Kysely rows directly, and never leak `owner_id` of other users, internal flags, or AI prompt data.
- Once OpenAPI generation exists (BIB-9), regenerate the committed artifact and confirm it matches the contract.
- Test: success, invalid input, unauthenticated, **cross-user 404**, missing resource, conflict, and the error body.

## Database and migration safety

- Kysely migrations only, written SQL-first. Each is reversible, or states honestly why it isn't.
- UUID PKs, `timestamptz`, and explicit CHECK constraints for enumerated values.
- Study-scoped tables: `study_id` + `owner_id` with composite FK to `study (owner_id, id)`, so a mismatched owner/study can't be written.
- Partial unique indexes for "one live X" invariants (e.g. live canonical Scripture node per study/reference/edition; live edge per study/source/target/type).
- Add indexes only for demonstrated access patterns (PRD section 23 lists the expected ones).
- Verify forward migration on an empty database (CI does this) and on the current dev schema; verify `down` when supported.
- After schema changes, run `db:codegen` and commit `schema.generated.ts`.
- Test that the database rejects invalid data, e.g. a CHECK violation or cross-owner FK.

## PRD invariants

Apply every row of the invariant table in `SKILL.md` that the ticket touches. In particular:

- **Owner isolation.** The owner comes from the authenticated session. Query children through owner/study constraints. Every new private route gets a cross-user integration test that asserts 404 and that no content leaks.
- **Atomic events.** The mutation and its `StudyEvent` commit together. Test that a failure after the mutation leaves neither row, and that sequence numbers are gap-free per study under the tested flow.
- **Revisions.** Test missing `expectedRevision` → 428, stale → 409 with `currentRevision`, and success → revision incremented. Content revision and view revision stay separate (section 23).
- **Idempotency.** Test that replaying the same `Idempotency-Key` + body returns the original result without a second effect, and that the same key + different body is rejected.
- **Scripture integrity.** Text comes only from the corpus tables. Invalid or ambiguous references return candidates or 422, never a nearby verse.
- **AI agency.** Suggestions never mutate canonical content until accepted. Acceptance revalidates prerequisites. Validators reject IDs outside the manifest and quotes that don't match stored text.

## Concurrency (conditional)

Revision checks cover ordinary edit conflicts. Add more only for a concrete invariant:

- Identify the shared record and the competing operations.
- Prefer a constraint (partial unique index) or a conditional update before a row lock; use `SELECT … FOR UPDATE SKIP LOCKED` for job leasing.
- Test with independent connections and prove that only one business effect occurs and the loser gets a stable, actionable error.

## Jobs and AI (conditional)

- Jobs are PostgreSQL-leased (`SKIP LOCKED`, `lease_until`, unique request key, bounded retries with jitter). No Redis or brokers.
- Provider calls happen outside transactions, behind the configured adapter, and within the token budgets and 60 s timeout in PRD section 25.
- Check consent before a job is queued and again before sending. Revocation blocks new jobs and discards in-flight output where possible.
- Persist validated output only. After one constrained repair attempt fails, persist failure metadata and publish nothing.
- Automated tests use deterministic provider fakes. Never call a live provider in CI.
- Logs contain the job ID, capability, latency, token counts, status, and error category only.

## Privacy and security

- Nothing from the NFR-PRIV-001 list may appear in logs, analytics, error messages, or exception traces. When a route handles such content, capture logs in the test and assert redaction.
- Rich text: allowlist schema, server-side sanitization, http/https links only with safe `rel`.
- No server-side fetching of arbitrary URLs.
- Cookies are `Secure`, `HttpOnly`, and `SameSite=Lax`; mutations are CSRF-protected once auth exists (BIB-10); CORS is restricted to configured origins.
- Rate limits and quotas return 429 with `Retry-After`.
- Secrets live only in env/secret stores, never in the web bundle (`NEXT_PUBLIC_*` must not hold secrets).
- Check the staged diff for credentials and `.env` files.

## Frontend baseline

- Server state goes through TanStack Query with `apiFetch` and a contract schema. No ad-hoc `fetch`.
- Component state stays local; cross-component interaction state (canvas selection, drafts, pending queue) goes in the lightweight client store.
- Accessibility (WCAG 2.2 AA): semantic elements, accessible names, visible and unobscured focus, logical tab order, focus management on dialogs and route changes, no information conveyed by color or position alone, and contrast ≥ 4.5:1 (use the tokens in `globals.css`).
- Every canvas or drag interaction has a keyboard path or a List View/dialog equivalent. Phone users never need to drag graph nodes.
- Reader and notes work at 200 % text size and in a narrow viewport.
- The save indicator is truthful: "Saved" only after server acknowledgment of all visible content mutations. Failures keep the user's content and show the right state.
- AI content is visibly labeled and never styled or worded as a user-established finding.
- Private study content never goes into `localStorage`. IndexedDB caching follows PRD section 27 only in tickets that own it, and local caches are cleared on sign-out.
- Graph data is converted from domain DTOs to React Flow view objects. Don't persist library serialization.
- Test with Testing Library, querying by role, label, and text as a user would. Cover the loading, error, and empty states that the ticket specifies, plus the keyboard path.

## Offline and autosave (conditional)

Only for tickets that own this behavior (BIB-35…BIB-37):

- Timing: text saves at 750 ms idle with a 5 s maximum; structural actions save immediately; positions save 300 ms after drag end; view state saves at 1 s idle.
- Writes are serialized per entity with stable client UUIDs and idempotency keys. Retry backoff is ~1/2/4/8/30 s with jitter. Pause on 401; don't loop on 4xx validation errors.
- On reconnect, fetch current revisions before replay. A 409 preserves the local draft and offers Keep Server / Save My Version / manual combine.

## Performance (conditional)

- No N+1 queries and no unbounded reads. Paginate with cursors (events: 50 per page; search: bounded pages).
- Graph endpoints return compact metadata; full bodies load on selection.
- Capture `EXPLAIN` evidence for material new queries on large tables when practical.
- Never fabricate benchmark results. NFR measurements belong to BIB-52.

## Testing and verification

- Map every acceptance criterion to at least one test or recorded manual check.
- API integration tests run against real PostgreSQL. Truncate or isolate the data a test creates; test files run serially.
- Assert whole API response bodies with a single `toStrictEqual`, using `expect.any(...)` only for genuinely dynamic values inside the full expected object.
- Use deterministic clocks, IDs, and provider fakes where behavior depends on them.
- Run `pnpm check` and `git diff --check` before the PR. For UI, run the app and do a manual pass: the flow, keyboard-only, and narrow viewport.
- Record exact commands and results. Only successful commands count as passed.

## Final diff and delivery

- Review the full `main...HEAD` diff twice: requirements/scope, then technical risk.
- Confirm there is no sibling-ticket behavior, unrelated refactor, debug output, dead code, broad suppression, secret, `.env`, build output, or local artifact.
- Confirm hooks ran without bypass, only the ticket branch was pushed, the PR is not merged, and nothing was deployed.
