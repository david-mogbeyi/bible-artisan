# ADR 0001: Stack and repository layout

- Status: Accepted (DB access superseded 2026-09-30 — see "Amendment" below)
- Date: 2026-09-30

## Context

PRD section 26 fixes the architecture: a TypeScript modular monolith (NestJS) with a worker process from the same codebase, PostgreSQL as the only datastore (domain state, corpus, full-text search, jobs, idempotency), a Next.js/React frontend using React Flow and Tiptap, and REST contracts in shared TypeScript packages. It leaves the tooling choices below to engineering.

## Decisions

| Concern           | Choice                                                                                                                           | Why                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo              | Single pnpm workspace: `apps/api`, `apps/web`, `packages/contracts`                                                              | Contracts change in the same PR as both sides of the wire. No Turborepo until build times justify it.                                                                |
| Runtime           | Node 24 LTS, pinned in `.nvmrc` and `engines`                                                                                    | Current LTS. Built-in `process.loadEnvFile`.                                                                                                                         |
| DB access         | ~~Kysely + `pg`~~ — **superseded, see Amendment below.** Now: **sequelize-typescript** + `pg`, migrations via our Umzug migrator | Team already knows Sequelize; no prior Kysely experience. See Amendment for the tradeoffs this accepts.                                                              |
| Validation / DTOs | **Zod** schemas in `packages/contracts`, shared by API and web                                                                   | The PRD names Zod for AI output validation. One schema language for DTOs and AI output. OpenAPI for `/v1` is generated from these schemas (tooling chosen in BIB-9). |
| API build         | Nest CLI with the SWC builder (type-check on)                                                                                    | Fast rebuilds, decorator metadata supported.                                                                                                                         |
| Tests             | **Vitest** everywhere. API integration tests hit a real PostgreSQL (`DATABASE_URL_TEST`). `unplugin-swc` handles Nest decorators | The PRD requires real-Postgres integration tests. One runner across packages.                                                                                        |
| Frontend          | Next.js App Router, Tailwind CSS v4, TanStack Query                                                                              | Query cache for server state, as the PRD requires. The client store (e.g. Zustand), React Flow, and Tiptap get added by the tickets that need them.                  |
| Lint / format     | ESLint flat config with type-aware `typescript-eslint`, React Hooks + Next rules, Prettier                                       | `no-floating-promises` matters for transactional code. `no-console` supports NFR-PRIV-001.                                                                           |
| CI                | GitHub Actions: format, lint, typecheck, unit, migrate an empty Postgres 16, integration, build                                  | Matches BIB-9's "schema and clients build reproducibly from a clean environment".                                                                                    |
| Local DB          | Native PostgreSQL 16 (`pnpm db:setup`) or `docker compose up -d`                                                                 | Either works. CI uses the `postgres:16` service.                                                                                                                     |
| Versions          | `save-exact=true`, lockfile committed                                                                                            | The PRD says to pin exact versions and test upgrades.                                                                                                                |

## Deferred to tickets

- OpenAPI generation, the error envelope, the idempotency/revision utilities, and the first domain migration: **BIB-9 / BIB-12**
- Managed email OTP provider and session cookies: **BIB-10** (decided, see "Addendum: email OTP provider" below)
- Content-redacted structured logging and correlation IDs: **BIB-13**
- The job runner in the worker: **BIB-39**
- Playwright E2E (the Romans conscience journey): added with the first end-to-end user flow and required by **BIB-54**
- Hosting (the PRD suggests Vercel for web and Railway for API/worker/DB): decide before the first deploy

## Amendment (2026-09-30): DB access is sequelize-typescript, not Kysely

BIB-9 initially implemented the DB layer on Kysely per the original table above. Before that PR merged, we switched to **sequelize-typescript** for team familiarity — nobody on the team had used Kysely before, and that onboarding/debugging cost outweighs the architectural fit arguments below for this project.

**What this costs, accepted knowingly:**

