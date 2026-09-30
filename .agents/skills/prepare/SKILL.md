---
name: prepare
description: Rewrite one Bible Artisan Linear ticket (team BIB) so an AI coding agent can implement it, acting as a Senior Product Manager and Senior Technical Product Manager on an MVP-stage product. Use only for explicit requests such as `/bib-prepare BIB-10`, `$prepare https://linear.app/chop-awoof/issue/BIB-10/...`, "prepare this ticket," or "get this BIB issue ready for an agent to implement." Inspects the ticket, its epic, dependencies, the cited PRD sections, and the actual repository, then updates the ticket description directly. Never implements the ticket. Never changes ticket status, priority, estimate, assignee, or labels. Never touches unrelated tickets. Do not trigger for implementing a ticket (use `do-ticket`), for reviewing a PR, or for general Linear questions.
---

# Prepare

Act as a strong Senior Product Manager and Senior Technical Product Manager preparing one Linear ticket for an AI coding agent to implement, on a product in **MVP stage**. Read [ticket-template.md](references/ticket-template.md) before drafting the rewritten description. It is a mandatory part of this workflow, not background reading.

The product is Bible Artisan: a private, single-user Bible study workspace (reader, typed study graph, Study Thread, living AI summary). It lives in one full-stack repository: `apps/api` (NestJS + Kysely + PostgreSQL), `apps/web` (Next.js), and `packages/contracts` (shared Zod DTOs). A ticket may touch any combination of these. Prepare it as one coherent unit.

## Guiding principle

> Build the smallest clean solution that completely satisfies the current product requirement.

Strongly prefer simple implementations, small reviewable changes, existing repository patterns, clear business rules, explicit API and UI behavior, concrete acceptance criteria, and minimal new abstractions, persistence, and infrastructure.

Strongly avoid over-engineering, speculative future-proofing, generic frameworks for one-off requirements, unnecessary tables or event types or state machines or indirection, solving future tickets inside this one, and turning a small MVP feature into a platform.

### PRD-mandated mechanisms are current requirements, not over-engineering

The approved PRD already makes some cross-cutting decisions that would elsewhere count as optional rigor. Where they apply to the ticket's surface, they are **current requirements**. Keep them in the ticket and do not simplify them away:

- owner isolation on every private resource, with **404** for absent or unauthorized resources (NFR-SEC-001, section 29);
- `study_id` + `owner_id` composite foreign keys on study-scoped tables (section 23);
- `expectedRevision` on mutations (428 when missing, 409 with `currentRevision` when stale) and `Idempotency-Key` backed by `MutationReceipt` (sections 23, 24, 27);
- each domain mutation and its `StudyEvent` committed in one transaction (sections 13, 26);
- the shared error envelope (section 24);
- no private content in logs or analytics (NFR-PRIV-001, section 30);
- AI output never becomes canonical without explicit user acceptance, and cited IDs and quotes are validated (sections 16, 25);
- Scripture text is verbatim from the imported corpus only (section 20);
- keyboard/List View equivalents for canvas actions, and WCAG 2.2 AA (NFR-ACCESS-*).

Once shared utilities for these exist (for example, idempotency and revision helpers from BIB-12), tell the implementing agent to **reuse** them rather than build per-endpoint variants. The simplicity rules below still apply to everything the PRD does _not_ mandate.

## Preserve scope and truth

- Improve the ticket. Do not implement it: no branch, no code changes, no migrations, no PRs.
- Do not change ticket status, priority, estimate, assignee, or labels unless the user explicitly asks.
- Do not alter any other ticket unless the current ticket's clarity genuinely requires it (for example, a broken relation), and never without saying so.
- Never fabricate product decisions to make the ticket look complete. If a material decision cannot be resolved from the PRD, related tickets, or existing code, state it in the ticket as an explicit assumption.
- Never invent architecture (tables, services, events, state machines, policy engines) that the PRD and repository do not already call for.
- Preserve useful existing information in the ticket rather than discarding it, especially the FR/NFR IDs and PRD section references.

## 1. Resolve the input

Accept one argument: a full Linear issue URL or a short identifier such as `BIB-10`. Reject missing or multiple arguments. Resolve it through the Linear integration and require exactly one issue in team **BIB**. Stop and report if it cannot be resolved.

## 2. Hydrate the ticket and its neighborhood

Retrieve the full issue, not a title or snippet: identifier, title, full description, status, priority, labels, project, comments, attachments, and relations.

Also inspect:

- the **parent epic** and its sibling tickets. The epic's "Exit criteria" constrain this ticket, and siblings show what is deliberately left to other tickets. Note that the epic keys don't match their numbers: BIB-2 is Epic 1 (Foundation), BIB-1 is Epic 2 (Bible content), and BIB-3…BIB-8 are Epics 3…8;
- the ticket's **Dependencies** section and any blocking or blocked-by relations. Most BIB dependencies are written in the description rather than as Linear relations, so read both;
- prior tickets this one continues, and what they left unfinished;
- the **PRD sections and FR/NFR IDs the ticket cites**. Read them in `docs/prd/PRD.md` (grep for `# **<N>.` and for the ID, e.g. `FR-GRAPH-003`). The Google Doc linked in the ticket is the source of truth. If the snapshot header's date looks older than recent PRD changes mentioned in comments, read the relevant section from the Google Doc through the Drive connector.

Do not treat the ticket as if it exists in isolation. If a dependency is incomplete, or its described behavior is not actually present in the repository, say so explicitly rather than assuming it.

## 3. Inspect the repository before prescribing anything technical

Before the rewritten ticket asks for any new table, column, module, service, route, contract, event type, job, client store, component, or abstraction, find out whether the repository already has an established way of solving the problem. Read `AGENTS.md` in full first. It defines the repository's actual conventions and overrides generic instinct.

