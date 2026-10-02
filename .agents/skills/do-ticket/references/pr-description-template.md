# Pull request description template

Keep the mandatory sections of `.github/pull_request_template.md` and merge them into this structure without duplication. Remove a conditional section only when it is genuinely inapplicable. Replace every prompt with truthful, ticket-specific content, and never leave placeholder text behind.

## Linear ticket

- **Identifier:** `BIB-<n>` (and `Closes BIB-<n>`)
- **Title:** Ticket title
- **URL:** Direct Linear issue URL
- **Epic:** Parent epic identifier and name
- **PRD:** Sections and FR/NFR IDs implemented
- **Related discussion:** Relevant decision or thread links, or `None`

## Problem / Why

Explain the user problem and why the change exists. Name the MVP capability or section 32 scenario it advances.

## Solution / Summary

Describe the concrete delivered behavior and its boundaries in a short overview.

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor / tech debt
- [ ] Documentation
- [ ] Other: explain

Check only the items that truthfully apply.

## Implementation details

Explain important design choices, the layers touched (contracts / migration / API module / web), module boundaries, and alternatives considered but not taken.

## Acceptance-criteria mapping

| Acceptance criterion | Implementation   | Evidence                          |
| -------------------- | ---------------- | --------------------------------- |
| Exact criterion      | Code or behavior | Test file + name, or manual check |

Include every acceptance criterion exactly once, or clearly split composite criteria.

## API contract

- **Endpoints:** Added or changed routes and methods
- **Authentication / ownership:** Required identity; owner scoping; cross-user behavior (404)
- **Request/response:** Contract schema names in `packages/contracts`
- **Revision & idempotency:** `expectedRevision` and `Idempotency-Key` behavior
- **Errors:** Codes and status behavior (envelope)
- **Pagination/rate limits:** Behavior
- **OpenAPI:** Regenerated artifact, or `Not yet generated (pre-BIB-9)`

## Data model and migrations

- **Tables/columns:** Changes
- **Constraints:** Composite FKs, CHECKs, partial unique indexes, and the invariant each protects
- **Indexes:** Access pattern and reason
- **Models:** Hand-written sequelize-typescript model changes kept in sync with the migration, plus the model-level integration test
- **Existing data:** Backfill or compatibility handling
- **Rollback:** `down` behavior and honest limitations

## Study events and business rules

StudyEvent types written (visibility, same-transaction guarantee), state transitions, dedup rules, and AI-agency rules.

## UI and accessibility

Only for web changes: screens or routes, states (loading / empty / error / save indicator / conflict), keyboard path, focus management, List View/dialog equivalents, narrow-viewport behavior, and how AI vs. user provenance is shown.

## Security and privacy

Authentication, owner isolation, sanitization, CSRF/CORS, and confirmation that no private content reaches logs, analytics, or errors (with the test that proves it, where relevant). AI consent handling, where relevant.

## Reliability and concurrency

Transaction boundaries, revision conflicts, idempotent replay, constraints or locks protecting concurrent invariants, and job leasing.

## Observability

New or changed logs (content-free), correlation behavior, health checks. Write `No observability changes` only with a reason.

## Testing and verification

| Command or check           | Result          | Coverage/purpose                                    |
| -------------------------- | --------------- | --------------------------------------------------- |
| `pnpm check:local`         | Passed / failed | format, lint, typecheck, unit, build                |
| `test:integration <specs>` | Passed / failed | affected integration specs (PostgreSQL), named here |
| CI                         | Pending / green | full integration suite                              |
| `git diff --check`         | …               | whitespace                                          |
| Manual: …                  | …               | UI flow, keyboard-only, narrow viewport             |

List the exact commands actually run, with truthful results. Do not claim CI success until the workflow is terminal and green.

## Performance considerations

Query patterns, indexes, pagination, payload size, and render cost for graph/list UIs. Don't invent measurements.

## Screenshots / Demo

For UI changes, include screenshots or a short recording (desktop and narrow width) without real private study content. Otherwise state why this isn't applicable.

## Deployment and rollout

- **Configuration/environment:** New env vars (also added to `.env.example`), or `None`
- **Migration:** Order relative to API/worker rollout
- **Compatibility:** Web/API version skew handling
- **Worker:** Required coordination, or `None`
- **Post-deploy verification:** Concrete checks

Don't invent a deployment process the repository doesn't have.

## Rollback

Safe application and migration rollback steps, including irreversible data limitations.

## Risks and mitigations

| Risk                   | Mitigation                            |
| ---------------------- | ------------------------------------- |
| Material residual risk | Implemented or operational mitigation |

## Assumptions and decisions

- Record every material assumption and non-obvious decision.

## Out of scope

- Name the relevant exclusions and deferred work, and the BIB tickets that own them.

## Reviewer focus

- Point reviewers to the highest-risk files: owner scoping, transactions/events, migrations, contract decisions, accessibility-critical UI.

## Checklist

- [ ] Follows `AGENTS.md` rules and repository style
- [ ] Every acceptance criterion is implemented and mapped to evidence
- [ ] Contract schemas are explicit and shared; OpenAPI updated when applicable
- [ ] Every new private route is owner-scoped, with a cross-user 404 test
- [ ] Mutation + StudyEvent in one transaction; revision and idempotency tested where applicable
- [ ] Migration applies to an empty DB, `down` verified, generated types committed
- [ ] No private content, secrets, or OTPs in logs, analytics, or errors
- [ ] AI output cannot become canonical without explicit acceptance (when applicable)
- [ ] UI is keyboard-operable with visible focus, non-drag alternatives, and truthful save states (when applicable)
- [ ] `pnpm check:local`, affected integration specs, and `git diff --check` pass
- [ ] Self-review passes A and B complete
- [ ] No sibling-ticket or unrelated work included
- [ ] No debug artifacts, broad suppressions, or generated build output committed

Check only items that were actually verified, and explain every applicable item left unchecked.