- The schema relies on composite foreign keys (`study(owner_id, id)`), CHECK-constrained enum columns, partial unique indexes, GIN/tsvector full-text search, and `SELECT … FOR UPDATE SKIP LOCKED` job leasing (no Redis/broker, PRD section 26). Sequelize's model layer does not express several of these natively (composite FKs and `SKIP LOCKED` in particular) — expect to drop to `sequelize.query` / raw SQL for those specific queries, losing compile-time column typing exactly where the schema is most constrained. This was Kysely's core advantage ("keeps queries typed while staying plain SQL") and Sequelize does not fully replace it.
- Migrations stay SQL-first per AGENTS.md ("Write DDL as raw SQL in migrations... CHECK constraints, partial unique indexes, and composite FKs are expected"). Migrations run through a small custom migrator (`apps/api/src/database/migrator.ts`) on Umzug's programmatic API, not `sequelize-cli` and never model `sync()`. It records applied migrations in `SequelizeMeta`, runs each migration and its bookkeeping in one transaction, and hands the migration a `MigrationContext` whose only API is `context.query(sql)`, bound to that transaction. No `queryInterface` is exposed, because statements issued through it run on another pool connection outside the transaction. A migration missing `up` or `down` fails loudly. Migrations must stay reversible (`down` implemented and tested), same as before.
- Prefer plain Sequelize models over decorator-heavy sequelize-typescript active-record patterns for anything with business logic — keep query/persistence logic inside the owning module's service layer (per AGENTS.md "Modules own their tables... cross-module calls go through exported services"), not scattered across model instance methods.
- Re-run `kysely-codegen`'s role some other way: there is no committed generated-types file under this stack. Types come from the hand-written Sequelize model classes — keep them the single source of truth for a table's shape, and keep migrations and model definitions in sync by hand (no automatic drift check exists here, unlike Kysely+codegen).

**What doesn't change:** every AGENTS.md non-negotiable rule (owner isolation, composite keys unwritable at the DB level, atomic events in the same transaction, revisions/idempotency, the error envelope, privacy/no console.log, AI restrictions, verbatim Scripture, no new infra, graph DTOs, accessibility) applies exactly as before. Only the tool implementing them changed.

## Addendum (2026-10-01, BIB-10): email OTP provider and sessions

PRD section 29 asks for a managed email OTP provider (10-minute single-use codes, at most five attempts per code, resend after 60 s, no credential storage) and Secure/HttpOnly/SameSite=Lax session cookies (rotated on sign-in, 7-day idle and 30-day absolute expiry).

**Provider: Stytch Email OTP**, called server to server (`POST /v1/otps/email/login_or_create` with `expiration_minutes: 10`, `POST /v1/otps/authenticate`, HTTP Basic auth with project ID and secret). Why:

- It's a purpose-built passwordless API with no client SDK, so the browser only ever talks to our API.
- Its per-request expiry allows at most 10 minutes, which matches the PRD exactly.
- One active code per email (a new send supersedes the old one) and single-use codes.
- A stable `user_id` that we store as `user.auth_subject`.
- Email delivery is included.

Stytch doesn't document a per-code attempt cap, so the attempt limit, the resend window, single use, and expiry are also enforced in PostgreSQL (`auth_challenge`, which stores no code or code hash). A resend supersedes the earlier challenge only after the provider confirms the new send, so a failed resend leaves the previous code usable.

Error mapping, verified against Stytch's error reference (https://stytch.com/docs/api/errors/400, `/401`, `/404`, `/429`, checked 2026-10-01):

| Stytch response                                                                           | Stytch's description                                                                                                         | Our result                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| verify 404 `otp_code_not_found`                                                           | "The passcode provided was incorrect and could not be authenticated."                                                        | 422 `OTP_INVALID` (attempt counted)                                     |
| verify 401 `unable_to_auth_otp_code`                                                      | "The passcode could not be authenticated because it was either already used or expired. Send another passcode to this user." | 422 `OTP_EXPIRED`                                                       |
| send 400 `invalid_email`, `invalid_email_domain`, `inactive_email`                        | Address malformed or missing, domain rejected, or marked inactive after a hard bounce                                        | 400 `VALIDATION` with fixed copy that never echoes the address          |
| 429 (any type)                                                                            | Rate limited. Stytch documents no `Retry-After`                                                                              | 429 `RATE_LIMITED`, with Stytch's `Retry-After` if sent, otherwise 60 s |
| 5xx, 400 `downstream_carrier_error` ("could be temporary"), network failure, 10 s timeout | Transient                                                                                                                    | 503 `DEPENDENCY_UNAVAILABLE`, retryable                                 |
| any other 4xx (e.g. 401 `unauthorized_credentials`), unreadable 2xx body                  | Our request or configuration is wrong                                                                                        | 500, not retryable                                                      |

So a misconfiguration can never look like a wrong code or invite pointless retries. In practice Stytch's 401 can only come back for a challenge that PostgreSQL still considers open in narrow races (for example a code verified just as a resend lands), because our local expiry starts before the send and is never later than Stytch's.

