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

## Notes

- **TypeScript is pinned to 6.0.x, not 7.x.** TypeScript 7 is the native (Go) compiler, and `typescript-eslint` 8.x supports `<6.1`. Revisit when type-aware lint supports 7.
- `apps/api` uses `NodeNext` module resolution (it still compiles to CommonJS) because it imports the `@bible-artisan/contracts/openapi` subpath, which resolves only through `package.json#exports`.
