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
- Logging (BIB-13): every request already gets a correlation ID and one access line
  (`observability/request-logging.ts`), and every error one `http_error` line. Don't log request
  data yourself. If a module needs its own line, use Nest's `Logger` with a fixed message and
  allowlisted fields only (opaque IDs, counts, latency, status, error class), and extend
  `test/log-redaction.int-spec.ts` when the route takes new private input.

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
5. `content_revision`, `last_event_sequence` and `last_activity_at` (BIB-21) are written once, by
   the pipeline. Never update them, or `study_event`, yourself. When only the work knows whether it changed content (BIB-20:
   a study edit that may be just a pin or tag change), declare `bumpsContentRevision: false` and
   call `m.bumpContentRevision()` for a content change; it moves the counter by one at most.
6. The global `MutationResultInterceptor` sends the stored status, `Idempotent-Replayed: true` on
   a replay, and `Cache-Control: no-store`.
7. Deadlocks and serialization failures (40P01/40001) answer 503 `TRANSIENT_CONFLICT`,
   `retryable: true`; the client retries with the same Idempotency-Key.

### Creating a study (BIB-19): `MutationService.create`

A new study has no row to lock and no revision a client could have seen, so creation has its own
entry point on the same pipeline (`POST /v1/studies`, `modules/study/http/studies.service.ts`):

```ts
return this.mutations.create(ownerId, mutation, {
  study: { title, startingReferenceId },          // owner = ownerId (session); counters are the pipeline's
  work: async (m) => {                             // m.creating === true
    const node = await m.createChild(StudyNode, { type: 'question', title, questionStatus: 'open' });
    await m.updateCreatedStudy({ mainQuestionNodeId: node.id });  // root pointers, revision stays 1
    const event = await m.appendEvent({ eventType: 'study_created', payload: { … } });
    return { status: 201, body: dto };
  },
});
```

- Same transaction, receipt claim, fingerprint, replay, 422 on key reuse, and COMMIT-before-reply
  as `execute`. Step 2 INSERTs the study (owner from the session) instead of locking an existing
  row; the insert holds the new row's lock, so lock order stays receipt → study → children.
- No `expectedRevision` (never 428) and no revision check is required; at least one event still
  is. The study starts at revision 1 and content revision 1, shared by every root it creates, and
  its first event is sequence 1.
- `m.createChild(Model, values)` inserts into any study-scoped table with `studyId`/`ownerId`
  from the lock. Use it for children in any mutation. `m.updateCreatedStudy` exists only while
  creating; an existing study changes through `updateWithExpectedRevision`.
- A concurrent duplicate with the same key blocks on the receipt and replays the one study;
  validation that needs no lock (e.g. the starting reference) runs before `create`, so a refusal
  writes nothing at all.

Not covered yet: mutations that are not study-scoped. The ticket that adds the first one extends
`MutationService` with an entry point that keeps the same guarantees; it does not bypass it.
