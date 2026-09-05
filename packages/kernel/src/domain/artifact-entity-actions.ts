import {
  noSdkExposure,
  entityAction,
  type EntityActionContract,
  type EntityActionInputContract,
  type EntityKindContract,
} from "./entity-kind-registry.ts";

const execution = (ingress: string) =>
  Object.freeze({
    ingress,
    compile: null,
    read: false,
    implementation: "catalog-runtime" as const,
    topology: "center-forward-write" as const,
    targetIdField: "entityId",
  });

const input = (fields: EntityActionInputContract["fields"]): EntityActionInputContract =>
  Object.freeze({ schema: "entity-action-input/v1", fields: Object.freeze(fields), exactlyOneOf: Object.freeze([]) });

export const artifactEntityImportActionInput = input([
  { field: "entityKind", type: "string", required: true },
  { field: "locator", type: "string", required: true },
  { field: "expectedVersion", type: "number", required: true },
  { field: "title", type: "string", required: false },
  { field: "entityId", type: "string", required: false },
  { field: "sourceIdentity", type: "string", required: false },
  { field: "idempotencyKey", type: "string", required: false },
  { field: "dryRun", type: "boolean", required: false },
]);

const action = (kind: string, identity: EntityKindContract["id"], id: string, ingress: string): EntityActionContract =>
  Object.freeze({
    ...entityAction(kind, identity, id, noSdkExposure, execution(ingress)),
    concurrency: Object.freeze({
      expectedVersion: Object.freeze({ authority: "entity-aggregate-revision", required: true }),
      leasePolicy: Object.freeze({ authority: "center-repo-cell-single-writer" }),
      occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
      idempotency: Object.freeze({ authority: "operation-id" }),
      artifactOwnership: Object.freeze({ owner: "entity", refTemplate: `${kind}/{entityId}` }),
    }),
    explain: `${kind}.${id} runs through the canonical entity revision fence.`,
  });

export function artifactEntityActionCatalog(
  kind: string,
  identity: EntityKindContract["id"],
): NonNullable<EntityKindContract["actionCatalog"]> {
  const imported = action(kind, identity, "import", "entity-import");
  return Object.freeze({
    ref: "kernel/entity-event/v1",
    actions: Object.freeze([
      Object.freeze({ ...imported, input: artifactEntityImportActionInput }),
      Object.freeze({
        ...action(kind, identity, "update", "entity-update"),
        input: input([
          { field: "entityKind", type: "string", required: true },
          { field: "entityId", type: "string", required: true },
          { field: "expectedVersion", type: "number", required: true },
          { field: "title", type: "string", required: false },
          { field: "locator", type: "string", required: false },
          { field: "contentVersion", type: "string", required: false },
        ]),
      }),
      Object.freeze({
        ...action(kind, identity, "archive", "entity-archive"),
        input: input([
          { field: "entityKind", type: "string", required: true },
          { field: "entityId", type: "string", required: true },
          { field: "reason", type: "string", required: true },
          { field: "expectedVersion", type: "number", required: true },
        ]),
      }),
      Object.freeze({
        ...entityAction(kind, identity, "distill-candidate", noSdkExposure, execution("distill-candidate")),
        explain: `${kind}.distill-candidate creates a generated candidate artifact without canonical writes.`,
      }),
    ]),
  });
}