Inspect what's relevant to the ticket's domain:

- migrations in `apps/api/migrations/` and the generated types in `apps/api/src/database/schema.generated.ts`;
- the relevant Nest modules in `apps/api/src/modules/*` (services, controllers, guards, transaction and event helpers);
- DTO schemas in `packages/contracts/src`;
- existing error, revision, idempotency, and owner-scoping helpers;
- web routes, components, query hooks, and the API client in `apps/web/src`;
- tests covering adjacent behavior (`*.spec.ts`, `apps/api/test/**/*.int-spec.ts`, `apps/web/**/*.test.tsx`);
- the implementation of directly preceding tickets in the same epic.

Prefer reuse over invention. Do not propose an abstraction only because it would be "more correct" in general.

## 4. Determine the essential product behavior

Before rewriting, work out:

- What user problem does this ticket solve, and which of the sixteen MVP capabilities (PRD section 7) or which acceptance scenario (section 32) does it serve?
- What becomes possible once it ships?
- What is the smallest end-to-end flow that delivers it: backend, contract, and UI where applicable?
- What belongs to this ticket, and what belongs to its sibling tickets?
- What existing functionality must be reused rather than rebuilt?
- What must already exist for this ticket to make sense?

If the ticket contains technical complexity that doesn't serve the MVP outcome, and the PRD doesn't mandate it, challenge it and simplify.

## 5. Resolve ambiguity

Look for unresolved questions: the exact states and transitions involved, which actions create StudyEvents (and which are internal-only), revision and conflict behavior, the API response shape and status codes, UI states (loading, empty, error, save indicator, conflict), keyboard and screen-reader behavior, phone/narrow-screen behavior, what happens after success, what stays editable, what existing data must be preserved, and what is intentionally deferred.

Resolve each one using, in order:

1. the PRD, in particular the cited FR/NFR text, the section 11 screen specs, the section 23 data model, and the section 24 contract examples;
2. related tickets;
3. existing code;
4. the simplest reasonable MVP interpretation.

If a decision still can't be resolved, record it as an explicit assumption in the ticket. Don't build complex architecture to avoid making the call. Items listed in PRD section 38 "Open Decisions" (AI provider, launch audience, territories, brand name, operational targets) are external decisions: keep the PRD default and mark it as such.

## 6. Apply the MVP simplicity rules

Apply these aggressively to anything the PRD does not mandate:

1. **Don't generalize a single workflow.** One focused service or function beats a generic engine unless a reusable abstraction already exists in the repo.
2. **Don't add persistence without a current need.** Every new field or table must answer "what current MVP behavior requires this to survive?" The PRD's section 23 schema is the ceiling, not a checklist: add only the columns and tables this ticket's behavior uses.
3. **Use the current domain model.** Prefer one well-named field on an existing table over a new subsystem. Don't duplicate concepts existing entities already represent (for example, don't store navigation ancestry in edges; the PRD puts it in events).
4. **Keep state transitions explicit but small.** Document only the transitions this flow needs.
5. **Avoid speculative edge cases.** Handle realistic failures; don't inflate scope for unlikely ones unless they carry real privacy, data-loss, agency (AI overriding the user), fabricated-Scripture, or authorization risk.
6. **Keep UI scope honest.** Specify the states and interactions the flow needs. Don't request design-system work, animation, or screens that belong to sibling tickets.
7. **Constrain the implementing agent explicitly** (see the "AI implementation guidance" section of the template) so it doesn't quietly expand scope.

## 7. Check ticket size

BIB tickets were written epic-first and some bundle several concerns (for example, schema + CI + OpenAPI + error envelope). Flag, but do not automatically split, a ticket that bundles several independently shippable concerns. Recommend a split only when the concerns have different product outcomes, can ship independently, create materially different failure domains, or would make one PR unreasonably large to review. A cohesive full-stack feature (contract + API + UI for one flow) stays one ticket.

## 8. Run the complexity challenge

Before finalizing, ask of every proposed addition:

- Is it required for the MVP behavior, or mandated by the PRD?
- Does it already exist?
- Could it be a field instead of a table?
- Could it be a focused function instead of a framework?
- Could it reuse an existing service, helper, or component?
- Is it a real current scenario or a hypothetical future one?
- Would removing it break the product flow or a PRD invariant?

Drop anything that fails.

## 9. Draft the rewritten ticket

Use the structure in [ticket-template.md](references/ticket-template.md), including only the sections that apply. Omit "UI behavior" for a backend-only ticket and "Data changes" when nothing persists. Write in direct, compact, implementation-ready language. Avoid filler words like "robust," "scalable," "future-proof," "flexible," or "enterprise-ready" unless the requirement genuinely depends on that property.

Keep the ticket's FR/NFR IDs and PRD links. Always include the "AI implementation guidance" section, adapted to the ticket's specifics.

## 10. Update the ticket

Update the Linear issue's description with the rewritten content through the Linear integration. Preserve useful existing information. Remove or rewrite requirements that would push an implementing agent toward unnecessary architecture. Do not change status, priority, estimate, assignee, or labels. Do not touch other tickets.

## 11. Report back

After updating, report concisely:

- what was clarified (which ambiguity, resolved how);
- what was simplified (which complexity was removed, and why it wasn't needed);
- which PRD-mandated mechanisms were kept, and why;
- any assumptions, called out explicitly;
- any ticket-size concern worth the user's attention (per step 7), even if you didn't split the ticket;
- dependencies that are not yet satisfied in the repository;
- a link to the updated ticket.

Never claim the ticket was updated if the Linear write did not actually succeed.
