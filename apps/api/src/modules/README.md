# Domain modules

One Nest module per bounded context from PRD §26, each in its own folder here:
`identity`, `study`, `bible-content`, `graph`, `thread`, `notes`, `ai`, `exports`, `observability`.

Rules (see /AGENTS.md for the full list):

- A module owns writes to its tables through its own services. Other modules call those services
  and never write another module's tables directly.
- Graph and Notes write their StudyEvents through Thread **inside the same transaction**.
- AI reads read-models and creates suggestions/derived artifacts only. It never updates user conclusions.
- Private study-scoped reads and writes load the study or child through `StudyAccessService`
  (owner from `@CurrentUserId()`, IDs through `ParseResourceIdPipe`); absent and foreign IDs
  are the same 404. Children are queried by `id` + `study_id` + `owner_id`, never by ID alone.
  Every new route goes into `test/route-inventory.int-spec.ts` with its cross-user test.
- Every study mutation follows the mutation contract below. See ADR 0001's BIB-12 addendum.
- Controllers speak DTOs from `@bible-artisan/contracts`. Never return Sequelize model instances directly.

## Mutation contract (BIB-12): the only way to change study data

```ts
@Post(':studyId/nodes/:nodeId')                     // in a module that imports MutationModule
async update(
  @CurrentUserId() ownerId: string,
  @Param('studyId', ParseResourceIdPipe) studyId: string,
  @Param('nodeId', ParseResourceIdPipe) nodeId: string,
  @MutationRequest() mutation: MutationRequestInfo,
): Promise<MutationResult> {
  const expectedRevision = requireExpectedRevision(mutation.body); // 428 / 400 first
  const body = parseBody(schema, mutation.body);                    // 400
  return this.mutations.execute(ownerId, mutation, {
    studyId,
    bumpsContentRevision: true,           // false only for navigation / view-state changes
    work: async (m) => {
      const node = await m.updateWithExpectedRevision(StudyNode, {      // 404 / 409
        id: nodeId, expectedRevision, values: { … }, where: { deletedAt: null },
      });
      await Other.create({ … });          // no `{ transaction }` needed: it joins automatically
      const event = await m.appendEvent({ eventType: 'node_updated', payload: { … } });
      return { status: 200, body: dto }; // 2xx + JSON object; stored on the receipt
    },
  });                                      // return the MutationResult itself, never unwrap it
}
```

What the pipeline guarantees, so a route must not re-implement any of it:

1. One READ COMMITTED transaction; the reply is sent only after COMMIT.
2. Lock order is fixed: receipt claim → study row (`SELECT … FOR UPDATE`, owner-scoped; foreign
   or absent → 404) → whatever `work` touches. Never lock a child row before `execute` starts.
3. Every Sequelize query inside `work` joins the transaction (AsyncLocalStorage propagation, see
   `database/transaction-context.ts`), whether or not it passes `transaction`. Never pass
   `transaction: null`, never open another transaction, never call an external provider inside.
4. `work` must call `m.updateWithExpectedRevision` (the study, or a child with `study_id`; owner
   and study scoping are added for you) and `m.appendEvent` at least once each, or `execute`
   throws (500) and rolls everything back. Creating a child counts as a study change: check the
   study's revision (`m.updateWithExpectedRevision(Study, { id: studyId, … })`).
5. `content_revision` and `last_event_sequence` are written once, by the pipeline. Never update
   them, or `study_event`, yourself.
6. The global `MutationResultInterceptor` sends the stored status, `Idempotent-Replayed: true` on
   a replay, and `Cache-Control: no-store`.
7. Deadlocks and serialization failures (40P01/40001) answer 503 `TRANSIENT_CONFLICT`,
   `retryable: true`; the client retries with the same Idempotency-Key.

Not covered yet: creating a study (POST /studies has no row to lock) and mutations that are not
study-scoped. The ticket that adds the first of these extends `MutationService` with an entry
point that keeps the same guarantees; it does not bypass it.
