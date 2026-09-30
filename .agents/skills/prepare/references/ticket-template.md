# Ticket template

Use this structure when rewriting a BIB Linear ticket. Include only sections that materially apply: an empty or filler section is worse than an omitted one. Where a section doesn't apply, either drop it or write a one-line reason (for example, under "Data changes": "No new table required.").

## Objective

One concise paragraph: exactly what capability exists after this ticket ships, and for whom.

## Product flow

The smallest end-to-end flow, in plain English, across UI → API → data where applicable. Use a short state-transition line or a tiny example where it materially improves clarity, e.g.:

```
Reader shows Rom 9:1 -> user selects "Add to study" -> Scripture node created (or existing canonical node focused) -> visit StudyEvent recorded -> graph + thread reflect it after reload
```

## Why this ticket exists

- Reference the PRD section(s) and FR/NFR IDs, keeping the Approved PRD link.
- Name the parent epic and what earlier tickets left unfinished.
- Say which MVP capability (PRD section 7) or acceptance scenario (section 32) this advances.

## Scope

A concrete, product-focused list of behaviors this ticket owns. This is not an implementation task list.

## Out of scope

An explicit list of adjacent-looking capabilities that must NOT be implemented now, naming the sibling ticket that owns each where one exists (e.g. "Undo of graph mutations: BIB-31"). This section exists specifically to stop an AI agent from overbuilding, so be concrete, not generic.

## Existing functionality to reuse

Name the specific modules, services, helpers (owner scoping, transaction + event writer, revision and idempotency utilities, error envelope), contract schemas, migrations, components, query hooks, and tests that already exist and must be reused rather than duplicated. Name the actual files you found during repository inspection. If a needed shared helper doesn't exist yet and is owned by another ticket, say so.

## Business rules

Unambiguous rules that current product behavior actually requires, e.g.:

- Only the study owner can read or mutate it. Anyone else gets 404.
- A Question node's `question_status` changes only by explicit user action. AI output never changes it.
- An exact Scripture range + edition already live in the study focuses the existing canonical node instead of creating a new one.
- The original question is retained when the main question changes.

Do not add a rule the current product behavior doesn't require.

## State changes

Only if the ticket genuinely involves state transitions. List only the transitions this flow needs:

```
active -> archived
archived -> active
active|archived -> trashed
trashed -> active (within 30 days)
```

Note invalid transitions only where knowing them materially helps implementation.

## Study events

Only if the ticket mutates study content or records activity. List each `StudyEvent` type written, when it is written, its visibility (thread-visible vs. internal-only), and confirm it commits in the same transaction as the mutation. Keep payloads to bounded, readable labels. No full chapters and no content that the privacy rules exclude from logs.

## API contract

For each endpoint this ticket owns:

- method + route (under `/v1`);
- authentication requirement and owner scoping;
- request body (fields, types, required/optional, limits) as a `packages/contracts` Zod schema name;
- headers: `Idempotency-Key` and `expectedRevision` where the endpoint mutates;
- the minimum sufficient response shape. Don't add fields that the UI or the PRD section 24 examples don't require;
- status codes and what triggers each (400/401/404/409/413/422/428/429/503, per section 24);
- business validation performed.

## UI behavior

Only for tickets that touch `apps/web`. Specify:

- the screen or route and the entry point (see PRD section 11);
- the states: loading, empty, error, and the save indicator states (Saving / Saved / Waiting to Sync / Conflict Needs Review / Save Failed) where edits happen;
- keyboard path and focus management; the List View or dialog equivalent for any canvas or drag action;
- phone/narrow-screen behavior (section 11, NFR-ACCESS-003);
- copy that carries meaning, especially wording that distinguishes user conclusions from AI suggestions.

## Data changes

The minimum data required. For every new table or column, state the current behavior it supports (not a future one), and the constraints that protect its invariant (CHECK, composite FK, partial unique index). If existing storage already covers it, write:

> No new table required.

## Concurrency and idempotency

Use the repository's shared revision and idempotency mechanisms. State the expected retry and conflict behavior for this flow (e.g. a stale `expectedRevision` returns 409 and preserves the client draft). Add extra locking only for a concrete invariant (e.g. concurrent canonical Scripture node creation, per-study event sequence allocation).

## Authorization and privacy

Who can perform the action. What must never appear in logs, analytics, or error text. Whether content may reach an AI provider, and under what consent.

## Observability

MVP-proportional: follow the existing logging conventions with opaque IDs, counts, latency, and status only. Don't mandate new observability infrastructure unless this ticket owns it (BIB-13, BIB-50).

## Testing requirements

Focused tests for meaningful product behavior: the happy path, the important validation failures, the cross-user 404, the relevant state transition, revision conflict and idempotent replay where applicable, and the UI states and keyboard path for web work. This is not an exhaustive combinatorial matrix. Follow the repository conventions:

- API integration tests: `apps/api/test/**/*.int-spec.ts`, against real PostgreSQL, preferred over units for behavior;
- unit tests: `*.spec.ts` next to the code, for pure logic (reference parsing, anchors, normalization);
- web tests: `*.test.tsx` with Testing Library, queried by role and label;
- assert whole API response bodies with a single `toStrictEqual`.

## Acceptance criteria

Concrete Given/When/Then criteria. Someone should be able to tell pass or fail without interpreting vague phrases. Keep the ticket's original criteria unless they are wrong. Tighten wording, and add missing ones only when current behavior requires them.

## AI implementation guidance

Always include this, adapted to the specific ticket. Name the specific things not to do, not just the generic warning:

> Implement only what is required for this ticket.
>
> Inspect existing repository patterns before adding new tables, modules, helpers, contracts, components, events, or infrastructure.
>
> Keep the PRD-mandated invariants that apply here: [list the ones that apply, e.g. owner-scoped 404, mutation + StudyEvent in one transaction, expectedRevision, Idempotency-Key, no content in logs].
>
> Prefer the smallest straightforward implementation that satisfies the product flow.
>
> Do not solve future tickets: [name the adjacent sibling tickets, e.g. "do not build undo (BIB-31) or List View (BIB-29)"].
>
> Do not introduce generic frameworks or future-proofing unless an equivalent abstraction already exists and should naturally be reused.
>
> Keep changes reviewable and localized.
