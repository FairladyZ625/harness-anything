import { DOC_EVENT_SCHEMA, DOC_WRITE_INTENT_SCHEMA } from "./doc-sync-types.ts";
import { PEOPLE_EVENT_SCHEMA } from "./people-event.ts";

export default Object.freeze({
  id: "doc-sync",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze([]),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([
    Object.freeze({
      id: DOC_WRITE_INTENT_SCHEMA.id,
      schema: "packages/kernel/src/domain/doc-sync.contract.ts#DOC_WRITE_INTENT_SCHEMA",
      parser: "packages/kernel/src/domain/doc-sync.contract.ts#validateDocWriteIntent",
      writer: "packages/kernel/src/domain/doc-sync.contract.ts#serializeDocWriteIntent",
      error: "packages/kernel/src/domain/doc-sync.contract.ts#DocSyncContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/doc-write-intent-invalid.json"]),
    }),
    Object.freeze({
      id: DOC_EVENT_SCHEMA.id,
      schema: "packages/kernel/src/domain/doc-sync.contract.ts#DOC_EVENT_SCHEMA",
      parser: "packages/kernel/src/domain/doc-sync.contract.ts#validateDocEvent",
      writer: "packages/kernel/src/domain/doc-sync.contract.ts#serializeDocEvent",
      error: "packages/kernel/src/domain/doc-sync.contract.ts#DocSyncContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/doc-event-invalid.json"]),
    }),
    Object.freeze({
      id: PEOPLE_EVENT_SCHEMA.id,
      schema: "packages/kernel/src/domain/doc-sync.contract.ts#PEOPLE_EVENT_SCHEMA",
      parser: "packages/kernel/src/domain/doc-sync.contract.ts#validatePeopleEvent",
      writer: "packages/kernel/src/domain/doc-sync.contract.ts#serializePeopleEvent",
      error: "packages/kernel/src/domain/doc-sync.contract.ts#PeopleEventContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/people-event-invalid.json"]),
    }),
  ]),
});