**Adapter seam:** one `OtpProvider` interface (`apps/api/src/modules/identity/otp/`) with `StytchOtpProvider` and `DevOtpProvider`, selected by `OTP_PROVIDER`. The dev adapter keeps codes in memory, optionally writes the latest one to a local gitignored outbox file, never logs it, and is refused when `NODE_ENV=production`. `NODE_ENV` has no default and must be set explicitly, so a deploy that forgets it refuses to start instead of silently running as `development` with the dev adapter. Tests and local development need no secrets.

**Sessions are ours, not Stytch's:** a random 32-byte token in the `ba_session` cookie, with only its SHA-256 stored in `auth_session`. A global `SessionGuard` denies by default; public routes opt out with `@Public()`. Controllers take the owner from `@CurrentUserId()`.

**JSON-only mutations:** every POST/PUT/PATCH/DELETE under `/v1` that carries a body or a `Content-Type` must be `application/json`, otherwise 415 (`apps/api/src/common/http/require-json-body.ts`, registered ahead of Nest's body parsers). HTML forms can't send that type, and a JSON request from another origin needs a CORS preflight that the allowlist refuses. Without this, an auto-submitting cross-site form could sign a victim into the attacker's account (login CSRF), because the browser accepts the SameSite=Lax `Set-Cookie` on a top-level navigation. BIB-11 added an Origin check as the second layer and decided against CSRF tokens (see its addendum below).

**Assumption:** web and API are deployed same-site (for example `app.` and `api.` under one domain), so the API's SameSite=Lax cookie travels with credentialed fetches from the web app. Revisit with the hosting decision.

## Addendum (2026-10-01, BIB-11): owner isolation and CSRF

**Owner isolation is a mechanism, not a habit.** `StudyAccessService` (exported by `StudyModule`) is the one way to load a study or a child of it: `requireOwnedStudy(ownerId, studyId)` and `requireOwnedNode(ownerId, studyId, nodeId)`, each a single query whose WHERE includes `owner_id` (and `study_id` for children), with optional `{ transaction, lock }` for writes. Absent, another user's, soft-deleted, and malformed (non-UUID) IDs all throw the same `NotFoundError`, so status and body carry no existence signal. Path params use `ParseResourceIdPipe` (non-UUID → the same 404), and the service re-checks ID shape so a forgotten pipe still fails closed. Later child tables (notes, events, suggestions, jobs, exports) follow the same rule: filter by the child's own `owner_id` from the session and its `study_id`; the composite FK guarantees they agree, so no join and no owner comparison in application code. Row-level security was not added; composite FKs plus session-scoped queries are the PRD §23 mechanism.

`test/route-inventory.int-spec.ts` lists every mounted route (including `@All()` routes, as `ALL <path>`) as public (with a reason; its handler or controller must carry `@Public()` and it must not answer 401) or private (must answer 401 without a session and name its cross-user test by file and exact test title). For a private route the inventory parses the named spec with the TypeScript compiler and requires a live (not skipped) `it`/`test` with that exact title that makes a whole-body `toStrictEqual` assertion and itself references the route's path (as a literal in the test or its `.each` table, or via a path helper declared in that file; params as `${...}` or a concrete segment). A cross-test recorder was rejected: Vitest isolates each file's module state and file order is not guaranteed, so it would need on-disk state and ordering. A new route fails CI until it is listed.

**CSRF without tokens.** Two layers, both registered in `configureApp` ahead of body parsing, the session guard, and every handler (public sign-in routes included):

1. `requireTrustedOrigin`: a state-changing request (any method except GET/HEAD/OPTIONS, the same `isStateChangingMethod` set `requireJsonBody` uses) whose `Origin` is not exactly one of `CORS_ALLOWED_ORIGINS` (including `null`), or that has no `Origin` but `Sec-Fetch-Site: cross-site`, gets 403 (`FORBIDDEN` envelope). A request with neither header is a non-browser client holding no victim's cookie.
2. `requireJsonBody` (BIB-10): non-JSON mutations get 415, so any cross-origin mutation needs a CORS preflight that the allowlist refuses.

A synchronizer or double-submit token would add web and API plumbing without closing a further realistic path for this same-site, JSON-only API. Revisit if a non-JSON mutation is ever introduced. Because the allowlist now also gates mutations, `CORS_ALLOWED_ORIGINS` entries must be exact bare http(s) origins (no wildcard, path, or trailing slash). In production every entry must be https, and the HTTP API (`httpAllowedOrigins`, called from `configureApp`) refuses to start without the variable. The worker loads the same config but has no HTTP surface, so it does not require it.

**Safe URLs.** `httpUrlSchema` in `@bible-artisan/contracts` accepts only http/https URLs without credentials or embedded whitespace/control characters (NFR-SEC-002). Every stored URL (note links in BIB-23, Source URLs) must use it. The Tiptap allowlist schema and link `rel` rendering belong to BIB-23.

## Addendum (2026-10-01, BIB-12): revisions, idempotency, and event sequences

Every study mutation route reuses one pipeline; none builds its own variant. The exact contract
routes follow lives in `apps/api/src/modules/README.md` ("Mutation contract"):

```ts
const expectedRevision = requireExpectedRevision(mutation.body); // 400 / 428, before anything else
const body = parseBody(schema, mutation.body);
return mutations.execute(ownerId, mutation, {
  // returns a MutationResult; the global
  studyId, // interceptor applies status + replay header
  bumpsContentRevision: true,
  work: async (m) => {
    const row = await m.updateWithExpectedRevision(Model, { id, expectedRevision, values }); // 404 / 409
    await m.appendEvent({ eventType });
    return { status: 200, body: dto };
  },
});
```

- **Conflict detection is one conditional statement**: `UPDATE … SET revision = revision + 1 WHERE id AND owner_id [AND study_id] AND revision = :expected RETURNING *`. Owner/study scoping comes from the mutation's lock, not the caller. Zero rows → owner-scoped re-read: absent → 404, present → 409 with `currentRevision`.
- **Lock order is enforced, not documented**: receipt claim → study row (`SELECT … FOR UPDATE`, taken by `execute` before `work` runs) → child rows. All mutations of a study queue on its row first, so a child mutation and a study-level mutation touching the same child cannot deadlock. If PostgreSQL ever reports 40P01 (deadlock) or 40001 (serialization failure) anyway, the filter answers 503 `TRANSIENT_CONFLICT` with `retryable: true` and `Retry-After: 1`. Not 409: §24 reserves 409 for revision/uniqueness conflicts, which the client resolves with the user and never retries automatically. The whole transaction (receipt included) rolled back, so retrying with the same key is safe.
- **The pipeline enforces the invariants itself**: `work` must make ≥1 revision check and append ≥1 event, or `execute` throws and rolls back. Every query inside `work` joins the transaction through Sequelize CLS (`Sequelize.useCLS` with an `AsyncLocalStorage` namespace, no extra dependency), so a forgotten `{ transaction }` cannot autocommit outside the mutation. A nested `execute` inside another transaction is refused. The transaction is explicitly READ COMMITTED, whatever the database default.
- **Event sequences come from a counter column**, `study.last_event_sequence` (PRD §23 "transactional per-study counter"), backfilled from `max(study_event.sequence)` by its migration. With the study row locked, sequences are allocated in memory (`last + 1, …`) and the pipeline writes `content_revision` and `last_event_sequence` in ONE UPDATE at the end of the mutation. A rollback discards both, so committed sequences are 1..N with no gaps; unique `(study_id, sequence)` stays as the backstop. `bigint` comes back from pg as a decimal string and stays a string, in TypeScript and on the wire (`eventSequenceSchema`).
- **Receipts** (`mutation_receipt`, PK `(owner_id, idempotency_key)`, so keys never collide or replay across users). `MutationService.execute` runs everything in one transaction and resolves only after COMMIT, so nothing is acknowledged before it is durable (NFR-REL-001). It claims the receipt first with `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now()`. A concurrent duplicate blocks on the first request's uncommitted unique-index entry and then replays (committed) or runs (rolled back), so there is no "in progress" state and no double execution. Failed work rolls the receipt back with everything else, so errors are never cached. Same key with a different request → 422 `IDEMPOTENCY_KEY_REUSED` (the IETF idempotency-key draft's status for this; PRD §24 lists 422 for a request that cannot be applied in the current state). Replays carry `Idempotent-Replayed: true` (a CORS-exposed header) and the original status. Receipts live 7 days (PRD §23); an expired key can be claimed again, and physical purge waits for the job runner (BIB-39).
- **Request fingerprint**: SHA-256 hex of canonical JSON of `{ method, route, params, body }`. `route` is the matched route pattern (e.g. `/v1/studies/:studyId`), and `params` are the router-decoded params with UUIDs lower-cased, so case, trailing-slash, percent-encoding, and query-string variants of one resource replay instead of 422. `body` is the raw parsed JSON (not the Zod output, so every submitted field counts, `expectedRevision` included). Canonical JSON sorts object keys recursively on null-prototype objects (so an own `__proto__` member counts), keeps array order, drops `undefined` members, and compares numbers by value (`1`, `1.0`, `1e0` are the same). The receipt's `route` column stores `METHOD pattern`, never IDs.
- `Idempotency-Key` is optional per PRD §24 ("accept"), must be a UUID when sent, and is stored lower-cased. A request without one is not deduplicated, so the web save coordinator (BIB-35) must always send one.
- `mutation_receipt` is owned by `src/common/mutation/MutationModule`, not a domain module: it is owner-scoped rather than study-scoped (POST /studies has no study yet) and every domain module writes through it.
- `study_event.client_mutation_id` and the activity endpoint's dedupe are BIB-55's; domain-mutation retries are already deduplicated by the receipt.

