---
name: do-ticket-fast
description: Lean, throughput-first version of do-ticket for Bible Artisan. Implements one BIB Linear ticket, or a small batch of related BIB tickets, as ONE pull request, merges it on green CI, and marks the tickets Done. Use only for explicit requests such as `/bib-do-ticket-fast BIB-31`, `/bib-do-ticket-fast BIB-31 BIB-61 BIB-62`, `$do-ticket-fast <linear url>`, or "do these tickets fast". Do not trigger for grooming (use `prepare`), the full careful flow (use `do-ticket`), or PR reviews.
---

# Do Ticket Fast

Ship working, tested features quickly. Depth comes later: a per-epic review pass follows each batch, so favour a complete, correct, simple implementation over exhaustive polish. The user has authorised merging on green CI.

## What is NOT relaxed (cheap now, expensive to retrofit)

Follow AGENTS.md's non-negotiable rules 1–11 exactly. In particular:

- Owner scope from the session; absent and unauthorized both 404. Study-scoped tables use `study_id` + `owner_id` with composite FKs.
- Mutation + `StudyEvent` in one transaction. `expectedRevision` (428/409) and `Idempotency-Key` on mutations, via the existing shared helpers.
- Error envelope; no private content in logs (`log-redaction` must still pass).
- AI output is a suggestion until the user accepts it; cited IDs must be in the manifest; quotes must match stored text. No AI or provider call inside a DB transaction.
- Scripture only from the corpus. Migrations reversible, models in sync with migrations.
- Never weaken types, lint, validation, authorization, or existing tests to pass checks.

## What IS relaxed

- **No grooming pass.** Work from the ticket text plus the PRD sections it cites (`docs/prd/PRD.md`, grep `# **N.`). Where the ticket is thin, choose the simplest behaviour consistent with the PRD and record the decision in the PR body and a one-line Linear comment. Don't stop to ask unless the choice could lose user data or break an invariant above.
- **Short plan.** About 10 lines in your head or scratchpad: files per layer, migration (if any), tests. No plan report.
- **Proportionate tests.** Per ticket: the main happy path, one cross-user 404 test per new private route, revision/idempotency on new mutations (one test each), the model-level test for any new model, and one test for the most likely failure. Web: one Testing Library test per new screen or major interaction, queried by role/label. Skip combinatorial and edge-case suites.
- **One self-review** of the diff against the list above. No separate review gate; a per-epic review runs later.
- **Scope trimming.** If a ticket contains a genuinely large sub-feature that isn't needed for the core user flow, implement the core, and list the deferred part in the PR body and as a Linear comment (`Deferred to hardening: ...`). Never defer a non-negotiable.

## Steps

1. Read each ticket (Linear `get_issue`, plus `list_comments`) and the PRD sections it cites. Skim the nearest existing module for patterns (`apps/api/src/modules/<x>`, `packages/contracts/src`, `apps/web/src`). Reuse helpers; don't build parallel versions.
2. `git fetch origin && git switch -c <branch> origin/main`. Branch: the first ticket's Linear `gitBranchName` (for a batch, that is fine). Move tickets to In Progress.
3. Environment, if this is a fresh checkout or worktree: `pnpm install --frozen-lockfile`, `pnpm --filter @bible-artisan/contracts build`, and make sure a root `.env` exists (copy from the main checkout or `.env.example`). If your instructions name a dedicated test database, set `DATABASE_URL_TEST` to it in `.env`.
4. Implement: contracts → migration + model → API module → web. One commit per ticket where practical: `[BIB-<n>] Imperative summary`.
5. Verify, in the foreground with a hard limit (`perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`; macOS has no `timeout`). Never background a long command and wait on it:
   - `pnpm check:local`
   - `pnpm --filter @bible-artisan/api test:integration <affected spec substrings>` (touched modules, plus `route-inventory` for route changes, `log-redaction` for new logging, `migration-reversibility` and `models` for migrations/models)
   - `git diff --check`
6. Push, open the PR: title `[BIB-<n>] Summary` (batch: `[BIB-a, BIB-b] Summary`), body with a short summary per ticket, decisions made, deferred items, the commands run with real results, and `Closes BIB-<n>` per ticket.
7. Wait for CI in the foreground: `perl -e 'alarm shift; exec @ARGV' 2400 gh pr checks <n> --watch --fail-fast`. On failure, fix on the same branch, push, wait again. If `main` moved and the PR conflicts, `git fetch && git rebase origin/main`, resolve (migrations: keep both; contracts index: keep both exports), re-run the affected checks, `git push --force-with-lease` on this branch only.
8. Merge on green: `gh pr merge <n> --merge --delete-branch`. Move each ticket to Done with a one-line comment linking the PR (and any deferred items).
9. Final report: PR URL, merged yes/no, tickets and their final status, decisions, deferred items, anything left broken.

## Never

Merge on red CI, claim checks you didn't run, force-push `main`, touch other tickets' scope beyond what the batch needs, spawn sub-agents, or end without the final report.
