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
- Controllers speak DTOs from `@bible-artisan/contracts`. Never return Sequelize model instances directly.
