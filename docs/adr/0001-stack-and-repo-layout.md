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
- Bible corpus source, import, and immutability: **BIB-14** (decided, see its addendum below)
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

**Probes.** `GET /v1/health/live` never touches the database, so a database outage doesn't get healthy API processes restarted. `GET /v1/health` is readiness. It returns 200 `{status:'ok', database:'up', migrations:'current'}` only when PostgreSQL answers and every migration file shipped with the build (`shippedMigrationNames()`, the same list the migrator runs) is recorded in `SequelizeMeta` (`META_TABLE`, also shared with the migrator). Otherwise it returns 503 with `status:'unavailable'`, so the platform marks the deployment unhealthy. A failed migration rolls back its own record, so it shows as `pending`. The check is one read-only statement with no transaction (`count(*) ... WHERE name = ANY($shipped)`; a missing table, SQLSTATE 42P01, also means `pending`), and it never goes through Umzug's storage, which runs `CREATE TABLE IF NOT EXISTS`. It runs on its own short-lived pg client, never the request pool: a pool saturated by slow requests must not make a healthy database look down, and a hung database must not park probe connections in request slots. The documented budget is 2 s (`READINESS_BUDGET_MS`) including the response; the check's own deadline is 1.5 s (`READINESS_TIMEOUT_MS`), applied as pg's connect timeout, a server-side `statement_timeout`, pg's query timeout, and an in-process deadline. Because the route is public, `ReadinessProbe` is single-flight (concurrent probes share one check) and caches the result for 1 s (`READINESS_CACHE_MS`), so a flood costs at most one database check per second. The 503 carries this `HealthResponse`, not the error envelope. It is a status report for the platform rather than an API error, and the envelope's `code`/`message` would hide which check failed; the web app's status line reads that body on 503 and shows which check failed. The bodies carry check states only (the old `version` field is gone): no hosts, connection strings, or error text. A `readiness_failed` warn line, once per check rather than per probe, records the states, the failure's class name, and its SQLSTATE/errno code. The API process also reads the migrations directory at startup, so a build deployed without it fails to start rather than reporting itself ready.

**Pool timeouts.** `createDatabase` sets pg's `connectionTimeoutMillis` (5 s) and the session settings `statement_timeout` (30 s) and `idle_in_transaction_session_timeout` (60 s), sent as startup parameters (`DATABASE_TIMEOUTS`). Without a connect timeout, connects to a server that accepts TCP but never answers stay counted against the pool forever, and the pool stays locked up after the database recovers. 5 s is well under the 10 s acquire timeout; 30 s is far above any interactive mutation; 60 s idle-in-transaction ends sessions that hold locks for a stuck request. Each migration runs `SET LOCAL statement_timeout = 0` in its own transaction, so long DDL or backfills are not cut off; a future long-running job does the same.

