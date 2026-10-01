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

Stytch doesn't document a per-code attempt cap, so the attempt limit, the resend window, single use, and expiry are also enforced in PostgreSQL (`auth_challenge`, which stores no code or code hash). Error mapping: `otp_code_not_found` means a wrong code, `unable_to_auth_otp_code` means expired or already used, and anything else (including bad credentials) is a 503, so a misconfiguration can never look like a wrong code.

**Adapter seam:** one `OtpProvider` interface (`apps/api/src/modules/identity/otp/`) with `StytchOtpProvider` and `DevOtpProvider`, selected by `OTP_PROVIDER`. The dev adapter keeps codes in memory, optionally writes the latest one to a local gitignored outbox file, never logs it, and is refused when `NODE_ENV=production`. Tests and local development need no secrets.

**Sessions are ours, not Stytch's:** a random 32-byte token in the `ba_session` cookie, with only its SHA-256 stored in `auth_session`. A global `SessionGuard` denies by default; public routes opt out with `@Public()`. Controllers take the owner from `@CurrentUserId()`.

**Assumption:** web and API are deployed same-site (for example `app.` and `api.` under one domain), so the API's SameSite=Lax cookie travels with credentialed fetches from the web app. Revisit with the hosting decision.

## Notes

- **TypeScript is pinned to 6.0.x, not 7.x.** TypeScript 7 is the native (Go) compiler, and `typescript-eslint` 8.x supports `<6.1`. Revisit when type-aware lint supports 7.
- `apps/api` uses `NodeNext` module resolution (it still compiles to CommonJS) because it imports the `@bible-artisan/contracts/openapi` subpath, which resolves only through `package.json#exports`.