## Addendum (2026-10-01, BIB-13): content-redacted logs and health probes

**Allowlist, not redaction.** NFR-PRIV-001 is enforced by what each call site chooses to log, not by scrubbing what it already logged. A redactor would have to recognize every shape of private text (a Scripture reference in a query string, a note in a body, an email in a validation message), and it fails open on the first shape it misses. So:

- `requestLogging` (`src/modules/observability/request-logging.ts`) is the FIRST middleware in `configureApp`, ahead of the CSRF/JSON middlewares and the body parsers. It assigns the request's correlation ID, returns it as `X-Correlation-Id` (CORS-exposed), and writes exactly one `http_request` line when the response finishes (or the connection closes first): `method` (a standard method, else `OTHER`), `route`, `status`, `durationMs`, `correlationId`, and `aborted` when set. `route` is the matched Express route PATTERN (`/v1/studies/:studyId`). The raw URL is never logged, since it carries IDs and the query string. Requests no controller route handled log `unmatched`: refusals before routing (403/415/413/400 from the parser) and unknown paths. Unknown paths reach Nest's not-found catch-all, which Nest registers as `*path`, so only patterns starting with `/` count as matched.
- `AllExceptionsFilter` logs one `http_error` line (`code`, `status`, `correlationId`, `errorType` = class name) at `warn` for 4xx and `error` for 5xx. It reads the same correlation ID through `correlationIdOf(req)`, a per-request WeakMap that `requestLogging` fills first. A client `x-correlation-id` is used only if it is a single UUID (the existing `resolveCorrelationId`).
- The process logger is Nest's own `ConsoleLogger` (`createAppLogger`). In production it writes one JSON object per line (`json: true`, `flattenParams: true`), and it applies the previously unused `LOG_LEVEL`. The API and the worker both use it. There is no pino/winston, log shipper, or APM (rule 9): the platform collects stdout.
- `test/log-redaction.int-spec.ts` runs the production logger and captures stdout, stderr, and `console.*`. It sends sentinel strings in the path, params, query, headers, cookies, Origin, Idempotency-Key, correlation header, and bodies, on success and failure paths for matched, unmatched, and pre-routing-rejected requests. It asserts that no sentinel appears anywhere in the output and that each request produced exactly the expected allowlisted line. If a later ticket adds a log call, it must log only opaque IDs, counts, latency, status, and error class, and it should extend that test when it handles new private input.

