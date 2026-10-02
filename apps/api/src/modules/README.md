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
- All child access goes through `StudyAccessService` (or, inside a mutation, the study the
  pipeline already locked). Never query a study-scoped table by `study_id` alone to resolve a
  study: that skips the owner check and the 30-day trash rule (BIB-22). That rule lives in one
  place, `withinRecoveryWindowSql` in `study/study-lifecycle.ts` (`withinRecoveryWindow()` for a
  `Study` model query): a study trashed 30 or more days ago is the same 404 as an absent one.
  Every study resolution uses it (`requireOwnedStudy`, `requireOwnedNode` in the same single
  statement as the child, the study lock, the library). Window decisions use the database clock
  (`now()` in SQL), never `new Date()`, and `archived_at` / `deleted_at` are written with it too.
- Every study mutation follows the mutation contract below. See ADR 0001's BIB-12 addendum.
- Controllers speak DTOs from `@bible-artisan/contracts`. Never return Sequelize model instances directly.
- Mutation responses are stored on their Idempotency-Key receipt. Keep private text out of them
  where the client already has it (BIB-23's note saves return ids, revision and counts, not the
  note), so it does not linger in `mutation_receipt`.
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
   study's revision (`m.updateWithExpectedRevision(Study, { id: studyId, … })` inside the Study
   context; from another module, `StudyRevisionService.checkStudyRevision(m, expectedRevision)`,
   so that module never touches the `study` table).
5. `content_revision`, `last_event_sequence` and `last_activity_at` (BIB-21) are written once, by
   the pipeline. Never update them, or `study_event`, yourself. When only the work knows whether it changed content (BIB-20:
   a study edit that may be just a pin or tag change), declare `bumpsContentRevision: false` and
   call `m.bumpContentRevision()` for a content change; it moves the counter by one at most.
6. The global `MutationResultInterceptor` sends the stored status, `Idempotent-Replayed: true` on
   a replay, and `Cache-Control: no-store`.
7. Deadlocks and serialization failures (40P01/40001) answer 503 `TRANSIENT_CONFLICT`,
   `retryable: true`; the client retries with the same Idempotency-Key.
8. The lifecycle guard (BIB-22) runs under the study lock, before `work`: a study past its 30-day
   trash window is 404, an archived one 422 `STUDY_ARCHIVED`, a trashed one 422 `STUDY_TRASHED`.
   Never check lifecycle in a route. Only the lifecycle routes set `lifecycleTransition` on the
   spec, which allows exactly that transition's starting states.

### A mutation that finds nothing to change (BIB-27): `m.unchanged()`

Some requests are idempotent by meaning, not only by key: connecting two nodes that already have
that relationship answers `200 outcome: 'existing'` (PRD section 24) and must write nothing. Such a
`work` calls `m.unchanged()` instead of making a revision check and appending an event:

```ts
return this.mutations.execute(ownerId, mutation, {
  studyId,
  bumpsContentRevision: false,                   // required: a declared bump is already a write
  work: async (m) => {
    const result = await connectNodes(m, body, {
      beforeCreate: () => this.studyRevisions.checkStudyRevision(m, expectedRevision),
    });
    if (result.outcome === 'existing') {
      m.unchanged();                               // before any write through `m`
      return { status: 200, body: { …, studyRevision: await this.studyRevisions.currentRevision(m) } };
    }
    …                                              // created: revision checked, event appended
  },
});
```

- **Still applies**: the receipt claim, the study lock, the lifecycle guard (an archived study is
  422 `STUDY_ARCHIVED` even for a duplicate), and storing the response on the receipt before
  COMMIT, so a retry with the same key replays it exactly (and a retried `created` replays its 201,
  never turning into `existing`).
- **Skipped**: the revision check (decided: nothing is written, so a stale client cannot lose an
  update; the dedup lookup comes first so a duplicate never conflicts), the event, and the counter
  write: study `revision`, `content_revision`, `last_event_sequence` and `last_activity_at` stay as
  they were.
- **Guarded**: `unchanged()` after any write through `m` (revision check, `createChild`, event,
  `bumpContentRevision`, or a spec with `bumpsContentRevision: true`) throws, and so does any write
  through `m` after it: a programming error, 500, everything rolled back. Not allowed in `create`.
  Writes that bypass `m` cannot be tracked, so an unchanged work must not make any.

### A presentation revision (BIB-28): checking a row that is not the study

Some study state is presentation, not content: the graph layout. Its saves must still be
revision-safe, idempotent, lifecycle-guarded and recorded (rules 3-4), but must never move the
study's revision or `content_revision`, or a drag in one tab would 409 a note save in another.
No pipeline extension is needed for that: give the presentation state its own revisioned row and
check _that_ row.

```ts
return this.mutations.execute(ownerId, mutation, {
  studyId,
  bumpsContentRevision: false,                  // presentation never bumps content
  work: async (m) => {
    const row = (await StudyViewState.findOne({ where: { studyId: m.studyId, ownerId: m.ownerId } }))
      ?? (await m.createChild(StudyViewState, {}));            // first save: revision 1, under the lock
    const view = await m.updateWithExpectedRevision(StudyViewState, {   // 404 / 409 currentRevision
      id: row.id, expectedRevision, values: {},
    });
    …                                                          // the presentation write
    const event = await m.appendEvent({ eventType: 'node_position_saved', payload: { … } });
    return { status: 200, body: { viewRevision: view.revision, lastEventSequence: event.sequence } };
  },
});
```

- `updateWithExpectedRevision` already accepts any study-scoped child with `id` and `revision`,
  and only `Study` itself moves `study.revision`. With `bumpsContentRevision: false` and no
  `m.bumpContentRevision()`, the pipeline writes only `last_event_sequence` and `last_activity_at`
  (positions are deliberate work on the study, so the library's "recent" order follows them).
- The lazily created row needs no `ON CONFLICT`: every mutation of the study queues on the study
  row lock first, so two first saves serialize (the second finds the row, then 409s). The unique
  key is the backstop. A stale first save rolls the created row back with everything else.
- The 409's `currentRevision` is the presentation row's revision, and the client resends against
  it. Reads that pair rows with that revision (`GET /graph`) run in one REPEATABLE READ, read-only
  transaction so both describe one moment.
- Tested in `test/graph.int-spec.ts`: study revision, content revision, nodes and edges unchanged
  by a save; a content edit with a revision held from before the save succeeds; two concurrent
  first saves give one 200 and one 409; a snapshot read interleaved with a save is consistent.

### Creating a study (BIB-19): `MutationService.create`

A new study has no row to lock and no revision a client could have seen, so creation has its own
entry point on the same pipeline (`POST /v1/studies`, `modules/study/http/studies.service.ts`):

```ts
return this.mutations.create(ownerId, mutation, {
  study: { title, startingReferenceId },          // owner = ownerId (session); counters are the pipeline's
  work: async (m) => {                             // m.creating === true
    const node = await m.createChild(StudyNode, { type: 'question', origin: 'user', title, questionStatus: 'open' });
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