**Process failures.** The API, the worker, and the migrate CLI run through `runEntrypoint`: a startup error (invalid config, a failed migration) and any later unhandled rejection or uncaught exception become ONE JSON `process_failed` line (entry point, error class, cause class, SQLSTATE/errno code, migration name, the NAMES of invalid env variables) and exit 1. Never the error itself: its message and properties carry SQL, bound parameters, and PostgreSQL `detail`, which quotes row values. The app logger also reduces an Error passed as a log message (Nest's own `ExceptionHandler` does this on a failed bootstrap) to `unhandled_error` with its class name. An aborted request (client gone before any headers were sent) logs `status: null, aborted: true`, never Express's default 200.

## Addendum (2026-10-01, BIB-14): the WEB Protestant corpus

**Source and rights evidence.** The MVP corpus is the World English Bible, Protestant edition (eBible.org `engwebp`, 66-book canon), as PRD §20 recommends.

- Artifact: `https://ebible.org/Scriptures/engwebp_usfm.zip`, downloaded 2026-10-01.
  - 2,903,129 bytes, `Last-Modified: Tue, 29 Sep 2026 01:50:24 GMT`.
  - SHA-256 `c725155aa8192b954e552a0b08aa75f8e7b85e6e56f1eb22efd6d30f5b4aa3cc`.
  - Its `copr.htm` says "generated with Haiola by eBible.org 29 Sep 2026 from source files dated 29 Sep 2026" and "2020 stable text edition". Release id: `2026-09-29`.
- eBible's details page (https://ebible.org/find/details.php?id=engwebp) says "This edition omits the Deuterocanon/Apocrypha".
- License, verbatim from the artifact's `copr.htm` (the same text as the publisher notice PRD §20 links, https://ebible.org/study/content/texts/engwebp/about.html):

  > The World English Bible is in the Public Domain. That means that it is not copyrighted. However, "World English Bible" is a Trademark of eBible.org.
  > … All we ask is that if you CHANGE the actual text of the World English Bible in any way, you not call the result the World English Bible any more.

  A unit test asserts that both sentences appear in the committed artifact.

- Permitted uses: storage, caching, search, quotation, AI processing, and export, all under the public-domain dedication. The one condition: we never present altered text under the WEB name.
- Territories: the dedication states no territorial restriction.
- **Outstanding:** human product/legal confirmation of launch territories (PRD §38 open decision; release-gate scenario in §32). It is recorded as `launchTerritoriesConfirmed: false` in the stored rights record.

**Committed, not fetched.** eBible regenerates the download in place: there is no versioned URL, and the bytes change with each regeneration even while the text stays the 2020 stable edition. Fetching at import time would make CI depend on the network and on the publisher's schedule, and a pinned SHA-256 would eventually start failing. So the artifact is committed byte-identical at `apps/api/corpus/engwebp/engwebp_usfm.zip` (about 2.9 MB, once). `.gitattributes` marks it binary, so Git never rewrites its bytes. Anyone can check the SHA-256 against the publisher's copy of the same generation. The import never touches the network. The USFM zip is the publisher's master format; eBible's VPL plain-text product was not used (see the cross-check below for why).

**Import pipeline** (`apps/api/src/modules/bible-content/corpus/`, `pnpm corpus:import`):

1. Verify the artifact SHA-256 against the pinned release (`engwebp-release.ts`). Every exported path from artifact bytes to parsed text (`readArtifact`, `parseArtifact`, `importCorpus`) does this first; the write half (`importParsedCorpus`) is module-internal.
2. Unzip it with a small `node:zlib` reader (no dependency), hardened for hostile input even though it only sees verified bytes. It bounds-checks every offset and length (the EOCD comment must run exactly to the end of the file, and the central directory must end exactly at the EOCD). Each local header must match its central entry (name, flags, method, CRC-32, sizes). Members may not overlap. Encryption, data descriptors, ZIP64 and multi-disk archives are refused. Inflation is capped at each member's declared size (`maxOutputLength`), with limits of 16 MiB per member and 128 MiB in total, so a deflate bomb fails fast. Size and CRC-32 are verified. Every failure is a `ZipFormatError` with the fixed code `CORPUS_ZIP_FORMAT` and a fixed message.
3. Parse each canon book's USFM. `FRT` and `GLO` are skipped by their `\id`, and any other unlisted book fails.
4. Validate everything against the manifest.
5. Write the edition (inactive), its books and its verses in ONE transaction, activate it, and COMMIT.

Re-running is idempotent:

- The same release and artifact: the stored content checksum is recomputed in SQL and the run is a no-op.
- The same release from a different artifact: refused.
- Concurrent runs queue on a table lock.
- Any failure rolls back the whole transaction, so a bad import never replaces or disturbs the active release.

The command is a separate step, not a migration: migrations only get `context.query(sql)` with no bind parameters, and Scripture must never be string-spliced into SQL. `pnpm db:setup` runs it for the dev and test databases, CI runs it after `db:migrate`, and a deployment runs it after migrating. The integration suite imports in its global setup, and the reversibility test re-imports after it drops everything.

**Text rules (USFM to verse text).** There is an explicit allowlist, and an unknown marker fails the import rather than being guessed at.

- Dropped with their content: footnotes `\f…\f*` and cross-references `\x…\x*`.
- Dropped as whole lines: book identification and titles (`\id \ide \h \toc1-3 \mt1-3`), `\ms1`, `\s`, speaker labels (`\sp`), and `\cl`. A heading line that also opens a chapter or verse is refused. These are not verse text in English versification; a later reader ticket can import headings from the same artifact.
- Kept, but not as verse text: superscriptions (`\d`). They are part of the published text, so each is stored verbatim in `bible_superscription`, keyed by the verse it immediately precedes (`before_verse`). Placement:
  - In this artifact every `\d` is a whole line in Psalms (138 lines, counted straight from the raw USFM). 117 come before a psalm's first verse: the titles, including Psalm 119's first stanza heading. The other 21 are Psalm 119 stanza headings between verses.
  - The parser refuses any other placement: a `\d` that is not a line of its own, one before the first chapter, one not followed by a verse in its chapter, two before one verse, or text between a `\d` and its verse.
  - Validation refuses superscriptions outside the release's `superscriptionBooks` (`['PSA']`) and any count other than `superscriptionCount`.
  - Their text follows exactly the verse-text rules below (footnotes removed, character markers dropped, ASCII whitespace collapsed, NFC).
- Markers dropped, content kept: `\w`/`\+w` (Strong's attributes removed), `\wj`, `\qs`, and `\bk`. An opening character marker consumes the one whitespace character after it, which the USFM spec defines as the delimiter; a closing marker consumes nothing.
- Paragraph and poetry markers become word boundaries.
- ASCII whitespace runs collapse to one space and the ends are trimmed. Nothing else is touched: curly quotes, dashes, and the publisher's three no-break spaces (U+00A0) are preserved. JavaScript `\s` and `trim()` are deliberately not used, since both treat U+00A0 as whitespace.
- The result:
  - 66 books, 1,189 chapters, 31,103 verses, contiguous from 1, all NFC.
  - 138 superscriptions, all in Psalms.
  - 5 verses the edition numbers but gives only in footnotes are stored with empty text: LUK 17:36, ACT 8:37, ACT 15:34, ACT 24:7, ROM 16:25.
- Book names are the publisher's `\toc2`/`\toc3`. Aliases belong to BIB-15.

**How the expected values were obtained (no Scripture typed).** Every count, the book list, the 5 empty verses, 8 sample-verse SHA-256s, and the content SHA-256 were produced by running this parser over the artifact and pasted as generated output.

- They were re-derived independently with a separate Python implementation of the same rules: identical verse-only content SHA-256 `c7083981d77c5b1c41ea867ace86a9da1094f7a4de43010bb545a1ee357995b4`, identical sample hashes, identical chapter counts.
- **Superscriptions (merge-gate fix).** The edition checksum now also covers superscriptions. Each verse's line is preceded by its superscription's line, `book \t chapter \t d<verse> \t text \n`, both in TypeScript `contentSha256()` and in SQL `bible_edition_content_sha256()`. The pinned content SHA-256 is now `228800e9c09d4b6d08ba7fa1862e7e04f308bb3591178c1c963adb600c71e9aa`. It was obtained by running the parser over the artifact and was not typed. It was confirmed independently:
  - The SQL activation trigger recomputes it from the stored rows on every import, so the import only succeeds if both implementations agree.
  - Hashing the verses alone still gives `c7083981…95b4`, so adding superscriptions changed no verse text.
  - The superscription count (138) equals the number of raw `\d` lines, which a unit test recounts from the zip. It also equals the 117 + 21 superscription and stanza differences the VPL cross-check below attributes to `\d`.
- That parse was cross-checked against eBible's own VPL rendering of the same generation (`engwebp_vpl.zip`, SHA-256 `7d2e0b91ba43e2500fcab9c64d9db1962750deeff4e1186aed4c30220f5689be`). It matched 30,960 of 31,103 verses exactly. All 143 differences are VPL rendering choices that this import deliberately does not copy:
  - 117 Psalm superscriptions and 21 Psalm 119 stanza letters folded into verse text;
  - 4 Song of Songs speaker labels;
  - one space VPL inserts before `\qs` at Psalm 68:32.
- The tests take their USFM inputs from the committed artifact at run time. They assert properties and equivalences, for example "removing the footnote span does not change the verse", or "no verse in the corpus has a space before closing punctuation". They never assert typed verse text.

**Immutability is enforced by PostgreSQL**, not by convention (migration `create_bible_corpus`):

- An edition can only be inserted inactive: a BEFORE INSERT trigger refuses `activated_at IS NOT NULL`, so activation always goes through the checked update.
- Books, verses and superscriptions can be inserted only while their edition is not yet activated. The insert trigger takes `FOR SHARE` on the edition row, so a racing activation either counts the row or refuses the insert.
- Books, verses and superscriptions can never be updated, deleted, or truncated. A superscription has a composite FK to the verse it precedes.
- An edition can never be deleted or truncated. Its only permitted update is the single activation (`activated_at` NULL to a timestamp, nothing else changed).
- Activation recomputes, in SQL, the verse and superscription counts (`verse_count`, `superscription_count`), every `text_sha256`, each book's chapter count, and the edition `content_sha256` (`bible_edition_content_sha256()`, the same serialization as `contentSha256()` in TypeScript). It refuses on any mismatch.
- **Search-path safe.** Every corpus function declares `SET search_path = pg_catalog, pg_temp` and names every table and helper function by schema. The schema is the one the migration runs in, read with `current_schema()` through the migrator's read-only `context.select`, so the import test's own schema works too. A caller who puts lookalike tables or a lookalike checksum function earlier on `search_path` cannot make an incomplete edition activate. An integration test attacks `public` this way.
- All refusals are SQLSTATE 23000 with content-free messages.
- **Guarded `down`.** `down` refuses with a fixed message ("bible corpus drop refused: an active edition exists (set ALLOW_CORPUS_DROP=1)", SQLSTATE 23000), and changes nothing, while an active edition exists. It proceeds only with `ALLOW_CORPUS_DROP=1` in the migrator's environment, e.g. `ALLOW_CORPUS_DROP=1 pnpm --filter @bible-artisan/api db:migrate:down`. DROP fires no row or TRUNCATE triggers, so this opt-in is the only guard. The reversibility tests set it explicitly, and a test asserts the refusal without it.

**What the database cannot prevent, and how it is detected.**

- **The owner can bypass the triggers.** A table owner can `ALTER TABLE … DISABLE TRIGGER` (or drop the trigger) and then change rows. Verified on PostgreSQL 16 with a non-superuser owner role:
  - `CREATE EVENT TRIGGER` fails with "Must be superuser to create an event trigger", so no event-trigger guard is possible for a non-superuser owner.
  - `ALTER TABLE … DISABLE TRIGGER` succeeds for that owner.
  - `SET session_replication_role` is refused.

  No owner-proof guard exists inside the database without superuser.

- **Detection at startup.** The API recomputes the active pinned edition's content checksum in SQL once per process. It runs in the `ReadinessProbe`'s `onApplicationBootstrap`, before the app listens, on the probe's own short-lived connection. A mismatch with the pinned `contentSha256` makes readiness answer 503 with `corpus: 'corrupt'` for the life of the process. If startup could not reach a verdict (database down, release not imported yet, timeout), the first probe that finds the release active verifies it inside its single statement instead.
- **Cost.** Measured on the full corpus (31,103 verses and 138 superscriptions, local PostgreSQL 16): about 41 ms median end to end, 36 to 45 ms over 20 runs, against about 5 ms for the plain readiness check. That is cheap enough to hash the full text rather than a cheaper proxy, but not something to repeat on every probe. A tamper after startup is caught on the next restart, and re-running `corpus:import` also detects it via the stored checksum.
- **Production recommendation: separate roles.**
  - Run migrations and `corpus:import` as a migrator role that owns the corpus tables.
  - Run the API and worker as a separate app role that is not the owner and has only `SELECT` on `bible_edition`, `bible_book`, `bible_verse` and `bible_superscription`. That role cannot disable triggers or write the corpus at all.
  - Today the migrator, the importer and the API share one `DATABASE_URL`, so they run as one role that owns everything. Splitting it into `DATABASE_URL` (app) and a migrator URL with grants is a **deploy follow-up** for the first real deployment (hosting is undecided, see above). It needs no new infrastructure, only a second role and its grants.

**Readiness.** `GET /v1/health` also requires this build's pinned release (code, release, artifact SHA-256, and content SHA-256) to be active. The check is part of the same single statement as the migrations check, and the response gains `corpus: 'ready' | 'missing' | 'corrupt' | 'unknown'`:

- An edition with the pinned label but a different stored content checksum is `missing`.
- A stored text that no longer hashes to the pin, found by the startup integrity check above, is `corrupt`.
- A deployment that skipped `corpus:import` is not ready, and the web status line says "Bible corpus missing" (or "corrupt").

**Privacy.** The CLI logs one `corpus_import` line with counts (superscriptions included), checksums, edition code, release, and duration. The API logs one `corpus_integrity` line at startup with the verdict (`verified`, `corrupt` or `unverified`) and duration only. A failure is the usual `process_failed` line with a fixed `code` (e.g. `CORPUS_ARTIFACT_CHECKSUM`). Validation messages may name a verse, so they are never logged (NFR-PRIV-001). An integration test runs the CLI with production JSON logging and asserts the exact allowlisted line.

**Not in BIB-14:** aliases and reference parsing (BIB-15), `search_vector`/GIN (BIB-16), `/bible` routes and the reader (BIB-17), anchors (BIB-18), AI citation checks (BIB-41).

## Addendum (2026-10-01, BIB-15): Bible reference resolution

`POST /v1/bible/resolve` (`modules/bible-content/reference/`) turns typed input into one of: a canonical range, book candidates, a 422, or `not_reference`. It never returns verse text.

- **Corpus-driven, never typed.** Book names (`\toc2`), abbreviations (`\toc3`), USFM codes, chapter counts and per-chapter verse counts come from the active edition's rows. They are loaded once per edition and cached in process, which is safe because an activated edition is immutable. The only typed data is `EXPLICIT_BOOK_ALIASES` (`jn`, `mk`, `mt`, `lk`, `songofsongs`). `BookIndex` refuses to build if an alias names a missing book, and tests resolve every alias, name, abbreviation and code against the real corpus.
- **Matching.** Keys are normalized with the same explicit fold as the input (below), lower-cased, spaces and periods removed, Roman I–III mapped to digits. The candidates are the exact-key matches, plus books whose name starts with the token when the token has at least 2 letters. Book-only input never matches by prefix alone, so keywords such as "so" are not taken for books.
  - One candidate resolves.
  - More than one is `ambiguous`, never a silent pick. `Jud` (Jude's own `\toc3`) is ambiguous with Judges, as are `Ph`/`Phil` and `Jo`.
  - Only candidates whose chapter and verse exist in that book are offered (the single-chapter rule applies per book). If just one remains valid it is still returned as `ambiguous` with that one candidate, since the user typed an ambiguous key (`Phil 4:1` offers only Philippians). If none is valid, the first candidate's (canon order) 422 code is returned.
  - None is `not_reference`, or `REFERENCE_UNKNOWN_BOOK` when the input contained `:`.
- **Grammar** (anchored, linear): `B`, `B n`, `B n-n`, `B c:v`, `B c:v-v`, `B c:v-c:v`. Input is folded explicitly, not with NFKC: zero-width characters are removed, full-width ASCII (U+FF01–FF5E) maps to ASCII, dash variants become `-`, Unicode whitespace is collapsed, and only ASCII letters are lower-cased; input is capped at 200 characters. Any other numeric code point (superscript, subscript, circled, other-script digits) makes a reference `REFERENCE_MALFORMED`, so a footnote marker is never merged into a number (`Gen 1:1²` is not Genesis 1:12). A unit test sweeps every such code point.
  - In a book whose corpus `chapter_count` is 1, a bare number is a verse (`Jude 3` = Jude 1:3).
  - Book-only input opens chapter 1 (PRD §14).
  - Input that starts with a book and a digit but is not complete is 422: `REFERENCE_MULTIPLE_PASSAGES` for lists or cross-book ranges (a book after the dash needs two letters, so `9:1-3a` is malformed), otherwise `REFERENCE_MALFORMED`. It is not treated as keywords.
- **Never repair.** Chapter and verse bounds, start ≤ end, and ≤ 200 verses are each a specific 422 code with a fixed message that echoes nothing. No nearest verse is ever substituted.
- **`scripture_reference`** is a shared table with no owner. It is edition-bound and stands in for PRD §23's canon/versification pair until other editions exist.
  - Both endpoints are composite FKs to `bible_verse`.
  - A CHECK enforces start ≤ end. UNIQUE on the exact range per edition makes the id stable for every user.
  - Triggers refuse UPDATE, DELETE and TRUNCATE, because later tables point at these ids and deleting a range would let it be re-minted under a new id.
  - Its `down` refuses while rows exist unless `ALLOW_CORPUS_DROP=1` is set, the corpus opt-in, so a `down` past the corpus can't drop the ids and then stop at the corpus guard half-reverted.
  - The resolver inserts or selects in one statement (a CTE with `ON CONFLICT DO NOTHING`), with a second SELECT only when a concurrent insert won the race. Each edition's book index is loaded single-flight and a failed load is evicted. The route is authenticated but not owner-scoped, and it takes no `Idempotency-Key` or revision: it is a read plus a naturally idempotent upsert, not a study mutation.

## Addendum (2026-10-01, BIB-16): keyword search

`GET /v1/bible/search?q=&mode=terms|phrase&editionId=&book=&cursor=&limit=` (`modules/bible-content/search/`) searches verse text of an active edition. It is authenticated, not owner-scoped (shared corpus), read-only, and writes nothing.

**Index: a stored generated column, not a new table or an expression index.**

- `bible_verse.search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, translate(text, <corpus non-ASCII chars>, <as many spaces>))) STORED`, with a GIN index (migration `add_bible_verse_search_vector`). This is PRD section 23's `search_vector`.
- PostgreSQL computes it from `text` on insert, and refuses any written value (SQLSTATE 428C9). It is a pure function of the text the edition checksum already covers.
- Adding it rewrote the table without firing row triggers. The BIB-14 immutability triggers stay enabled, no `bible_verse` row was UPDATEd, and the edition content checksum is unchanged. A test asserts all three, plus `search_vector` equals the shared expression for every row.
- Measured on the full corpus (PostgreSQL 16, ranking the commonest word's 23,875 matches): about 230 ms with an expression index, because `to_tsvector` is recomputed per row for `ts_rank`; about 10 ms with the stored column.
- `down` drops the column and index; nothing is lost, since `up` rebuilds them. It still refuses while an active edition exists unless `ALLOW_CORPUS_DROP=1`. Each migration's `down` commits on its own, so an unguarded step would commit before a `down` toward the corpus is refused further on, leaving a half-reverted database.

**Locale independence.**

- PostgreSQL's default text-search parser classifies non-ASCII characters through the database's `LC_CTYPE`. Under `C` (common for containers and managed databases) every non-ASCII character counts as a letter. A raw `to_tsvector('simple', text)` then keeps `lord’s` or `“behold—you` as one lexeme, and the prefilter silently drops every verse where a word touches a curly quote or an em dash. Under `en_US.UTF-8` they split.
- Fix: `translate` blanks every non-ASCII character of the corpus to an ASCII space before parsing. ASCII is classified the same in every locale. The list is `SEARCH_VECTOR_BLANKED_CHARS` (`search/search-vector.ts`): U+00A0 no-break space, U+2014 em dash, U+2018/U+2019 single quotation marks, U+201C/U+201D double quotation marks. None is a letter, mark or digit. The candidate query applies the same `translate` to its tokens (a no-op, since tokens never contain them, kept as defense in depth).
- The list was derived from the corpus, not typed from memory. `test/search-vector-locale.int-spec.ts` re-derives it from the imported `bible_verse.text` and fails if any non-ASCII character is added or removed. A non-ASCII letter would also fail it: `C` lower-cases ASCII only, so it needs its own decision and a migration.
- The migration freezes the expression as a literal (a migration never imports code that may change). Tests assert the live column expression equals the one built from the constant, and that every row's vector equals it.
- Defense in depth: the migration's `up` probes `to_tsvector` on a fixed string with one word on each side of every blanked character, and refuses to finish (fixed, content-free error) unless each word is its own lexeme.
- The same suite creates a temporary `LC_CTYPE 'C'` database (`template0`, UTF8), runs every migration and imports the pinned corpus there. It shows the raw expression loses more than 1,000 verses there, and asserts the stored vectors equal the test database's (en_US) for all 31,103 verses. It also asserts no token is lost, and runs the production candidate query for word pairs touching a blanked character. It drops the database afterwards; it needs `CREATEDB`, which `pnpm db:setup` and CI already have. Against the old expression, three of its five tests fail.

**The index only narrows; the stored text decides.**

- Candidates come from `search_vector @@ plainto_tsquery('simple', <tokens>)`, an AND of every query token.
- `search-text.ts` decides every result against the verse text exactly as stored. A candidate the text does not support is dropped, never shown, so a stale or tampered vector could only hide a verse, never invent one.
- The prefilter never loses a true match. An integration test proves that, for every verse, the PostgreSQL lexemes of each of its tokens are in its `search_vector`.

**`simple`, not `english`.** PRD section 14 asks for "all entered terms" and "no inferred synonym expansion". The `english` stemmer returns verses that do not contain the typed word, and its stopword list silently drops words such as "the" or "I". With `simple`, a term is the literal word, lower-cased. Tradeoff: `loves` does not find `love`; a test asserts no inflection is returned.

**Tokens.** A query first goes through `foldTypedInput` (`bible-content/typed-input.ts`), the one fold the BIB-15 reference parser applies too, so an input is a reference in search exactly when `POST /bible/resolve` reads it as one. The fold applies NFC, removes invisible characters (soft hyphen U+00AD, zero-width space/joiners U+200B..U+200D, word joiner U+2060, BOM U+FEFF), and folds full-width ASCII. NFC means a canonical equivalent such as the Kelvin sign U+212A reads as `K` in references too. Compatibility characters (`²`, `Ⅱ`) are still kept as typed, never NFKC. A _token_ is then a maximal run of Unicode letters, marks or digits, compared lower-cased; everything between two tokens is their separator. Query operators (`& | ! : * ( ) < > ' \`) are separators, never syntax. The query reaches SQL only as these tokens, as a bind parameter, through `plainto_tsquery`; there is no `to_tsquery` and no regular expression built from input. A query needs 1 to 20 tokens and at most 200 characters.

**Terms mode:** every distinct query token is one of the verse's tokens. Highlights mark every occurrence.

**Phrase mode, "contiguous" defined:**

- The query tokens occur as consecutive verse tokens, and each separator between them equals the query's after normalization.
- Normalization removes whitespace (including the publisher's U+00A0), quotation marks and apostrophes, and hyphens, and maps en dash, em dash, figure dash, horizontal bar and minus to one dash.
- All other punctuation must match. A phrase never matches across a full stop, comma or dash the user did not type: punctuation normalization never invents adjacency.
- Consequences: `Lord's` finds `Lord’s`, and a space finds `Beth-shemesh` or a no-break space.
- Punctuation before the first or after the last token is ignored, so surrounding quotes are optional.
- Tsquery `<->` is not used. PostgreSQL gives a hyphenated compound an extra position, so `<->` would miss true phrases across one, and it ignores punctuation, which would invent adjacency.

**Highlights** are `[start, end)` offsets in Unicode code points into the returned `text`, which is the stored text, byte for byte. Nothing is reconstructed, and `ts_headline` is not used.

**Order, pages, bounds.**

- Order is `ts_rank` descending, then canonical order (book sequence, chapter, verse).
- The cursor is an opaque keyset: the last scanned candidate's rank, exactly as PostgreSQL printed the float4, plus its canonical position. It is bound to a fingerprint of mode, tokens, separators, edition and book filter, so a cursor from another query is refused with 400.
- `limit` is 1 to 100 (default 25). One request examines at most 1,000 candidates in at most three round trips: `limit + 1` first, then the rest of the bound, then a one-row look-ahead. A page may therefore hold fewer than `limit` results.
- `nextCursor` is non-null exactly when unscanned candidates remain. Following it never repeats or skips a result; a test traverses whole result sets against an independent oracle.

**Reference precedence (PRD section 14).**

- In terms mode, a reference with a chapter or verse gets 422 `SEARCH_QUERY_IS_REFERENCE` (fixed message) and no keyword results, as does an invalid reference shape. Examples: `Dan 3`, `Rom 9:1`, `Phil 4:1`, `Gen 99:1`, `Rom 9:1, 3`.
- Product decision (pipeline owner, merge gate): book-only input is not refused. That is a book name, abbreviation, code or alias with no numbers (`Job`, `Acts`, `Dan`, `Mark`, `Joshua`). Many book names are also ordinary words, and refusing them would make those words unsearchable. Such input is searched as keywords normally. The response also carries `referenceSuggestion`: exactly what `POST /bible/resolve` answers for that input. That is either `resolved` (the book's first chapter, as BIB-15 resolves a book-only reference) or `ambiguous` (the candidate books), so the client can offer "Open <Book>". `referenceSuggestion` is `null` otherwise and in phrase mode, and is repeated on every page.
- Classification uses `ReferenceService.searchPrecedence`, which reads the cached book index and persists nothing. The suggestion is built only after the page is ready, so a refused request (bad cursor, unknown edition) writes nothing. A `resolved` suggestion upserts the shared `scripture_reference` row exactly as `resolve` does, the endpoint's only write; an `ambiguous` one writes nothing. A test drives every book name, abbreviation, code and alias from the corpus: each returns 200 with first-page results matching an independent oracle and a suggestion equal to `resolve`'s, and never 422.
- Phrase mode is explicit literal text and is never treated as a reference.
- A client with one input box calls `POST /bible/resolve` first and searches on `not_reference`. The search UI belongs to the reader work (BIB-17); this ticket ships the API only.

**Performance (NFR-PERF-002).**

- An integration test sends 100 concurrent requests to one app instance (pool of 10 connections) over a worst-case mix: the commonest word, the two commonest with `limit=100`, the commonest word twice as a phrase (full scan bound, almost nothing verifies), a common phrase, and a mid-frequency word.
- Latency is **server** latency, as the NFR states it: each request's `durationMs` from its own access line, from the first middleware to response finish.
- NFR-PERF-002 (p95 ≤ 750 ms) is a production target. It is verified by the recorded measurements below and by BIB-52 on deployment hardware, not by a hard 750 ms gate on shared CI runners, which would flake. The test's hard assertions:
  - Each worst-case query, served alone (three times each), finishes within 750 ms. It takes tens of milliseconds, so this is robust.
  - The p95 of the 100 concurrent requests is computed and printed on every run (`[NFR-PERF-002] ...`, numbers only). It is held to `SEARCH_P95_BUDGET_MS`, 750 by default (local runs) and 2000 in CI (`.github/workflows/ci.yml`).
- After the merge-gate fixes, locally (full file): alone max 26 ms; concurrent p50 133 ms, p95 227 to 255 ms over five runs. Run on its own, p95 is 152 to 180 ms with the query-side `translate` and 160 to 204 ms without it, so the `translate` costs nothing measurable.
- On the shared 2-vCPU GitHub runner (run 36865819602): alone max 47 ms; concurrent p50 697 ms, p95 1,218 ms. The same code had passed a hard 750 ms gate one run earlier, which is why CI holds the concurrent p95 to 2,000 ms rather than to the production target.
- Locally (PostgreSQL 16, Apple silicon), three runs measured server p95 171, 183 and 204 ms (p50 120 to 134 ms).
- The first CI run timed requests from the in-process test client on a 2-vCPU GitHub runner: p95 922 ms, failing. That figure included client-side work in the same process, and it predates the phrase single-fetch below.
- Changes made to get here:
  - The scan bound went from 2,000 to 1,000 candidates.
  - Phrase mode fetches its whole bound in one query instead of ranking all matches again per batch.
  - `ts_rank` is computed once per row.
  - Separators are canonicalized only where a phrase's words already match, with a fast path for the plain space.
  - Verification costs about 3.4 µs of Node CPU per candidate verse.
- `EXPLAIN` of the production candidate query shows the GIN index (`bible_verse_search_vector_idx`); a test asserts it for a selective query. For the commonest words the planner may choose a sequential scan (about 10 ms).
- Benchmarks on deployment hardware belong to BIB-52.

**Privacy.** The query travels in the URL (PRD section 24), but `requestLogging` logs only the route pattern. Errors are fixed strings. `test/log-redaction.int-spec.ts` sends sentinel queries and cursors on 200, 400, 404 and 422, and asserts that neither they nor the returned verse text, labels or cursor appear in any log line.

**Not in BIB-16:** the search screen (BIB-17), anchors (BIB-18), `search_performed` events (BIB-55), study/library search (BIB-21), searching Psalm superscriptions (verse text only in MVP), and semantic search (post-MVP).

## Addendum (2026-10-01, BIB-17): the reader

`GET /v1/bible/translations`, `GET /v1/bible/passages` and `POST /v1/bible/references` (`modules/bible-content/`) serve the reader. All are authenticated and not owner-scoped (shared corpus). The only writes are idempotent upserts of shared `scripture_reference` rows, as `POST /bible/resolve` already does.

- **One chapter per response, by reference only.** The chapter is the reading context (PRD section 11). `GET /bible/passages?referenceId=` returns the chapter that holds the reference's start, with the reference, so the client marks its verses. A reference covering the whole chapter marks nothing. The longest response is Psalm 119 (176 verses).
- **The reference fixes the edition.** A `scripture_reference` row belongs to one edition, so the passage's edition is the reference's. PRD section 24's `editionId` is accepted but optional; when given it must be the reference's edition, else 404. A bookmark (`/bible?ref=`) therefore keeps opening the same edition when another edition is activated. The first version defaulted to the first active edition by name, which would have broken bookmarks.
- **Structured navigation, no text round-trips.** `previous`/`next` carry the neighboring chapter's whole-chapter `referenceId`; the server upserts those rows with the same identity rules as `resolve` (BIB-15). So Previous/Next is a single request. The book/chapter picker, a translation change, and opening a search result use `POST /bible/references` with `{ editionId, bookCode, chapter, verse? }`. It validates against the corpus index (422 with the BIB-15 reference codes, never a nearby chapter) and returns the same shared reference `resolve` gives for that range. The single-chapter-book rule lives only in the server (`BookIndex.chapterRange`), and a unit test proves that for all 1,189 chapters it matches resolving `<Book> <n>` (or the bare name).
- **Attribution is cached with the index.** An activated `bible_edition` row is immutable (BIB-14 triggers), so `ReferenceService` caches each active edition's attribution with its book index. A warm passage read makes no edition query.
- **Verbatim, never repaired.** Verses and superscriptions are the stored rows, byte for byte. The 5 verses with empty text come back as `text: ''`, and the web shows the number with "No text for this verse in this edition." Psalm titles and stanza headings stay in `superscriptions` and are never merged into verse text. A `referenceId` that is unknown or bound to another edition is 404. Nonexistent chapters and verses are refused by `POST /bible/resolve` and `POST /bible/references` (422), never repaired.

  An integration test walks all 1,189 chapters, starting from Genesis 1, by following each response's `next.referenceId`, exactly as the web does. It compares each whole body to the stored rows.

- **Attribution** (`bible_edition.attribution` plus the rights record's publisher notice URL, validated with `httpUrlSchema`) comes with every passage and is shown beside the text and under search results.
- **Performance (NFR-PERF-001).** Measured locally, over three runs: 100 concurrent requests, p95 2.3 to 3.4 ms; single requests at most 3.6 ms. The test holds p95 to `READER_P95_BUDGET_MS` (500 locally, 2,000 in CI, like BIB-16). BIB-52 measures on deployment hardware.
- **URL and privacy: opaque ids only.** PRD section 9 allows stable query parameters for reader state, but a reference in a URL also lands in browser history and in every request log on the way. The Next dev server prints `GET /bible?book=ROM&chapter=9`, and hosting proxies log URLs the same way. AGENTS.md rule 6 and NFR-PRIV-001 keep Scripture references out of logs.

  So `/bible` holds only `ref=<scripture_reference id>`. Previous/next use the id the link carries. The picker, a translation change and a search result send book code and numbers in the body of `POST /bible/references`, and typed text goes in the body of `POST /bible/resolve`; request bodies are never logged. Only the resulting id goes in the URL.

  - Overlapping navigations are ordered on the client: each one the user starts takes a sequence token, and only the latest token's result is applied, so the last-initiated chapter wins.
  - The search text stays in component state only, and nothing goes to localStorage.
  - The API logs route patterns only. `log-redaction.int-spec.ts` covers both routes.
  - `GET /bible/search?q=` still carries the query in the API URL, as PRD section 24 specifies (BIB-16); our logs record only its route pattern.

- **Search UI (deferred from BIB-16).** One input resolves first (`POST /bible/resolve`):
  - `resolved` opens the reference;
  - `ambiguous` offers the candidate books;
  - a 422 shows the correction and runs no keyword search;
  - `not_reference` runs a terms search.

  A quoted input or "Exact phrase" goes straight to phrase search. The `referenceSuggestion` shows as "Open <label>". Results and candidates are kept per edition. Changing the translation drops them, so they never show under another edition's attribution, and a result opens in the edition it was found in. "Recent local Bible searches" (PRD section 11) is deferred, because it would persist queries on the device.

- **Errors in the UI** are chosen from status and `code`; a server `message` is never rendered. 429/503 (and envelopes marked `retryable`) offer Retry, held until `Retry-After`. A 401 re-checks the session, so `RequireAuth` sends the user to sign in with `next` set to the current path.

- **Not in BIB-17:** the study inspector mount, `POST /studies/:id/activity` and visit events (FR-BIBLE-008; no study can exist before BIB-19, so this belongs to BIB-55 and the workspace ticket), anchors/selection (BIB-18), phone tabs (BIB-38), and offline chapters.

## Addendum (2026-10-01, BIB-18): durable verse and phrase anchors

`POST /v1/bible/anchors` and `POST /v1/bible/anchors/resolve` (`modules/bible-content/anchor/`) build and re-check durable Scripture anchors (FR-BIBLE-006, PRD sections 14 and 23). Both are authenticated and not owner-scoped (shared corpus), and take no `Idempotency-Key` or revision.

- **An anchor is a value, not a row.** No study can exist before BIB-19, and `Annotation`/`Note` persistence (`anchor_json`) belongs to BIB-24, so this ticket adds no table, no migration, no study mutation and no StudyEvent. The only write is the idempotent upsert of the shared `scripture_reference` row for the anchor's verses (`ReferenceService.rangeReference`, the same statement `resolve` uses). BIB-24 stores the anchor and its unresolved state inside its own mutation.
- **Model (`scriptureAnchorSchema`, version 1):** `editionId`, `bookCode`, `kind: 'verses' | 'phrase'`, `segments[]` (1 to 200, one per verse: `chapter`, `verse`, `start`, `end`, `textSha256`), and `quote`.
  - `start`/`end` are half-open Unicode **code points** into the verse's stored text, the same unit as BIB-16 highlights. DOM and UTF-16 offsets never leave the browser.
  - `textSha256` is the stored `bible_verse.text_sha256`. The server fills it on capture; a client never supplies it.
  - `quote` is the non-empty slices joined by one U+0020 (`joinAnchorQuote`, shared by web and API). Verse text holds no line breaks or doubled spaces (BIB-14 rules), so the join is unambiguous.
- **Rules** (`anchor-check.ts`, pure and unit-tested). Every failure is a fixed `ANCHOR_*` code; nothing is ever moved to nearby offsets or verses:
  - verses exist in the edition/book (`ANCHOR_VERSE_NOT_FOUND`) and are consecutive in canon order, crossing a chapter boundary only from its last verse (`ANCHOR_NOT_CONTIGUOUS`);
  - on resolve, each checksum equals the stored one (`ANCHOR_CHECKSUM_MISMATCH`);
  - `end` is within the text (`ANCHOR_OFFSET_OUT_OF_RANGE`; `start > end` is a 400);
  - `verses` covers whole verses, empty verses included (`ANCHOR_KIND_MISMATCH`);
  - a `phrase` is contiguous text: the first segment runs to its verse's end, interior verses are whole, the last starts at 0 (`ANCHOR_NOT_CONTIGUOUS`), and it starts and ends on non-empty text (`ANCHOR_EMPTY`), so it may pass through LUK 17:36 but not stop on it;
  - the quote equals the stored slices exactly, with no folding of quotes, dashes or U+00A0 (`ANCHOR_QUOTE_MISMATCH`).
- **Capture** answers 422 with the code, or 404 for an unknown or inactive edition. **Resolve** always answers 200: `resolved` with the anchor unchanged, or `unresolved` with the first failing `reason`, the anchor exactly as sent (so the original quote survives), and the verses' reference when they still exist (for Reselect), else null. One primary-key range scan reads the anchor's verses.
- **Limits.** At most 200 segments (the reference cap), so a longer anchor is a 400, not a separate 422. Offsets are capped at 2,000; the longest verse is 491 code points. The quote is capped at 40,000 characters; the longest run of 200 consecutive verses in the corpus is 35,606 characters (36,196 UTF-8 bytes), measured with a window query over `bible_verse`. Every real anchor therefore fits the API's 100 kB JSON limit, and anything larger is 413.
- **Browser mapping** (`apps/web/src/components/bible/selection.ts`). Each verse's text is rendered alone in a `data-verse-text` element. Checkboxes, verse numbers, superscriptions and the "no text" note are outside it and `select-none`.
  - Firefox splits a selection into several ranges around `user-select: none` nodes; the reader maps one span from the earliest start to the latest end (`spanOfRanges`, compared with `compareBoundaryPoints`).
  - A DOM `Range` is measured per intersecting verse element, from its start to the boundary point, with `Range.toString()`, so nested marks do not matter.
  - The UTF-16 length is converted to code points. An offset inside a surrogate pair rounds outward.
  - Spaces and U+00A0 at either end are trimmed by moving offsets.
  - An element whose text is not exactly the stored verse makes the mapping return null, never a guess.
  - Mapping runs at most once per animation frame, never during a pointer drag (once on release), and only when the selection's boundary points changed. Keyboard selection (shift+arrows) has no pointer and maps on the next frame.
  - A text selection inside the verse list that holds no verse text (a superscription, a "no text" note) clears the reader's selection. A collapsed selection, or one outside the list, leaves it alone.
- **Keyboard equivalent (WCAG 2.1.1).** A "Select verse N" checkbox per verse (PRD section 14's checkbox affordance), and a "Select a phrase" form with From verse / First word / To verse / Last word selects.
  - Words are U+0020-separated runs, listed verbatim.
  - Focus moves into the form when it opens, to Capture after Select, and back to the toggle on Cancel or Escape.
  - The keyboard path selects whole words; partial words are pointer-only.
- **Selection state** is component state keyed to edition + book + chapter, so a chapter or translation change clears it (PRD section 14). The verse list is keyed by passage too (no DOM node is reused for new text), and a native text selection in the reader is dropped when the passage changes. It is never in the URL or browser storage. The Selection region shows what is selected, Capture and Clear, and the captured anchor as returned by the server.
  - Capture and Clear use `aria-disabled` with guarded handlers, never native `disabled`, so focus stays on them while a capture is pending and after Clear.
  - The selection summary, the "not next to each other" message, "Selection cleared.", and capture progress are announced through the reader's one persistent live region (references only, never the quote).
- **Privacy.** Quotes, offsets and references travel only in POST bodies. `log-redaction.int-spec.ts` covers both routes on 200, 422 and unresolved.
- **Client scope.** The web app calls only capture. `POST /bible/anchors/resolve` ships here as API (with its tests); the client call and the unresolved quote UI (original quote, said in words, with Reselect) ship with BIB-24, which stores anchors.
- **Not in BIB-18:** saving highlights or notes (BIB-24), Scripture nodes from a selection (BIB-25/26), selection activity events (BIB-55), rendering saved highlights in the reader, and phone tabs (BIB-38).

## Addendum (2026-10-01, BIB-19): creating a study

`POST /v1/studies` and `GET /v1/studies/:studyId` (`modules/study/http/`). Creation makes, in **one transaction**: the study, a Scripture root node for the starting passage, a Question node for the question, the initial branch, and one `study_created` event. Each of the root node and branch exists only when the request supplies what it needs.

**Creation is an entry point of the mutation pipeline, not a bypass.** `MutationService.create(ownerId, request, { study, work })` shares `execute`'s transaction shell:

- one READ COMMITTED transaction, with the reply only after COMMIT;
- the receipt claim, fingerprint and replay, and 422 on key reuse;
- the counters written in one UPDATE.

Only step 2 differs:

- It INSERTs the study, with the owner from the session, instead of `SELECT … FOR UPDATE` on an existing row. Lock order stays receipt → study → children: the insert holds the new row's lock, and nobody else can see the row before COMMIT.
- `StudyMutation` runs in creation mode. No revision check is required, since there is nothing a client could have seen, so there is no `expectedRevision` and never a 428. An `expectedRevision` in the body is an unknown key (400). At least one event is still required.
- Children are inserted through `m.createChild`, which takes `study_id` and `owner_id` from the lock.
- `m.updateCreatedStudy` sets the question pointers on the new row while the study stays at revision 1. It is refused for an existing study.
- A concurrent duplicate with the same key blocks on the receipt's unique index and then replays the one study. Integration tests race six requests through a gate transaction that holds the `(owner, key)` receipt and then rolls back.

**Data.**

- `study_node` gains `title`, `question_status` and `scripture_reference_id`, with CHECKs:
  - the six MVP types;
  - `question_status` on, and only on, questions;
  - a 1–4,000-character statement on questions;
  - a reference on, and only on, Scripture nodes.
- `study` gains `starting_reference_id` plus `original_question_node_id` and `main_question_node_id`. The two pointers are composite FKs `(owner_id, id, node, question_node_type) → study_node (owner_id, study_id, id, type)`. `question_node_type` is a STORED generated constant `'question'` on `study`, and the target is the new `UNIQUE (owner_id, study_id, id, type)`. A pointer can therefore only name a **Question** node of the same study and owner. Node type is immutable (PRD section 8), and the same FK refuses a type change on a node a pointer names. A trigger was not needed: the declarative FK is enough because the type never changes.
- New `study_branch` table (id, study, owner, root node, created_at), with composite FKs to the study and to its root node (through `UNIQUE (owner_id, study_id, id)`).
- `scripture_reference` is edition-bound, so PRD section 23's `starting_translation_id` is unnecessary, and its "both or neither" rule holds by construction.
- Since studies and nodes now reference `scripture_reference`, PostgreSQL itself refuses a plain `TRUNCATE` of it before the immutability trigger runs. `TRUNCATE … CASCADE` still reaches the trigger, and a test covers both.

**Hard delete: one statement, cascading.** The PRD needs a 30-day trash purge (BIB-22) and account deletion, so `DELETE FROM study WHERE …` or `DELETE FROM "user" WHERE …` must work without manual ordering.

- `study_node`, `study_event` and `study_branch` reference `study (owner_id, id)` with `ON DELETE CASCADE`. This migration alters the BIB-9 node and event FKs, which were NO ACTION, and its `down` restores them.
- `study.owner_id → user` is `ON DELETE CASCADE` too. `auth_session` and `mutation_receipt` already cascaded from `user`. Deleting a user removes their sessions, receipts, studies and every study row.
- The study → question pointers and the branch → root node FKs stay NO ACTION. NO ACTION is checked at the end of the statement, after the cascade has removed both sides, so the cycle never blocks a study or user delete. Deleting a node on its own while a pointer or branch still names it is refused (nodes are soft-deleted anyway).
- `mutation_receipt` is owner-scoped, not study-scoped: a deleted study's creation receipt stays until it expires or the account is deleted. Replaying it returns the original 201, and the study then reads as 404.
- The FKs to `scripture_reference` never fire: those rows are never deleted (BIB-15 triggers).
- Integration tests delete a created study (question, Scripture node, branch, event, receipt) and a user, and assert no orphans. Test cleanups now delete users only.

**Guarded `down` for study data (`ALLOW_STUDY_DATA_DROP=1`).** Each migration's `down` commits on its own. Without a guard, a `down` toward the corpus would commit the study-roots drop (question statements and statuses, Scripture references, pointers, branches) before the corpus guards refused further down.

- The study-roots `down` refuses with a fixed, content-free error ("study roots drop refused: study data exists (set ALLOW_STUDY_DATA_DROP=1)", SQLSTATE 23000), changing nothing, while any of that data exists: a `study_branch` row, or a non-null `study_node.title` / `question_status` / `scripture_reference_id`, or a non-null study starting reference or question pointer.
- For consistency, the BIB-9 `user`, `study`, `study_node` and `study_event` downs refuse the same way while their table has any row. The auth and receipt tables are transient (they expire) and are not guarded. A real database keeps an active corpus, and the corpus guards stop a `down` before any of the BIB-9 steps are reached.
- The opt-in is distinct from `ALLOW_CORPUS_DROP`, so dropping the corpus never implies dropping user data. Example: `ALLOW_STUDY_DATA_DROP=1 pnpm --filter @bible-artisan/api db:migrate:down`.
- The reversibility suite seeds a full study, then runs `down --to <corpus>` from latest with no opt-ins. It asserts the refusal comes at the first step and that tables, columns, SequelizeMeta and the seeded rows are unchanged. Another test checks each BIB-9 guard. Tests that revert further set both opt-ins (`test/support/study-data-drop.ts`).

**User text (`userTextSchema`, contracts).** Free text a user types (study `title` and `question`, `POST /bible/resolve` `input`, `GET /bible/search` `q`) goes through one shared schema. It trims, applies the length bounds, and refuses C0 control characters other than tab, line feed and carriage return, as well as unpaired UTF-16 surrogates. PostgreSQL `text` rejects U+0000, which previously surfaced as a 500 inside the creation transaction. A refusal is a 400 `VALIDATION` with the fixed field error "Remove control or invalid characters", raised before any transaction or receipt. The text is never echoed. The web form runs the same check before sending.

**`study_created` event and BIB-55.** The event's node and branch ids live only in `payload_json` (`scriptureNodeId`, `questionNodeId`, `branchId`). BIB-55 owns StudyEvent's `node_id` / `branch_id` columns. When they land, existing `study_created` rows need a backfill from `payload_json`. This is recorded on BIB-55.

**Decisions.**

- **The passage is sent as `startingReferenceId`, not as text.** The form resolves typed input through `POST /bible/resolve` first, so ambiguity is handled in the UI, the create route never parses Scripture text, and only ids travel. PRD section 24's example sends `{ input, editionId }`.
- **The reference is checked before the transaction.** `ReferenceService.storedReference` validates it: the row must exist and its edition must be active. A failure is 422 `REFERENCE_NOT_FOUND`, and nothing is written, not even a receipt. The check cannot go stale before COMMIT, because reference rows are immutable and an activated edition stays active. The FK is the backstop.
- **Title.** The typed title; else the reference label; else the question cut to 200 UTF-16 units on a character boundary; else `Untitled study`.
- **Branch root.** The question when there is one (PRD section 10), else the passage. A blank study has no node and no branch.
- **Event payload.** `study_created` carries ids and the reference label only, never the title or question.
- **Deferred to BIB-33.** `sessionId` in the 201 (PRD section 24 lists it), the `study_session` row, branch memberships, and `session_started` events. Sessions start on the first meaningful action and are per browser tab, which is BIB-33's model.
- **Web.**
  - The `/studies/new` form keeps its draft in page state only, never in localStorage.
  - It reuses an Idempotency-Key only for a byte-identical body. Retry re-submits the draft as it is now: an unchanged draft resends the same body with the same key, and an edited draft goes out with a new key. One key never carries two bodies, so normal use can't get 422 `IDEMPOTENCY_KEY_REUSED`.
  - Leaving the passage field and then pressing Create shares the running check, so the passage is resolved once.
  - A minimal `/studies/[studyId]` page reads the study back.

**Privacy.** No new log lines. `log-redaction.int-spec.ts` covers both routes on 201, replay, 400, 422, 200 and 404.

**Not in BIB-19:** editing the title or questions (BIB-20), the library and `last_activity_at` (BIB-21), archive and trash (BIB-22), notes (BIB-23), the node API and other node columns (BIB-25), canonical Scripture dedup (BIB-26), sessions and branch membership (BIB-33), the offline queue (BIB-36), and the workspace itself.

## Addendum (2026-10-01, BIB-20): editing a study

`PATCH /v1/studies/:studyId` (`modules/study/http/`) edits the title, description, main question, pin and tag set through `MutationService.execute`.

**One revision, checked first.**

- `study.revision` covers every editable field. Any successful edit bumps it once, so a concurrent edit to a different field still gets 409. The client reloads and reapplies its draft; field-level merge is BIB-37.
- The work compares revisions before anything else, so a stale edit is always 409, whatever else the body says.
- The web form diffs its draft against `base`: the study as last saved (from the 200, including a replayed one) or reloaded, never a copy a background refetch brought in, and sends `base.revision`. "Reload latest" rebases: a field the user did not touch takes the reloaded value, a touched one stays a pending change. So Save sends only the fields the user changed, and never resends an untouched field's old value.
- Every request is frozen once sent: its exact body (including `expectedRevision`) and its Idempotency-Key. After a failure whose outcome is unknown (network, 5xx), Retry, or Save with an unedited draft, resends it verbatim, so a save that committed but lost its response gets the original 200 replayed. Rebuilding it from a refetched study would carry a new revision, hence a new key, and apply the edit twice (a second Question node) or answer `STUDY_UNCHANGED`. Editing the draft discards the frozen request; the next Save is a new request with a new key from the current `base`.
- On a 200 a field shows the saved value only if the draft still holds what the save assumed (the value sent, or the base value for an unsent field). Anything typed while the save was in flight stays as a pending change.

**No-op edits.**

- A field equal to its current value is not a change. Tag deltas that are already applied are no change.
- An edit with no change at all is 422 `STUDY_UNCHANGED` and rolls back (no receipt). The pipeline requires an event, and there is nothing true to record.

**Content revision.**

- `content_revision` moves only for a new title, description or main question. Pin and tags are organizational and must not stale the summary.
- `StudyMutation.bumpContentRevision()` lets the work decide this under the lock (`bumpsContentRevision: false` on the spec).

**Main and original question.**

- `mainQuestion: { text }` creates a new open Question node; `{ nodeId }` points at a live Question node of the study. Another study's node, another user's node, or an absent one is 422 `QUESTION_NOT_FOUND`, all the same.
- Question text is never edited here (BIB-25), so the original question's text cannot change.
- `original_question_node_id` is set once. A study created without a question takes its first main question as its original. The `study_original_question_immutable` trigger refuses any later change; a study DELETE is not an UPDATE, so hard delete still cascades.
- A blank study's first question also roots its initial branch, as at creation.

**Tags.**

- `tag (owner_id, name, normalized_name)` is one vocabulary per owner, with `UNIQUE (owner_id, normalized_name)`.
- `study_tag` has composite FKs `(owner_id, study_id) → study` and `(owner_id, tag_id) → tag`, both cascading, so another owner's tag is unwritable on a study.
- Normalization (`normalizeTagName` / `tagKey` in contracts):
  - the display name is NFC, trimmed, with whitespace runs collapsed; it otherwise keeps what the user typed;
  - the key folds further: NFKC; format characters (`\p{Cf}`: zero-width space and joiners, BOM, bidi controls) and the characters `userTextSchema` refuses are removed; `İ` and `ı` become `i` (and `i` + U+0307 becomes `i`); then `toLowerCase().toUpperCase().toLowerCase()`, which approximates full case folding (`ß`/`ẞ` → `ss`, final sigma → `σ`); whitespace collapsed. The dotted/dotless I choice is language-neutral: "İstanbul", "Istanbul" and "istanbul" are one tag in every locale, at the cost of Turkish "ılık" and "ilik" also being one. Changing `tagKey` needs a data migration;
  - names are 1–50 characters, and a name whose key is empty (only format characters) is refused.
- **Tags travel as deltas**, `tags: { add?: string[], remove?: string[] }`, not as the whole set. A whole set built from a device's stale copy silently drops whatever another device added meanwhile; deltas compose. Additions are names (the user typed them, and an existing tag of the owner with the same key is reused); removals are tag ids from `StudyResponse.tags`, so a removal names exactly the tag the client saw. Removals apply first, so `remove: [id], add: ["New Casing"]` recases a tag no other study uses.
  - An add whose key the study already carries, and a remove of an id it does not carry (removed already, another study's, another owner's, absent), is a no-op for that item. Same-key adds or repeated ids in one request are 400 `TAG_DUPLICATE`; an empty delta is 400.
  - If the whole edit changes nothing it is 422 `STUDY_UNCHANGED`, as before. `study_tags_changed {addedTagIds, removedTagIds}` lists only real changes.
  - At most 20 tags per study, checked after applying under the study lock: 422 `TAG_LIMIT_EXCEEDED`.
  - The web form keeps pending adds and removes against the saved tags and shows saved tags minus pending removals plus pending adds, so after Reload latest the other device's tags appear next to the user's own pending changes.
- **Unused tags are deleted.** When an edit removes a study's last reference to a tag, the tag row goes in the same transaction, so private tag text does not linger and a later add takes the new display casing. An existing tag otherwise keeps its first display name. Tag management is not in the MVP.
- Concurrency between studies of one owner (different study locks):
  - New tags are inserted with `INSERT … ON CONFLICT DO NOTHING` in key order, then selected `FOR KEY SHARE`. Two studies adding the same new tag converge on one row (a test races them through a gate transaction holding the tag key).
  - The orphan cleanup locks the candidate rows `FOR UPDATE` first, then runs `DELETE … WHERE NOT EXISTS (study_tag)` as a new statement. An adder that locked first makes the cleanup wait and then see its pairing; a cleanup that locked first makes the adder's `FOR KEY SHARE` skip the deleted row, and the adder inserts it afresh. A single `DELETE … NOT EXISTS` would not do: after waiting on a lock PostgreSQL deletes the row without re-running the subquery, and the cascade would drop the other study's new pairing. A gate-pattern test races a remover against an adder.
  - Two studies that each remove a tag the other adds at the same moment can deadlock; PostgreSQL aborts one, which answers the retryable 503 `TRANSIENT_CONFLICT`.

**Pin.** `study.pinned_at`, a study-level pin for the library's pinned group (BIB-21). No per-owner cap: the PRD sets none. Pinned nodes and citations are a different concept and are not in this ticket.

**Events** (ids and booleans only; the title, description, question and tag text never enter a payload):

- `study_renamed`
- `study_description_changed {cleared}`
- `question_created {questionNodeId, branchId}`
- `main_question_changed {fromNodeId, toNodeId, originalQuestionNodeId, branchId}` (`branchId` since BIB-25: the initial branch this change created when it made an existing question main, else null)
- `study_pinned` / `study_unpinned`
- `study_tags_changed {addedTagIds, removedTagIds}`

There is one event per real change. Intended visibility for BIB-55's column: renamed, question_created and main_question_changed are thread-visible; the rest are internal (PRD section 11: list actions make no reasoning events).

**Data and down.**

- New CHECKs: `study.title` 1–200 and `description` NULL or 1–2,000. The description limit is an assumption: the PRD sets none, and 2,000 matches the edge-note bound.
- The migration's `down` refuses while any tag or pin exists unless `ALLOW_STUDY_DATA_DROP=1`. Descriptions survive a `down`, because the column predates it.

**Not in BIB-20:** the library and tag filter (BIB-21), archive and trash with the `STUDY_ARCHIVED` guard (BIB-22), editing question text or status (BIB-25), the save coordinator and conflict-review UI (BIB-35, BIB-37), and the event visibility column (BIB-55).

## Addendum (2026-10-01, BIB-21): the study library

`GET /v1/studies?q=&tag=&state=active|archived&sort=recent|created|title&pinnedFirst=true|false&cursor=&limit=` (`modules/study/http/study-library.ts`) lists the signed-in user's own studies (FR-STUDY-004). The web library is `/studies`. Home shows the three most recently active studies (`sort=recent&pinnedFirst=false&limit=3`).

**Owner isolation.**

- Every statement filters `study.owner_id` by the session owner, and so do the tag and search subqueries (`study_tag.owner_id`).
- Another user's tag id is not an error: it matches nothing, so the page is empty, exactly like an owned tag on no listed study. A 400 or 404 would confirm the id exists.
- No totals or counts are returned.
- A cursor is sealed with the owner's id inside (see below), so a cursor from another user is a 400 and lists nothing.
- The route-inventory cross-user test runs Bob's listing, tag filter, searches for Alice's words, `state=archived` and Alice's cursor. It asserts the whole bodies.

**Search: a literal substring match on folded text, not tsvector or trigram.**

- `study.search_text` holds `studySearchText(title, description)`: `tagKey` (BIB-20's fold: NFKC, invisible characters removed, language-neutral case folding, whitespace collapsed) of each, one per line.
- **Final sigma.** `toLowerCase` picks "ς" or "σ" for "Σ" from the surrounding letters, so "ΑΣ" alone folded to "ας" while the same letters inside "ΑΣΤΗΡ" folded to "ασ", and the fragment missed. `tagKey` now maps "ς" to "σ" after case folding, as Unicode case folding does, so every character folds the same wherever it stands. The same function folds tag keys, search text, search words and the title sort key. The migration rewrites stored keys with `translate(…, 'ς', 'σ')`. That is exactly the new fold of each stored value, because no later step of the fold touches a sigma. An owner's tags cannot collide: the old fold picked the sigma form from context alone, so two keys differing only in sigma form could not exist. If one did, the unique constraint would abort the migration and nothing would change. Tests: "ΑΣ" finds "ΑΣΤΗΡ"; "Λόγος", "ΛΌΓΟΣ" and "λόγοσ" are one tag; the reversibility suite checks the rewrite and its `down`. The API writes it wherever it writes the title or description (`StudyRevisionService.create`, `PATCH`).
- The query goes through the same fold (`studySearchTokens`), split into 1–10 distinct words.
- A study matches when every word is a substring (`strpos`) of its `search_text`, or of the `normalized_name` of one of its tags. Each word is a bind parameter. There is no `LIKE` pattern to escape, no `to_tsquery`, and no regular expression from input, so `%`, `_`, `\`, `:*`, quotes and `&|!` are ordinary characters. A test asserts each one against an independent oracle.
- Why not `tsvector`: library search is for finding one's own studies by a remembered fragment ("consc", "Rom"). Prefix and mid-word matches matter more than relevance. BIB-16 also showed that PostgreSQL's parser and `lower()` depend on `LC_CTYPE` for non-ASCII text, which private user text cannot be blanked around. Folding in the API makes matching locale-independent.
- Why no trigram index (`pg_trgm`): every query is first narrowed to one owner's rows by the library indexes (below). Measured locally (PostgreSQL 16, one owner with 5,000 studies and 15,000 tag pairs, plus a second owner's 5,000 studies), a two-word search that matches nothing scans all 5,000 rows, with the tag subqueries hashed once, in 1.1 ms. A personal library is far smaller, so the trigram extension is deferred until measurements justify it (AGENTS.md rule 9).

- **Backfill caveat.** A migration never imports code that may change, so existing rows were backfilled with a SQL approximation (`lower(normalize(…, NFKC))`, whitespace collapsed). The API writes the exact fold on the study's next title or description change. No production data existed (hosting is undecided), so only development rows can carry the approximation.
- Not searched: question and node text, and notes (Library/Search with BIB-23).

**Order.**

- With `pinnedFirst=true` (the default, the library) pinned studies come first, then the rest; with `pinnedFirst=false` (Home's recent studies, PRD section 11: the three most recent, whatever their pin) one list. Within that, the sort, ties broken by id:
  - `recent`: `last_activity_at DESC`;
  - `created`: `created_at DESC`;
  - `title`: `title_sort_key COLLATE "C"` ascending.
- **Title collation.** `study.title_sort_key` is `studyTitleSortKey(title)`: the API's fold (`tagKey`) of the title, cut to its first 200 code points. The API writes it wherever it writes the title. The column is declared `COLLATE "C"` and the query says so explicitly, so the order is the code-point order of the folded title. It is case-insensitive through the fold and identical whatever the database's default collation or its ICU/libc version. The first version ordered `title` in the database collation: case-sensitive under `C`, and locale-dependent elsewhere (`en_US` puts "éclair" before "fig", code-point order after). The 200-code-point cut keeps the cursor small; titles whose folds agree that far tie and fall to the id. A test checks the order against a code-point oracle and against an explicit `ORDER BY title_sort_key COLLATE "C", id`, using titles that differ by case, accents, punctuation and Greek.
- The order is total, so keyset pages never repeat or skip a study that did not change in between. Tests traverse every sort, both groupings, with and without filters, at limits 1 to 23, against an oracle. The seeded timestamps tie at the minute and differ only in microseconds.

**Keyset query: one index range per pin group.**

- `study.is_pinned` is a stored generated `pinned_at IS NOT NULL`. There is one index per sort: `(owner_id, lifecycle, is_pinned, <sort value>, id)` in the listing's direction (`study_owner_library_recent_idx`, `…_created_idx`, `…_title_idx`). PRD section 23 asks for owner/lifecycle/last_activity/id.
- `libraryQuery` reads each pin group as its own subquery, ordered like its index and limited to `limit + 1`: `WHERE owner_id = $1 AND lifecycle = $2 AND [NOT] is_pinned AND (<sort value>, id) </> (cursor value, cursor id)`. The subqueries are merged with `UNION ALL` and an outer `ORDER BY … LIMIT` over at most `2 × (limit + 1)` rows. Once the cursor is in the unpinned group, the pinned subquery is left out. With `pinnedFirst=false` both groups seek from the cursor and the merge interleaves them.
- Why not one statement over both groups: the first version put `(pinned_at IS NULL)` in the index and an `OR` across groups in the predicate. PostgreSQL cannot use an `OR` as an index start condition, so page N read every earlier row. An expression column also cannot serve the pinned group: the planner rewrites `(pinned_at IS NULL) = false` to `pinned_at IS NOT NULL`, which no longer matches the index expression. The generated boolean matches as `is_pinned = true|false`.
- `EXPLAIN (ANALYZE)` evidence, asserted by the integration test. Setup: one owner with 5,000 studies (100 pinned) among nine owners with 2,000 each (23,000 rows), PostgreSQL 16 locally. Page after row 4,000:
  - one `Index Scan using study_owner_library_<sort>_idx` with `Index Cond: (owner_id = …) AND (lifecycle = …) AND (is_pinned = false) AND (ROW(<sort value>, id) < ROW(…))`;
  - `Actual Rows` 51, so no earlier row is read;
  - no read of the pinned group at all;
  - execution 0.05–0.07 ms (`recent` 0.067–0.075, `created` 0.062–0.064, `title` 0.048–0.051).

  Page after row 40 (inside the pinned group): the pinned group seeks from the cursor with the same `ROW(…)` start condition (an index or bitmap scan, as the planner prefers for 60 rows), and the unpinned group starts at its top. Execution 0.17–0.22 ms. The first page is the same index scan without the `ROW` condition.

**Cursor: sealed with AES-256-GCM.**

- Wire format: `base64url(version ‖ 12-byte random IV ‖ ciphertext ‖ 16-byte tag)`, with the version byte as additional authenticated data. The plaintext is `[ownerId, fingerprint, pinnedGroup, sortValue, id]`:
  - the sort value is the timestamp as microsecond UTC text from PostgreSQL (a JavaScript `Date` would truncate it to milliseconds and skip rows), or, for `title`, a snapshot of the anchor's `title_sort_key`;
  - the fingerprint is SHA-256 of `[state, sort, pinnedFirst, tag, words]`.
- The next page seeks from the snapshot and never re-reads the anchor. The first version looked up the anchor's current title by id, so renaming the anchor between pages skipped or repeated rows, and deleting it made the cursor a 400. Tests rename the anchor past and before the cursor, delete it, and unpin it between pages. Every unchanged study is still listed exactly once.
- The first version's fingerprint was an unkeyed truncated SHA-256 in readable JSON. Anyone holding a cursor and the owner's id could test guesses of the search words against it offline. Now everything is inside the ciphertext. Without the server secret a cursor cannot be read, guessed against or forged. A test checks that no title, sort key or search word appears in a cursor's bytes or text: UTF-8, UTF-16, Latin-1, hex, and base64/base64url at every alignment.
- **Secret.** The key is derived with HKDF-SHA256 (info `bible-artisan/library-cursor/v1`) from `CURSOR_SECRET`: 32 bytes, base64, validated by `loadEnv`. Like `CORS_ALLOWED_ORIGINS` it is HTTP-only. `cursorSecret(env)` runs in `configureApp`, so the API refuses to start in production without it. The worker issues no cursors and ignores it. Outside production a fixed, public development secret is used when it is unset, so local and test cursors survive restarts. Rotating the secret only invalidates outstanding cursors.
- Failed authentication (tampered, truncated, another key, or the old format), another owner, and other filters, sort, grouping or state all give 400 `VALIDATION` (`cursor: ["Invalid cursor"]`), a fixed message. `limit` may differ between pages. The cursor is at most 2,048 characters: the largest title snapshot (200 code points × 4 bytes) plus about 150 bytes of overhead, in base64url.
- `limit` is 1 to 50, default 50 (PRD section 11). Each request makes at most `limit + 1` rows, one tag query and one batched reference lookup (`ReferenceService.storedReferences`).

**`last_activity_at`.**

- It is the time anything last happened to the study, committed. It is set at creation (the column default) and then only by `StudyRevisionService.writeCounters`, in the same UPDATE as the event counter, whenever a mutation appended events. Every pipeline mutation does, so rename, description, question, pin and tag edits all count.
- There is no other write path. A read, or a refused or rolled-back mutation, never moves it, and tests assert both.
- The value is the application clock as the mutation ends, like `created_at` and `study_event.occurred_at`, so it is never earlier than either. A first version used the database's `now()` (transaction start). Manual curl verification showed a new study's last activity 1 ms before its `created_at`, which the application sets.
- BIB-55 (visits) and BIB-22 (lifecycle) may refine which events count, in the same place. Backfill: the latest event, else creation.

**Data and down.** Migration `add_study_library` adds `last_activity_at`, `search_text`, `title_sort_key` and the generated `is_pinned`, plus the three library indexes. It also rewrites stored final sigmas (`tag.normalized_name`). Its `down` restores the word-final form: σ after a non-separator and before a separator or the end.

- Its `down` refuses while any study exists unless `ALLOW_STUDY_DATA_DROP=1`.
- The columns are derived, but each `down` commits on its own. An unguarded step would commit before BIB-20's guard refused, leaving a half-reverted database. The reversibility suite caught exactly that, and now expects this step's refusal first.

**Web.**

- The search text and tag filter live in component state only: never the page URL, history or localStorage (PRD section 9). The text appears only in the API request's query string, as PRD section 24 specifies, and the API logs only the route pattern.
- Search is submitted (Enter or Search), not sent per keystroke. An empty search resets the filters.
- States:
  - loading shows skeletons;
  - a refetch keeps the previous results (`keepPreviousData`);
  - "No studies yet" with a New study link, as distinct from "No studies match" with Clear filters;
  - a failed first load shows Retry;
  - a failed refresh keeps the results and says when they were loaded;
  - a failed Load more keeps the loaded studies and offers Retry;
  - a refused cursor restarts the list from the start.
- One persistent polite status region announces the results once a search, tag filter, clear or sort change has loaded ("Search results: 3 studies.", "Search results: no studies match.", "Tag filter cleared: 12 studies."). It also announces Load more ("N more studies loaded.").
- A search refused before sending (too many words, forbidden characters) appears as an alert, with focus back on the field, which points at it (`aria-describedby`).
- Clear tag filter and Clear filters disappear with the filters, so they move focus to the search field instead of dropping it on the page body.
- **Freshness.** Creating a study, and every committed edit, invalidates every cached library listing (`invalidateLibrary`: the `['studies', 'library']` prefix). That covers each search, filter and sort of `/studies`, and Home's recent studies, so they refetch when shown. A refused create or edit invalidates nothing. The study's own cache is still updated in place by its editor.
- The Archived filter UI waits for archiving (BIB-22). The API already accepts `state=archived` and never lists trashed studies. (BIB-22 added the Show filter and `state=trashed`; see its addendum.)

**Privacy.** No new log lines. `log-redaction.int-spec.ts` sends sentinel titles, tags, searches, tag ids and cursors on 200 and 400.

**Not in BIB-21:** archive/trash and the Archived filter (BIB-22), notes search (BIB-23), Continue Studying and the resume card (BIB-34), list actions from the library, a tags endpoint, and offline caching (BIB-36).

## Addendum (2026-10-01, BIB-22): archive, trash, restore and purge

`POST /v1/studies/:studyId/archive|unarchive|restore` and `DELETE /v1/studies/:studyId` (trash), all through `MutationService.execute` with `{ expectedRevision }` (strict) and an optional Idempotency-Key. Each bumps `study.revision` once, appends one event, and never moves `content_revision`. 200 is `updateStudyResponseSchema`.

**Transitions** (`modules/study/study-lifecycle.ts`, one table, mirrored by the database):

| Route     | From              | To                                            | Dates                                  |
| --------- | ----------------- | --------------------------------------------- | -------------------------------------- |
| archive   | active            | archived                                      | `archived_at` = now                    |
| unarchive | archived          | active                                        | `archived_at` = null                   |
| trash     | active / archived | trashed                                       | `deleted_at` = now, `archived_at` kept |
| restore   | trashed           | archived if `archived_at` is set, else active | `deleted_at` = null                    |

- `study_lifecycle_timestamps_check` ties the dates to the state, and the `study_lifecycle_transition` trigger (`BEFORE UPDATE OF lifecycle`, `SET search_path = pg_catalog, pg_temp`, fixed message, SQLSTATE 23000) refuses every other pair, so a trashed study only leaves the trash to the state it came from.
- Events (ids/enums only): `study_archived`, `study_unarchived` (thread-visible, PRD section 13), `study_trashed`, `study_restored {restoredTo}` (internal). Visibility is recorded in code for BIB-55's column.
- Lifecycle changes are activity: `last_activity_at` moves through `writeCounters`, the unchanged single writer (BIB-21).

**The guard is in the pipeline, not in routes.** `StudyRevisionService.lock` reads `lifecycle` with the row lock, and `execute` calls `assertLifecycleAllows(lock.lifecycle, spec.lifecycleTransition)` before `work` runs. A spec without `lifecycleTransition` (PATCH and every later study mutation) needs an active study: archived is 422 `STUDY_ARCHIVED`, trashed 422 `STUDY_TRASHED`. A lifecycle route from a state not in its row is 422 `STUDY_TRASHED` when the study is trashed, else 422 `LIFECYCLE_TRANSITION_INVALID`. 422, not 409, because PRD section 24 gives 422 to invalid state transitions and keeps 409 for revisions. The state is checked before the revision, so an archived study answers `STUDY_ARCHIVED` whatever `expectedRevision` says; a refusal rolls back with its receipt.

**30-day window.** `purgeAt = deleted_at + 30 days` (`STUDY_TRASH_RETENTION_DAYS`, contracts). From `purgeAt` the study is absent. The rule is one SQL expression, `withinRecoveryWindowSql(alias)` (`withinRecoveryWindow()` for a `Study` model query), in the WHERE of the study lock, `StudyAccessService.requireOwnedStudy`, `requireOwnedNode` (one statement: the node plus an `EXISTS` on its study) and the library's `state=trashed`. So GET, every mutation and restore answer the same 404 as an absent id before the row is physically gone, and the window never depends on when the purge last ran.

**One clock: the database's.** `archived_at` and `deleted_at` are written as `now()`, and every window decision (reads, the lock, the Trash listing, the purge cutoff `RECOVERY_CUTOFF_SQL`) and the purge's receipt expiry (`expires_at <= now()`, as the receipt claim already did) compare with `now()` in SQL, never `new Date()`. The span is `720 hours`, not `30 days`, because day arithmetic on `timestamptz` follows the session time zone across DST. An API or worker clock that is skewed can then neither hide a study early, keep one too long, nor delete a receipt that would still replay. `purgeAt` in DTOs is display arithmetic on the stored database timestamp. `last_activity_at` and `pinned_at` keep the application clock (BIB-21's reasoning above); they decide nothing about expiry. `GET /studies/:id` and list items carry `purgeAt` (null unless trashed).

**Purge** (`modules/study/trash/StudyTrashPurgeService.purgeExpired`). Batches of 100, one READ COMMITTED transaction each:

1. `SELECT … WHERE lifecycle = 'trashed' AND deleted_at <= RECOVERY_CUTOFF_SQL ORDER BY deleted_at, id … FOR UPDATE SKIP LOCKED` (`DUE_STUDIES_SQL`), served by the partial index `study_trash_purge_idx (deleted_at, id) WHERE lifecycle = 'trashed'`. No mutation can hold such a row (the lock refuses it), and a restore racing the boundary holds its row and is skipped this run.
2. Take the owners' tag-vocabulary advisory locks (`lockTagVocabularies`, sorted by owner id; the same helper and key `tag-vocabulary:<owner>` as BIB-20's tag change), so the orphan cleanup cannot deadlock with a concurrent tag change on another of the owner's studies. Note the studies' tags, then `DELETE FROM study`; BIB-19's cascades remove nodes, events, branches and `study_tag`.
3. `deleteOrphanedTags` (BIB-20's race-safe cleanup) per owner, so tag text does not outlive the study.
4. `MutationService.deleteExpiredReceipts(owners)`: those owners' expired receipts. Receipt bodies hold titles, questions and tags; a purged study's last mutation (the trash) is 30+ days old, so every receipt about it is past its 7-day TTL and goes. Unexpired receipts and the general receipt purge stay with BIB-39.

One `trash_purged {studies, durationMs}` line per run; a failed run logs `trash_purge_failed {errorType}` and retries at the next tick. The worker (`worker.ts`) runs it at start and hourly (`scheduleTrashPurge`, one run at a time). It needs no lease: it is idempotent, and `SKIP LOCKED` lets two workers share it. Tests call the service directly, compile `WorkerModule` to prove its wiring, and drive the schedule with fake timers; the worker process itself is not booted in CI.

**Migration** `add_study_lifecycle`: `archived_at`, `deleted_at` (backfilled from `updated_at` for any existing archived/trashed row), the CHECK, the trigger and `study_trash_purge_idx`. Its `down` refuses while any study exists unless `ALLOW_STUDY_DATA_DROP=1`, not only while archived or trashed ones exist: each `down` commits on its own, and an unguarded step would commit before BIB-21's guard refused, leaving a half-reverted database (the reversibility suite now expects this step's refusal first).

**Web.** `/studies` has a labelled Show select (Active, Archived, Trash). Each state is its own query key, so switching starts from the first page with a fresh cursor, and previous results are kept as placeholder only within the same state (never archived studies under the Trash heading). Trash is one list (`pinnedFirst=false`) and each card says "Deleted permanently on <date>". Empty states: "No studies yet." (with New study), "No archived studies.", "Trash is empty.", and "No studies match." for a search. The study page shows Archive / Unarchive / Move to trash / Restore per state, the archived and trash banners, and no editor unless the study is active. Move to trash confirms in a `<dialog>` opened with `showModal`, labelled and described, focus on Cancel; Escape or Cancel closes it and returns focus to the trigger. Pending buttons are `aria-disabled` and ignore presses; a committed change updates the study cache from the 200, calls `invalidateLibrary`, is announced in a polite status region, and moves focus to the new state's first action. Errors by code: 409 and the 422 lifecycle codes offer Reload, 404 shows the unavailable page, an unknown outcome offers Retry with the identical body and key. An edit refused with `STUDY_ARCHIVED`/`STUDY_TRASHED` says so in the editor, and Reload shows the study read-only. Archive and Move to trash would unmount the editor, so while it has unsaved changes, or a save in flight or with an unknown outcome, they are blocked rather than silently discarding that work: `aria-disabled`, described by a visible note ("Save or undo your changes to this study before archiving it or moving it to trash."), and a press does nothing. The editor reports this through `onUnsavedChange`, lifted to the page. Blocking was chosen over a three-way confirm as the simplest accessible option.

**Privacy.** Events, logs and errors carry ids, enums and counts only. `log-redaction.int-spec.ts` covers the four routes on 200, 404 and 422.

**Not in BIB-22:** note trash (BIB-23), node/edge delete and undo (BIB-31), account deletion and export (BIB-47/48), the job runner and the general receipt purge (BIB-39), the event visibility column (BIB-55), lifecycle actions in library rows, and the offline queue (BIB-36).

## Addendum (2026-10-01, BIB-23): versioned rich notes

`/v1/studies/:studyId/notes` (`modules/notes/`): create, list (`?state=active|trashed`), read, save (`PATCH`), trash (`DELETE`), restore, list versions, read a version. Every write runs through `MutationService.execute`, so the study lock, the lifecycle guard (archived/trashed studies are 422 for every note write), revisions, the Idempotency-Key receipt and one StudyEvent come from the pipeline; every read resolves the study through `StudyAccessService` and then queries the note by its own id, study and owner.

**Rich text is an allowlist, validated on the server (NFR-SEC-002).** `noteDocumentSchema` (contracts) is the whole of what a note may contain: `doc`, `paragraph`, `heading` (`level` 1-3), `bulletList`, `orderedList` (`start` 1-10,000), `listItem` (a paragraph, then blocks), `blockquote`, `text`, `hardBreak`; marks `bold`, `italic`, `link` (`href` only, through BIB-11's `httpUrlSchema`: http/https, no credentials, no embedded whitespace or control characters). Every object is strict, so an unknown node, mark or attribute (a link `target`, `onclick`, `image`, `html`) is a 400, never stripped or repaired. Text runs refuse C0 controls but tab (line breaks are `hardBreak` nodes), U+0000 and unpaired surrogates.

- Bounds: a raw-JSON pre-check without recursion (depth and container count) runs before the structural schema, so a hostile body (200,000 nested arrays in 400 kB is tested) is refused without exhausting the stack; then at most 12 nesting levels and 20,000 nodes.
- The plain text is derived by the server (`notePlainText`: runs in order, a line break per hard break and between blocks) and limited to 50,000 code points (PRD section 15): over the limit is 413 `NOTE_TOO_LONG`, before any transaction. The client never sends plain text.
- Note routes parse JSON bodies up to 1 MiB (a route-scoped body-parser, `body-parser` 2.3.0, the version Nest already ships), but only for a signed-in client: `parseBodyWhenSignedIn` (identity module) resolves the session cookie with `SessionService.resolve` first (no query at all without a well-formed cookie, none for a body-less request), and leaves anyone else's body to Nest's default 100 kB parser and then the guard's 401. So an anonymous client can never make the API buffer more than 100 kB. Origin and JSON checks still run before it. Every other route keeps the 100 kB default. The parser function is wrapped under another name because Nest skips registering its global parser when a layer named `jsonParser` is already mounted.
- Recursive schemas are named (`NoteBlock`, `NoteListItem`) and hoisted into OpenAPI components; a spec test asserts every `$ref` resolves.
- The web never renders stored content as HTML: a read-only `NoteContent` builds React elements from the validated document, and links render only for hrefs that pass `httpUrlSchema` again, with `rel="noopener noreferrer nofollow"` and `target="_blank"` (the editor uses the same). Every API response the web parses goes through the same schema.

**Data.** `note` (study-scoped: composite FK to `study`, cascading; optional `target_node_id` with a composite FK to `study_node (owner_id, study_id, id)`, so a target is always a node of the same study and owner) and `note_version` (composite FK to `note (owner_id, study_id, id)`, cascading; `UNIQUE (note_id, version_number)`; a trigger refuses every UPDATE). A study purge or user delete removes notes and versions with the rest (the purge test covers it). `down` refuses while any study exists unless `ALLOW_STUDY_DATA_DROP=1`, for the same half-revert reason as BIB-21/22.

**Versions.** Creation writes version 1. A save writes a version when the client asks for a checkpoint ("Save version", or restoring an old version) or when the content changed and the newest version is at least 30 seconds old on the database clock (`now()`, the column default of `note_version.created_at`); never a copy of the newest version. Only the newest 100 are kept (pruned in the same transaction); numbers come from `note.latest_version_number` and are never reused. Numbering and pruning run under the study lock. An edit that changes nothing is 422 `NOTE_UNCHANGED`. Restoring a version is a `PATCH` of its content with `checkpoint: true`, not a separate route.

**Revisions and events.** Creating a note is a study change: `expectedRevision` is the study's and is bumped (the 201 carries `studyRevision`, which the web writes into its cached study; the study edit form adopts a newer study revision only while it holds no work). Saves, trash and restore check and bump the note's own revision. `content_revision` moves on create, trash, restore and when a save writes a version (PRD section 17: note checkpoints), not on every autosave. Events, ids only: `note_created {noteId, targetNodeId, versionId}` (thread-visible), `note_autosaved {noteId, versionId|null}`, `note_trashed`, `note_restored` (internal).

**No note text on receipts.** Mutation responses (`NoteMutationResponse`) carry ids, revision, counts and timestamps, never content: every response is stored on its Idempotency-Key receipt for replay, so note bodies never reach `mutation_receipt`. Only the GET routes return content.

**Targets and orphans.** A note attaches to the study or to a live node of it (else 422 `NOTE_TARGET_NOT_FOUND`); the target never changes. Nodes are soft-deleted, so a note whose node is deleted keeps it and is listed with `target.deleted: true` for orphaned-note review (FR-NOTE-002); restoring the node (BIB-31) relinks it by construction. Phrase-anchor and Scripture-range targets are BIB-24's, which owns anchor storage. The note trash has no expiry of its own: trashed notes go with their study or account. At most 1,000 live notes per study (422 `NOTE_LIMIT_EXCEEDED` on create, and on restore from the note trash); trashed notes don't count, so moving notes to the trash makes room. That bounds the unpaginated live list; the trash list returns its 1,000 most recently trashed notes.

**Library search.** `GET /studies?q=` also matches the folded text (`note.search_text`, BIB-21's `tagKey` fold, literal `strpos`) of a study's live notes; `matchedInNotes` labels such results ("Found in notes"). Notes owns `note`, so the Study library never queries it: `NotesSearchService.studiesMatchingNoteText` (exported by `NotesModule`, imported by `StudyHttpModule`; no cycle, since Notes imports only the services-only `StudyModule`) runs one owner-scoped statement per search that matches every word once, and the library binds each word's study ids into both its filter and `matchedInNotes`. Likewise Notes reaches `study` and `study_node` only through `StudyAccessService.requireOwnedNode` / `ownedNodesIncludingDeleted` and `StudyRevisionService.checkStudyRevision`. No trigram or tsvector index, as for BIB-21 (rule 9); a `pg_trgm` GIN index on `note.search_text` is the follow-up if measurements show the per-owner scan is slow.

**Web.** A Notes section on the study page: list (with an "Orphaned notes" group), note trash with Restore, New note (attached to the study or its main question), and one open note in a Tiptap 3.31.4 editor (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`, pinned exactly; code, strike, underline and rules disabled). `NoteAutosave` saves 750 ms after typing stops (five seconds at most), one request at a time, coalescing later edits; each request is frozen with its Idempotency-Key until its outcome is known and resent identically first; "Saved" appears only after the 200 for the latest content. A keystroke only counts characters and marks the draft dirty; the document is serialized, normalized (an ordered list's `start` brought into 1-10,000, control characters as spaces, also in pasted content) and validated only when a save is due, and a draft that still fails says which kind of content is the problem (a link, list numbering, characters, nesting). A save's acknowledged content and revision are written to the cached note together, and the editor adopts a newer cached copy while it holds no unsaved work. Opening another note or creating one goes through the same close as the Close button: the open note is saved first, and one that can't be saved (too long, refused, failed) stays open with the reason and an explicit "Close without saving". Over the limit nothing is sent and the counter says so; 413 `PAYLOAD_TOO_LARGE` (request size) is told apart from 413 `NOTE_TOO_LONG`; 422 `NOTE_UNCHANGED` counts as acknowledged; a 409 stops autosave and keeps the draft (Keep mine saves it as a new version on the current revision; Discard mine reloads); a lifecycle refusal makes the editor read-only. The page warns before unload while anything is unsaved, and archiving or trashing the study waits for it, as for the study editor. Drafts live in memory only; durable local drafts and the offline queue are BIB-36, the global save coordinator BIB-35, side-by-side conflict review BIB-37.

**Privacy.** No new log lines. `log-redaction.int-spec.ts` sends sentinel note text, links and searches on 201, 200, 400, 404, 409, 413 and 422.

## Addendum (2026-10-02, BIB-24): highlights, Scripture note targets and verified reference links

`/v1/studies/:studyId/annotations` (`modules/notes/annotations.*`): create, list for a chapter (`?referenceId=`), change color/label (`PATCH`), delete. Notes owns `annotation` (PRD section 26 groups notes and annotations), so no new module. Every write goes through `MutationService.execute` (study lock, lifecycle guard, revision, Idempotency-Key receipt, one StudyEvent).

**Anchors are checked by Bible content, never trusted, never moved.** `BibleContentModule` now exports `AnchorService`. A create (highlight, or a note with `targetAnchor`) calls `AnchorService.resolve` before the transaction: anything but `resolved` is 422 with the `ANCHOR_*` code (a client-sent checksum, offset, kind or quote that does not match the stored verse is refused, not repaired), and the anchor is stored exactly as checked, which is exactly what `POST /bible/anchors` built. The only write outside the transaction is the idempotent upsert of the shared `scripture_reference` row, as capture already does. Reads re-check every stored anchor with the new `AnchorService.checkStored(anchors[])`: the same pure rules (`anchor-check.ts`), the editions from the cached index, and ONE verse query for the whole list (`unnest … WITH ORDINALITY` joined to `bible_verse` by primary-key range), so a chapter's highlights or a note list cost one statement. A highlight that no longer matches is returned `unresolved` with the anchor exactly as stored (its original quote) and its reason, in `POST /bible/anchors/resolve`'s shape; the reader never draws it and lists it with the quote, the reason in words and Reselect (which reopens the verses; replacing an anchor is not offered).

**Data.** `annotation`: composite FK `(owner_id, study_id) → study`, cascading (purge and user delete remove highlights; the purge test covers it); `reference_id → scripture_reference`; `edition_id`, `book_code`, `start_chapter`, `end_chapter` derived on the server from the checked anchor for the chapter query (`start_chapter <= C <= end_chapter`, partial index on live rows); `anchor_json` (CHECK pins `version: 1`); `color_token` CHECK in the four colors; `label` NULL or 1-80 code points; `revision`; `deleted_at` (database clock). No `node_id`: Scripture nodes are BIB-25/26's. `note` gains `target_reference_id` + `target_anchor_json`, both or neither, never with `target_node_id` (one CHECK). The migration's `down` refuses while any study exists unless `ALLOW_STUDY_DATA_DROP=1`, and is now the first step the reversibility suite expects to refuse.

**Rules.** Four named colors (`HIGHLIGHT_COLORS`, names in `HIGHLIGHT_COLOR_NAMES`); label trimmed, one line, at most 80 code points, blank means none. At most 2,000 live highlights per study (422 `ANNOTATION_LIMIT_EXCEEDED`, counted under the study lock). Creating is a study change (`expectedRevision` is the study's; the 201 carries `studyRevision`); edits and deletes check the highlight's revision. `content_revision` moves on create and delete, not on a color/label change (PRD section 17: highlight-color changes are not significant). Events, ids and enums only: `highlight_created {annotationId, referenceId, colorToken}` (thread-visible), `highlight_updated {annotationId, colorToken}`, `highlight_deleted {annotationId}` (internal); `note_created` gains `targetReferenceId`. Mutation responses carry no anchor or label (they live on the receipt). The list takes only the passage's opaque reference id and covers the chapter the reader shows for it (its first chapter).

**Verified reference links in notes (FR-NOTE-003).** The note allowlist gains one inline atom, `scriptureReference {referenceId (uuid), label (1-200, no control characters)}`, strict like every other node, at most 500 per note; the plain text carries its label. On every create and save the server loads the referenced ids in one call (`ReferenceService.storedReferences`) before the transaction; an unknown id, an inactive edition, or a label that is not exactly the canonical label is 422 `NOTE_REFERENCE_INVALID`, never repaired. Resolving creates no node, edge or event. The editor's "Resolve reference" runs `POST /bible/resolve` on the selected text in the study's starting-passage edition (else the first active translation), inserts the node only on `resolved`, offers the candidates on `ambiguous`, and otherwise leaves the text as typed. `NoteContent` renders it as an internal link to `/bible?ref=…&study=…` with the label as escaped text. No keyboard shortcut: Ctrl/Cmd+Shift+R is the browser's hard reload.

**Web.** `/bible?ref=&study=` reads in a study (opaque ids only; quotes and labels never reach a URL or browser storage). Saved highlights are drawn as `<mark>` over exact code points (`codePointRuns`, now shared with BIB-16's search highlighting) inside the verse element, which still holds exactly the stored text, so BIB-18's selection mapping is unchanged; where highlights overlap the latest is drawn. Color is never the only signal: marks are underlined, each verse names its highlights for screen readers outside the measured text, and the "Highlights in this chapter" list names reference, color and label, with Edit (color radio group + label) and Delete (labelled `<dialog>`, focus on Cancel). A captured selection offers Highlight and Add note (an empty note on that passage). Retries after an unknown outcome resend the identical body and Idempotency-Key. The notes panel names Scripture targets ("On a phrase in Romans 9:1"), and an open note shows its passage's quote, or says it no longer matches, with Reselect.

**Privacy.** No new log lines. `log-redaction.int-spec.ts` covers the annotation routes (201, 200, 400, 404, 409, 422) and note reference links and Scripture targets (201, 422) with sentinel quotes and labels.

**Not in BIB-24:** node mentions and converting a note excerpt into an Observation or Thought (they need BIB-25's typed nodes and node listing, and BIB-27's relationships), Scripture nodes from a selection (BIB-25/26), undo or restore of a deleted highlight (BIB-31), replacing an anchor, offline queue and save coordinator (BIB-35/36), phone tabs (BIB-38).

## Addendum (2026-10-02, BIB-25): the six typed graph nodes

`/v1/studies/:studyId/nodes` (`modules/graph/`): create (one route for all six types), list, read, and edit Observation, Thought and Source nodes. Graph now owns node creation, edits and reads on `study_node`; Study keeps its root inserts at study creation and BIB-20's new main question, and `StudyAccessService`. Every node-creating path (study creation, a study edit's `mainQuestion: {text}`, `POST /nodes`) goes through Study's exported `StudyGraphService.addNode`, so the live-node cap is one check under the study lock, and the `question_created` event type is one constant (`study/study-events.ts`) both modules write. Every write runs through `MutationService.execute` (study lock, lifecycle guard, revision, Idempotency-Key receipt, exactly one StudyEvent); creating is a study change (the study's `expectedRevision`, `studyRevision` in the 201), an edit checks the node's revision.

**Typed shape, in the schema and in the database.** `createNodeRequestSchema` is a strict discriminated union of six branches; the client never sends `origin`, a status, an owner or a revision (unknown key, 400). The server sets `origin` from the type: `scripture`, `external` for a Source, else `user` (`ai` is reserved for Epic 7). Per-type CHECKs make another type's columns unwritable: Question/Conclusion `title` (1-4,000) + their status, Observation/Thought `body` (1-10,000, plain text), `observation_kind` iff observation, `conclusion_status` iff conclusion, Source `title` (1-200) + `payload_json` (the rest of the citation; a string `url` or `locator` required, checked with `coalesce` because a CHECK that yields NULL passes), Scripture `scripture_reference_id` only. The `study_node_identity_immutable` trigger (BEFORE UPDATE, fixed message, SQLSTATE 23000) refuses any change of `type`, `study_id`, `owner_id`, `origin` or `scripture_reference_id`.

**Rules.** A Scripture reference is validated before the transaction through `ReferenceService` (unknown or inactive edition: 422 `REFERENCE_NOT_FOUND`, never repaired). Under the study lock: at most 2,000 live nodes on every creating path (422 `NODE_LIMIT_EXCEEDED`, `StudyGraphService.addNode`) and at most one live Scripture node per reference (422 `SCRIPTURE_NODE_EXISTS`, a placeholder until BIB-26's canonical dedupe). The list is never truncated: no LIMIT, so a study over the cap from earlier data still lists every live node. An edit checks, in order: 422 lifecycle (`STUDY_ARCHIVED` / `STUDY_TRASHED`, the pipeline's central guard, before the work runs) → 404 → 409 → 422 `NODE_NOT_EDITABLE` (questions are never rewritten in place, conclusions version with BIB-30, Scripture identity is immutable) → 422 `NODE_UNCHANGED`. The lifecycle refusal coming before 404 leaks nothing: the study row is already resolved as the caller's own (another owner's or an absent study is 404 at the lock), so it only says something about the caller's own study.

**Initial branch.** `StudyGraphService.ensureInitialBranch` is the one place a study's initial branch is created (PRD section 10, BIB-19's rule): if the study has no branch, it is rooted at the study's oldest live Question node (created_at, then id), else at its oldest live Scripture node, else none. It runs at study creation (a question roots it, else the passage, a blank study gets none), whenever a Question node is created (`mainQuestion: {text}`, `POST /nodes` with a question) and when a study edit makes an existing question main (`mainQuestion: {nodeId}`). So a blank study's first question roots the branch whichever path creates it; a Scripture node added through `POST /nodes` roots none on its own; a study that has a branch never gets another here. The created branch's id is reported once: `question_created.branchId` when the change created the question, else `main_question_changed.branchId`. Edits overwrite: no node versions until BIB-30. Events carry ids and enums only (`scripture_added_to_graph`, `question_created`, `observation_created`, `thought_created`, `conclusion_created`, `source_created`, `observation_updated`, `thought_updated`, `source_updated`; all thread-visible for BIB-55). Mutation responses carry no text (they live on the receipt).

**Labels.** `nodeLabel` (contracts, next to `nodePreview`) is the one rule: a Scripture node's reference label, or "Passage (translation unavailable)" (`SCRIPTURE_LABEL_UNAVAILABLE`) once its edition is no longer active; otherwise `nodePreview` (whitespace collapsed, first 160 code points) of the statement, text or source title. The node list and a note's target label (`NotesService.targets()`, so `noteTargetSchema`'s node `label` is never null) both call it. A Scripture node whose edition is no longer active reads with `reference: null`.

**Down.** The migration's `down` refuses while any study exists unless `ALLOW_STUDY_DATA_DROP=1` (now the first refusal the reversibility suite expects). With the opt-in it deletes Observation, Thought, Conclusion and Source rows, whose content it drops, after detaching any note from them, so a later `up` validates again. Part of that opt-in data loss: `study_event` rows and `mutation_receipt` responses that name those node ids are left as they are (history is append-only and ids-only), so after the `down` they point at nodes that no longer exist, and a replayed Idempotency-Key answers for a deleted node.

**Web.** A Nodes section on the study page: a keyboard-first list (type, origin and status or kind as text), an inline Add node form (Type radio group, per-type fields with counters, Scripture only from a passage `POST /bible/resolve` resolved, candidates for an ambiguous book), one node's detail (a region focused on creation; Source URLs link only when they pass `httpUrlSchema`, `rel="noopener noreferrer nofollow"`; Scripture links to the reader in this study), and Edit for observations, thoughts and sources. Requests are frozen with their Idempotency-Key and resent verbatim after an unknown outcome; "Saved" is announced only after the 200; a 409 keeps the draft until a confirmed Reload. The Notes "Attach to" select lists every live node from the same query.

**Not in BIB-25:** canonical Scripture dedupe and visits (BIB-26), edges, derived-from and note-excerpt conversion (BIB-27 and a follow-up), node mentions in notes (follow-up), the canvas (BIB-28), the full List View (BIB-29), question/conclusion status and versions (BIB-30), node delete and undo (BIB-31), the save coordinator (BIB-35).

## Addendum (2026-10-02, BIB-26): canonical Scripture nodes and visits

A study holds at most one live **canonical** Scripture node per exact reference (FR-GRAPH-002/003; PRD sections 12, 23, 24, 28). `scripture_reference_id` already fixes range and edition (BIB-15), so it is the whole key; overlapping ranges and other editions are other references. BIB-25's placeholder 422 `SCRIPTURE_NODE_EXISTS` is gone (contracts, OpenAPI, service, web).

**Schema.** `study_node.canonical_node_id` is NULL for a canonical node (no `is_canonical` column: it would always equal `canonical_node_id IS NULL`) and names the canonical node on a deliberate duplicate. A composite self-FK `(owner_id, study_id, canonical_node_id, scripture_reference_id) -> study_node (owner_id, study_id, id, scripture_reference_id)` (NO ACTION, backed by a UNIQUE on the target columns) keeps a duplicate in its own study, owner and reference; a CHECK limits duplicates to Scripture rows that do not name themselves. The partial unique index `study_node_canonical_scripture_key (study_id, scripture_reference_id) WHERE type = 'scripture' AND canonical_node_id IS NULL AND deleted_at IS NULL` is the database guarantee and serves the lookup; `study_node_canonical_node_idx` backs the FK's referencing side for purges. Deleted rows are outside the index, so canonical promotion and restore conflicts stay BIB-31's; `canonical_node_id` is deliberately not covered by the identity trigger so BIB-31 can re-point duplicates. The migration labels pre-existing same-reference live rows (oldest canonical, the rest its duplicates; nothing deleted, no other column or event written); its `down` is guarded by `ALLOW_STUDY_DATA_DROP` and is now the first refusal from latest.

**API.** Still `POST /studies/:studyId/nodes` (no new route): the Scripture branch takes `duplicatePolicy` (`focus_existing`, the default, or `explicit_duplicate`). Under the study lock, after the study revision check (stale is 409 before anything), the server looks up the canonical node by the locked study and owner (the client never names it). None: 201 `created`. One, `focus_existing`: 200 `focused_existing` with the existing node's fields, no `study_node` write, `content_revision` unchanged (`bumpsContentRevision: false`; creates call `m.bumpContentRevision()`), study revision and `last_activity_at` move, one `scripture_revisited {nodeId, referenceId}` event. One, `explicit_duplicate`: 201 `explicit_duplicate`, a new node with `canonicalNodeId` (through `StudyGraphService.addNode`, so the cap applies; a focus never hits it). `scripture_added_to_graph` gains `duplicateOfNodeId`. Every create response carries `outcome` and `canonicalNodeId`; list and detail carry `canonicalNodeId`. A replayed Idempotency-Key returns the stored 200/201 and records no second visit. Two Adds racing from one revision: one 201, one 409, and the retry focuses. The unique index is a backstop the locked path never trips, so a violation stays an unmapped 500.

**Web.** The study page's Add node handles all three outcomes: a focused node opens with focus on its heading and a polite status "Romans 9:1 is already in this study. Showing it." with "Add a separate copy" (a new request and key). Duplicates show a "Duplicate" text badge in the list and "Duplicate of Romans 9:1" with "Show the original" in the detail; the Notes "Attach to" option reads "Scripture: Romans 9:1 (duplicate)". `?node=<id>` selects a listed node on load (ignored otherwise; an opaque id only). The reader's captured actions gain "Add to study" (`components/bible/add-to-study.tsx`, passed into `CapturedActions` as `extraActions`): the captured reference (a phrase adds its verses and says so), the three outcomes announced by label only, "Show in study" to `/studies/:id?node=<id>`, Retry with the same key after an unknown outcome, and a re-read of the study after a 409.

**Not in BIB-26:** navigation context, reader-open visits and the activity endpoint (BIB-55), edges and Follow into Study (BIB-27), node delete/restore and canonical promotion (BIB-31), canvas focus (BIB-28), overlap hints and cross-study verse identity.

## Addendum (2026-10-02, BIB-27): typed, directional relationships

Two live nodes of one study can be connected with one of the 15 PRD section 12 types (FR-GRAPH-004/005/006). Edges join nodes only.

**Schema.** `study_edge` (owned by Graph): composite FKs `(owner_id, study_id) -> study` (cascade) and, for each endpoint, `(owner_id, study_id, node) -> study_node (owner_id, study_id, id)` (NO ACTION, like `note_target_node_fk`), so an endpoint from another study or owner is unwritable. CHECKs: the type list, no self-edge, two-way types (`parallels`, `related_to`) stored once with `source_node_id < target_node_id`, note NULL or 1-2,000, origin `user`/`ai`. Partial unique `study_edge_live_key` on live (study, source, target, type); full indexes on `(owner_id, study_id, source_node_id)` and `(…, target_node_id)` back the FKs and the per-node list. Trigger `study_edge_identity_immutable` refuses changing endpoints, study, owner or origin (SQLSTATE 23000). No `symmetric` column (derived from the type), no edge versions, no `UNIQUE (owner_id, study_id, id)` until an FK targets edges (BIB-30).

**Pipeline: `m.unchanged()`.** A duplicate connect is `200 outcome: 'existing'` and writes nothing, which the BIB-12 pipeline could not express (every work had to check a revision and append an event). `StudyMutation.unchanged()` declares "nothing to change": allowed only before any write through `m` (and never with `bumpsContentRevision: true` or in `create`), refusing any write after it. `MutationService` then requires no revision check or event and writes no counters (revision, content revision, last event sequence, last activity unchanged), while the receipt claim, study lock, lifecycle guard and receipt storage still apply, so a replay is exact. Decision on revisions: the unchanged path makes no revision check, since nothing is written and the dedup lookup precedes the study revision check by design (a duplicate never conflicts). See `apps/api/src/modules/README.md`.

**API.** `connectNodes(m, input, { beforeCreate })` in `graph/edges.service.ts` is the single connect path, callable inside any study mutation (BIB-55, BIB-57): normalize two-way order → dedup lookup (→ `existing`) → `beforeCreate` (the route's study revision check, 409) → both endpoints live in this study and owner (404) → `answers` / `raises_question` need a Question target (422 `EDGE_TARGET_NOT_QUESTION`) → at most 6,000 live edges (422 `EDGE_LIMIT_EXCEEDED`) → insert, content revision +1, `node_connected`. `GET /edges?nodeId=` lists one live node's live edges (either direction) with notes. `PATCH` changes type within the direction class (422 `EDGE_TYPE_CHANGE_NOT_ALLOWED`, `EDGE_EXISTS`, `EDGE_UNCHANGED`) and/or the note (`edge_updated {edgeId, edgeType, previousEdgeType, noteChanged}`); `DELETE` soft-deletes (`edge_removed`). Events and responses carry ids and enums only; the note is never logged, put in an event or stored on a receipt. Concurrent identical connects from one revision: one 201, and the other, queued on the study lock, finds the committed edge and answers 200 `existing` (the ticket's prose expected a 409 then an `existing` retry; its own check order, dedup before the revision check, gives the friendlier result directly). Two *different* connects from one revision: one 201, one 409.

**Recorded deviation.** PRD section 23 says edge revisions and events preserve prior semantics _and notes_. Events keep the prior type; prior note text is not kept (events are ids-only, and there is no edge version table). Revisit with BIB-31, whose undo needs prior states anyway.

**Web.** A Relationships region inside the node detail: each edge as a sentence from this node's side using `EDGE_PHRASES` (direction in words, never arrows or color alone), Show the other node, inline Connect (default types plus a "More relationships" optgroup, other node, Swap direction with a live preview sentence, note with counter), inline Edit limited to same-class types, and Remove with an inline confirm. Frozen requests with one Idempotency-Key are resent verbatim after an unknown outcome.

**Not in BIB-27:** Follow into Study (BIB-55), note-excerpt conversion and derived-from provenance (BIB-57), canvas edges (BIB-28), the study-wide List View and Connect dialog (BIB-29), conclusion evidence rules (BIB-30), edge restore/undo and node-delete cascades (BIB-31), AI proposals (BIB-42), the 80 % cap warning.

## Notes

- **TypeScript is pinned to 6.0.x, not 7.x.** TypeScript 7 is the native (Go) compiler, and `typescript-eslint` 8.x supports `<6.1`. Revisit when type-aware lint supports 7.
- `apps/api` uses `NodeNext` module resolution (it still compiles to CommonJS) because it imports the `@bible-artisan/contracts/openapi` subpath, which resolves only through `package.json#exports`.
