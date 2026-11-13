import { runtimeKindIds } from "./agent-runtime.ts";
import type { EntityActionContract, EntityKindContract, EntitySdkExposure } from "./entity-kind-registry.ts";
import { stateStoresForKind } from "./entity-state-stores.ts";
import type { OntologyJudgmentDeclaration } from "./ontology-source.ts";

interface RuntimeOperatorSubscriptionInstance {
  readonly instanceId: string;
  readonly installationId: string;
  readonly enabled: boolean;
  readonly credentialSource: "operator" | "instance";
  readonly auth: { readonly mode: "subscription" | "api-key" };
}

interface RuntimeOperatorSubscriptionConflict {
  readonly installationId: string;
  readonly existingInstanceId: string;
  readonly conflictingInstanceId: string;
}

export function findRuntimeOperatorSubscriptionConflict(
  instances: readonly RuntimeOperatorSubscriptionInstance[],
): RuntimeOperatorSubscriptionConflict | null {
  const owners = new Map<string, string>();
  for (const instance of instances) {
    if (!instance.enabled || instance.auth.mode !== "subscription" || instance.credentialSource !== "operator")
      continue;
    const existingInstanceId = owners.get(instance.installationId);
    if (existingInstanceId !== undefined && existingInstanceId !== instance.instanceId)
      return {
        installationId: instance.installationId,
        existingInstanceId,
        conflictingInstanceId: instance.instanceId,
      };
    owners.set(instance.installationId, instance.instanceId);
  }
  return null;
}

export interface RuntimeInstanceAccountCut {
  readonly instanceId: string;
  readonly installationId: string;
  readonly credentialSource: "operator" | "instance";
  readonly authMode: "subscription" | "api-key";
  readonly credentialRef?: string;
  readonly revision: number;
}

interface RuntimeInstanceAccountIdentity {
  readonly instanceId: string;
  readonly installationId: string;
  readonly credentialSource: "operator" | "instance";
  readonly auth: { readonly mode: "subscription" | "api-key"; readonly credentialRef?: string };
}

export function runtimeInstanceAccountCutMatches(
  current: RuntimeInstanceAccountIdentity,
  cut: RuntimeInstanceAccountCut,
  revision: number,
): boolean {
  return (
    current.instanceId === cut.instanceId &&
    revision === cut.revision &&
    current.installationId === cut.installationId &&
    current.credentialSource === cut.credentialSource &&
    current.auth.mode === cut.authMode &&
    (cut.authMode !== "api-key" || current.auth.credentialRef === cut.credentialRef)
  );
}

export const runtimeInstanceAccountJudgments = [
  {
    id: "operator-subscription-instance-uniqueness",
    symbol: "packages/kernel/src/domain/runtime-instance-contract.ts#findRuntimeOperatorSubscriptionConflict",
    inputs: ["readonly RuntimeOperatorSubscriptionInstance[]"],
    output: "RuntimeOperatorSubscriptionConflict | null",
    failureCodes: ["runtime_operator_instance_exists"],
    explain:
      "An installation can have at most one enabled subscription RuntimeInstance inheriting operator credentials; instance credentials and disabled rows do not consume the slot.",
    consumers: ["packages/daemon/src/agent-runtime-instance-store.ts"],
    sources: [],
  },
  {
    id: "runtime-instance-account-cut-current",
    symbol: "packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceAccountCutMatches",
    inputs: ["RuntimeInstance account identity", "RuntimeInstance account cut", "current revision"],
    output: "boolean",
    failureCodes: ["runtime_instance_probe_stale"],
    explain:
      "Asynchronous account probe results may update readiness, models or quota health only while the instance's installation, credential identity and revision still match the captured cut.",
    consumers: ["packages/daemon/src/agent-runtime-instance-store.ts"],
    sources: [],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

export const runtimeInstanceSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: "runtime-instance/v1",
  type: "object" as const,
  properties: {
    instanceId: { type: "string" as const, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Instance ID." },
    name: { type: "string" as const, minLength: 1, description: "Operator-facing instance name." },
    kindId: { type: "string" as const, enum: runtimeKindIds, description: "Built-in runtime adapter kind." },
    enabled: { type: "boolean" as const, description: "Whether this instance is enabled." },
    credentialSource: {
      type: "string" as const,
      enum: ["operator", "instance"] as const,
      description: "Whether a subscription instance inherits operator credentials or owns an isolated login.",
    },
    availableModels: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Models observed in this runtime instance's own credential environment.",
    },
  },
  required: ["instanceId", "name", "kindId", "enabled", "credentialSource"],
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
      action("create", "runtime-instance-create"),
      action("update", "runtime-instance-update"),
      action("delete", "runtime-instance-delete"),
      action("probe", "runtime-instance-show", true),
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
    | "stateStores"
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
    judgments: runtimeInstanceAccountJudgments,
    schema: runtimeInstanceSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("runtime-instance"),
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