**Probes.** `GET /v1/health/live` never touches the database, so a database outage doesn't get healthy API processes restarted. `GET /v1/health` is readiness. It returns 200 `{status:'ok', database:'up', migrations:'current'}` only when PostgreSQL answers and every migration file shipped with the build (`shippedMigrationNames()`, the migrator's directory and glob) is recorded in `SequelizeMeta`. Otherwise it returns 503 with `status:'unavailable'`, so the platform marks the deployment unhealthy. A failed migration rolls back its own record, so it shows as `pending`. The check is read-only: it looks for the table with `to_regclass` and never goes through Umzug's storage, which runs `CREATE TABLE IF NOT EXISTS`. It is bounded twice by `READINESS_TIMEOUT_MS` (2 s): a server-side `SET LOCAL statement_timeout`, and an in-process deadline for an unreachable or hung server where no statement ever starts. The 503 carries this `HealthResponse`, not the error envelope. It is a status report for the platform rather than an API error, and the envelope's `code`/`message` would hide which check failed. The bodies carry check states only (the old `version` field is gone): no hosts, connection strings, or error text. A `readiness_failed` warn line records the states and the failure's class name. The API process also reads the migrations directory at startup, so a build deployed without it fails to start rather than reporting itself ready.

## Notes

- **TypeScript is pinned to 6.0.x, not 7.x.** TypeScript 7 is the native (Go) compiler, and `typescript-eslint` 8.x supports `<6.1`. Revisit when type-aware lint supports 7.
- `apps/api` uses `NodeNext` module resolution (it still compiles to CommonJS) because it imports the `@bible-artisan/contracts/openapi` subpath, which resolves only through `package.json#exports`.
