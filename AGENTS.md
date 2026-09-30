# Bible Artisan

A private, single-user Bible study workspace: reader + typed study graph + chronological Study Thread + living AI summary, so a user can resume a complex study without reconstructing their reasoning.

- PRD (source of truth): https://docs.google.com/document/d/1SRkPCB7mp4kgpaACI5ERztOvZSvTfeOfFgns_Vuce-U/edit. Local snapshot: `docs/prd/PRD.md`. Tickets cite it as "section N". Grep the snapshot for `# **N.` to find a section.
- Linear: team **BIB** (https://linear.app/chop-awoof/team/BIB/all), project "Bible Study Visual Workspace — MVP". Epics BIB-1…BIB-8 hold the child tickets.
- Stack decisions and why: `docs/adr/0001-stack-and-repo-layout.md`.

## Layout

```
apps/api         NestJS modular monolith. src/main.ts = REST API (/v1), src/worker.ts = background worker
  src/modules/   one folder per bounded context (identity, study, bible-content, graph, thread, notes, ai, exports, observability)
  migrations/    Sequelize (sequelize-cli) migrations, SQL-first
  test/          integration tests (*.int-spec.ts) against real PostgreSQL
apps/web         Next.js App Router + React + Tailwind + TanStack Query (React Flow and Tiptap get added with their tickets)
packages/contracts  Zod DTO schemas + inferred types shared by API and web. No DB models in here.
```

## Commands (run from the repo root)

| Command                                                         | What it does                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm install`                                                  | Install everything (pnpm 10 via corepack, Node 24)                                                     |
| `pnpm db:setup`                                                 | Create `.env`, create the dev + test databases, migrate both                                           |
| `pnpm dev`                                                      | contracts watch + API (:4000) + web (:3000)                                                            |
| `pnpm --filter @bible-artisan/api dev:worker`                   | Run the worker                                                                                         |
| `pnpm test`                                                     | Unit tests (all packages)                                                                              |
| `pnpm test:integration`                                         | API integration tests on `DATABASE_URL_TEST` (migrated automatically)                                  |
| `pnpm check`                                                    | Everything CI runs. Must pass before opening a PR                                                      |
| `pnpm --filter @bible-artisan/api db:migrate:make <snake_name>` | New migration file                                                                                     |
| `pnpm db:migrate`                                               | Apply pending migrations (hand-written Sequelize model classes stay in sync by hand — no codegen step) |

`packages/contracts` compiles to `dist/`. If the API or web can't resolve a new export, run `pnpm --filter @bible-artisan/contracts build`. `pnpm dev` keeps it in watch mode.

## Non-negotiable engineering rules (from the PRD)

1. **Owner isolation (NFR-SEC-001).** Every private query is scoped by `owner_id` taken from the session, never from the request. Unauthorized and absent resources both return **404**. Every new private route gets a cross-user integration test.
2. **Composite keys.** Study-scoped tables carry `study_id` + `owner_id`, with composite FKs to `study(owner_id, id)`. A mismatched owner/study must be unwritable at the DB level.
3. **Atomic events.** A domain mutation and its `StudyEvent` commit in the **same transaction**. Graph and Notes call Thread services inside that transaction. Never write history after the fact.
4. **Revisions and idempotency.** Mutations need `expectedRevision` (missing → **428**, stale → **409** with `currentRevision`) and accept `Idempotency-Key` (MutationReceipt, same key with a different body → reject). Never report "Saved" before commit.
5. **Error envelope** (section 24): `{ code, message, fieldErrors?, retryable, correlationId, currentRevision? }`. Status codes 400/401/404/409/413/422/428/429/503 as specified.
6. **Privacy (NFR-PRIV-001).** Logs, analytics and error reports never contain Scripture queries or references, note bodies, questions, conclusions, source excerpts, OTP codes, or prompt/response text. Log opaque IDs, counts, latency, and status only. `console.log` is lint-banned.
7. **AI never decides for the user.** AI output is a suggestion or derived artifact outside the canonical graph until the user explicitly accepts it. AI code cannot change node statuses or conclusions. Every cited ID must be in the context manifest, and every quote must match stored text exactly.
8. **Scripture is verbatim.** Text comes only from the imported, checksummed WEB corpus in PostgreSQL. Never fabricate a passage or "repair" a wrong reference to a nearby verse.
9. **No new infrastructure** (Redis, brokers, vector DB, graph DB, extra services) unless measurements justify it. PostgreSQL handles jobs (`SKIP LOCKED` leases), search (GIN / tsvector), and idempotency.
10. **Graph DTOs are UI-library independent.** Convert to React Flow view objects in the web app. Don't persist React Flow's serialization.
11. **Accessibility (WCAG 2.2 AA).** Every canvas action has a keyboard or List View equivalent. Color or position is never the only signal.

## Code conventions

- TypeScript strict everywhere. Validate DTOs with Zod schemas from `@bible-artisan/contracts`, the same schema on both sides of the wire.
- DB access goes through sequelize-typescript (`DATABASE` injection token for the `Sequelize` instance). Write DDL as raw SQL in migrations (`sequelize-cli`, `queryInterface.sequelize.query(...)` where the query-interface DSL can't express it), since CHECK constraints, partial unique indexes, and composite FKs are expected. Migrations must be reversible. Keep model classes as the single source of truth for a table's shape; there is no generated-types codegen step, so migrations and models must be kept in sync by hand. See ADR 0001's amendment for the tradeoffs this accepts versus Kysely.
- Modules own their tables. Cross-module calls go through exported services, never another module's tables.
- In `apps/api` use normal imports, not `import type`, for anything injected, because Nest DI needs runtime metadata. Use `@Inject(TOKEN)` for symbol tokens.
- Tests: unit `*.spec.ts` next to the code. API integration `test/**/*.int-spec.ts` against real Postgres, never a mocked DB, preferred over units for behavior. Web `*.test.tsx` with Testing Library, queried by role/label. Assert whole API response bodies with a single `toStrictEqual` (use `expect.any(...)` only for genuinely dynamic values). Test behavior, not snapshots.
- Frontend: server state in TanStack Query. Canvas selection, drafts, and the pending-save queue go in a lightweight client store. Call the API only through `apiFetch` in `src/lib/api-client.ts`.

## Ticket workflow

Two repository skills live in `.agents/skills/` (canonical, tool-agnostic). The Claude Code slash commands in `.claude/commands/` are thin wrappers:

| Step     | Claude Code                   | Codex                     | What it does                                                                                                                                   |
| -------- | ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Groom | `/bib-prepare BIB-10`         | `$prepare BIB-10`         | Rewrites the Linear ticket so it's implementation-ready: scope, out-of-scope, reuse, contract, UI states, tests, ACs. Never writes code.       |
| 2. Build | `/bib-do-ticket <linear url>` | `$do-ticket <linear url>` | Plans, branches (Linear's `gitBranchName`), implements, runs `pnpm check`, commits, opens the PR, moves the ticket to In Review. Never merges. |

The Claude commands are prefixed `bib-` because a user-level `do-ticket` skill (the chop-awoof one) would otherwise shadow a project skill with the same name.

Conventions:

- One ticket = one branch = one PR.
- Commit messages and PR titles use `[BIB-<n>] Imperative summary`. PR bodies include `Closes BIB-<n>`.
- Build in dependency order: Epic 1 foundation (BIB-9, then BIB-10…BIB-13) first, then BIB-14 (corpus) before any reader, search, or Scripture-node ticket. Epic keys don't match their numbers: BIB-2 is Epic 1 and BIB-1 is Epic 2.
- Each Given/When/Then acceptance criterion maps to at least one automated test or a recorded manual check.
