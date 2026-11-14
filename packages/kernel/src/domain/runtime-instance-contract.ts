import { runtimeKindIds } from "./agent-runtime.ts";
import type { EntityActionContract, EntityKindContract, EntitySdkExposure } from "./entity-kind-registry.ts";
import { stateStoresForKind } from "./entity-state-stores.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

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

/** dec_DA1602487428A58E8B446ECE38/CH3: orthogonal priority and same-tier scheduling. */
const runtimeInstanceSchedulingPolicy = {
  id: "runtime-instance-scheduling",
  ownerRef: "runtime-instance",
  unit: "priority tier and same-tier strategy",
  bounds:
    "Tier is an integer 1..9 (default 1), lower first after local model and health admission. Agent selectionStrategy overrides repository selectionStrategy (default sticky). Sticky prefers the first idle instance; lru minimizes active load then O(1) node-local dispatch sequence, with no history scan. Explicit pins and resumed sessions retain instance affinity. Model catalog exact/case-insensitive spelling resolves launch compatibility within an admitted pool.",
  defaultValue: { tier: 1, selectionStrategy: "sticky" },
  version: 1,
  scope: "RuntimeInstance, Agent scheduling configuration and dispatch receipts",
  reason: "Keep model isolation, cross-tier spillover and user-selected scheduling on the existing dispatch path.",
  fixtures: [
    "packages/daemon/test/runtime-tier-selection.test.ts",
    "packages/daemon/test/runtime-tier-store.integration.test.ts",
    "packages/cli/test/runtime-scheduling-command.test.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchedulingPolicy.defaultValue.tier:821bfe01a65244f10d540222f09916f6",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchedulingPolicy.defaultValue.selectionStrategy:a1358bf6095dc99e7266a6ad3a0ba520",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#prepareAgentEntityInstall:c886eed6aa5d25854112e316ac7c5d46",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#readAgentEntityDeclarationSource:caa2b93af60d561b44f2daf90459e33d",
    "policy:packages/daemon:packages/daemon/src/agent-entities.ts#readAgentEntityDeclarationSource.withOverride:8d72fef5d37afb67c4fa9bea0ad08c5c",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#runtimeInstanceMethods.params.payload.tier:acc03c13c18f8ae274913e40e4974761",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#runtimeInstanceMethods.params.payload.tier:acc03c13c18f8ae274913e40e4974761:2",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:d9cf1d8e11919da4fa3d563e8d4731fb",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:ff84d5a340b1c772396d64135e813469",
    "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:59c9fa40bfeef57ba7414a47635803af",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:e8bf112f1d503e5bd007ed49bdff3654",
    "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:56324b18ae7ab75ce5fcdcc8ab514a8f",
    "policy:packages/kernel:packages/kernel/src/domain/agent-squad-schema.ts#AGENT_DECLARATION_V1_SCHEMA.properties.selectionStrategy:86b9a384d9a86765a572550bcfdc8817",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-contract.ts#runtimeInstanceSchema.properties.tier:bc69ddc1fd8c37f9832f20846ad21031",
  ].map((candidateId) => ({ candidateId, route: "runtime-instance scheduling" })),
} as const satisfies OntologyPolicyDeclaration;

export const runtimeInstanceSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: "runtime-instance/v1",
  type: "object" as const,
  properties: {
    instanceId: { type: "string" as const, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Instance ID." },
    name: { type: "string" as const, minLength: 1, description: "Operator-facing instance name." },
    kindId: { type: "string" as const, enum: runtimeKindIds, description: "Built-in runtime adapter kind." },
    enabled: { type: "boolean" as const, description: "Whether this instance is enabled." },
    tier: {
      type: "integer" as const,
      minimum: 1,
      maximum: 9,
      default: 1,
      description: "Priority tier; lower tiers dispatch first.",
    },
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
    policies: [runtimeInstanceSchedulingPolicy],
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
