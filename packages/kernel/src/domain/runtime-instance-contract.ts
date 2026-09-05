import { runtimeKindIds } from "./agent-runtime.ts";
import type { EntityActionContract, EntityKindContract, EntitySdkExposure } from "./entity-kind-registry.ts";

export const runtimeInstanceSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: "runtime-instance/v1",
  type: "object" as const,
  properties: {
    instanceId: { type: "string" as const, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Instance ID." },
    name: { type: "string" as const, minLength: 1, description: "Operator-facing instance name." },
    kindId: { type: "string" as const, enum: runtimeKindIds, description: "Built-in runtime adapter kind." },
    enabled: { type: "boolean" as const, description: "Whether this instance is enabled." },
  },
  required: ["instanceId", "name", "kindId", "enabled"],
  additionalProperties: true,
});

export function createRuntimeInstanceActionCatalog(input: {
  readonly identity: EntityKindContract["id"];
  readonly noSdkExposure: EntitySdkExposure;
  readonly entityAction: (
    kind: string,
    identity: EntityKindContract["id"],
    id: string,
    sdkExposure: EntitySdkExposure,
    execution: NonNullable<EntityActionContract["execution"]>,
  ) => EntityActionContract;
  readonly executionContract: (ingress: string, read: boolean) => NonNullable<EntityActionContract["execution"]>;
}): NonNullable<EntityKindContract["actionCatalog"]> {
  const action = (id: string, ingress: string, read = false) =>
    input.entityAction(
      "runtime-instance",
      input.identity,
      id,
      input.noSdkExposure,
      input.executionContract(ingress, read),
    );
  return Object.freeze({
    ref: "daemon/runtime-instance/v1",
    actions: Object.freeze([
      action("create", "createRuntimeInstance"),
      action("update", "updateRuntimeInstance"),
      action("delete", "deleteRuntimeInstance"),
      action("probe", "showRuntimeInstance", true),
    ]),
  });
}

export function createRuntimeInstanceKindContract(input: {
  readonly typeFields: Omit<
    EntityKindContract,
    | "kind"
    | "schema"
    | "relations"
    | "canonicalProjection"
    | "statusVocabulary"
    | "actionCatalog"
    | "entityStore"
    | "authoring"
    | "sdkExposure"
  >;
  readonly actionCatalog: NonNullable<EntityKindContract["actionCatalog"]>;
  readonly noSdkExposure: EntitySdkExposure;
}): EntityKindContract {
  return {
    kind: "runtime-instance",
    ...input.typeFields,
    schema: runtimeInstanceSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    statusVocabulary: [
      { field: "status", words: ["enabled", "disabled"] },
      { field: "kindId", words: runtimeKindIds },
    ],
    actionCatalog: input.actionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: input.noSdkExposure,
  };
}
