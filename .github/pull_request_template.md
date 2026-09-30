## Linear

Closes BIB-

## What changed and why

## Acceptance criteria

<!-- Copy each Given/When/Then from the ticket and say which test proves it. -->

- [ ] AC1: … proven by `path/to/test`

## Checklist

- [ ] `pnpm check` passes locally
- [ ] Every new private route/query is owner-scoped and has a cross-user test (NFR-SEC-001)
- [ ] Domain mutation + StudyEvent written in one transaction; revision/idempotency rules followed
- [ ] No private content (notes, queries, references, prompts) in logs or analytics (NFR-PRIV-001)
- [ ] Migration is reversible and `db:codegen` output is committed
- [ ] UI: keyboard reachable, visible focus, non-drag alternative where relevant (NFR-ACCESS-*)
