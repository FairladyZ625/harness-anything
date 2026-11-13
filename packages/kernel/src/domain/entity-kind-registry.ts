import {
  cliOperationalPolicy,
  cliContractPolicy,
  dshBrokerPolicy,
  dshPresentationPolicy,
  hostKernelPolicies,
} from "./cli-operational-policy.ts";
import { presetExecutionPolicy, taskRemoteEdgePolicy } from "./preset-execution-policy.ts";
import {
  taskSubmissionPolicies,
  artifactLocatorPolicy,
  taskReviewAttributionPolicy,
  taskKernelPolicies,
  executionDelegationPolicy,
} from "./task-submission-policy.ts";
import { dispatchLifecyclePolicies, dispatchLifecycleJudgment } from "./dispatch-lifecycle-ontology.ts";
import { todoSchema } from "./todo.ts";
import { createTodoActionCatalog } from "./todo-action-contract.ts";
import {
  AGENT_DECLARATION_V1_SCHEMA,
  SQUAD_DECLARATION_V1_SCHEMA,
  squadLeaderTurnPolicy,
} from "./agent-squad-schema.ts";
import { createAgentActionCatalog } from "./agent-action-contract.ts";
import { runtimeSessionEntityV1Schema } from "./agent-runtime.ts";
import {
  DECISION_ACCEPT_REVIEW_CRITERION_REF,
  decisionEventTypes,
  decisionStates,
  decisionTransitionDefinitions,
} from "./decision-event-types.ts";
import {
  ENTITY_DOCUMENT_POLICY_ID,
  requireEntityTypeContract,
  type BaseEntity,
  type EntityKind,
  type EntityResidencyFacets,
  type EntityTypeContract,
  hostEntityTypeContract,
} from "./base-entity.ts";
import { CONTRACT_VERSION_1_0, type ContractVersion } from "./contract-version.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { compiledPattern, explainEntityJsonSchema, type EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { decisionSchema, executionSchema, factSchema, reviewSchema, taskSchema } from "./entity-document-schemas.ts";
import {
  compileDecisionReckonAction,
  compileFactRecordAction,
  compileFactReclassifyAction,
  compileFactArchiveAction,
  compileFactUnarchiveAction,
  decisionActionCompiler,
  relationActionCompiler,
  type EntityActionCompileHook,
  type EntityActionExecutionContract,
} from "./entity-action-execution.ts";
import {
  relationDirections,
  relationOrigins,
  relationStates,
  relationTypes,
  type RelationDirection,
  type RelationType,
  relationEndpointPolicy,
} from "./entity-relation.ts";
import { boundedContextExceptions, type BoundedContextActionException } from "./entity-bounded-context-exceptions.ts";
import { relationSchema } from "./entity-kind-relation-schema.ts";
import { executionStates } from "./execution.ts";
import { domainStatuses } from "./lifecycle-status.ts";
import { canonicalRelationDirections } from "./relation-direction.ts";
import { reviewVerdicts } from "./review.ts";
import { SCHEDULE_V1_SCHEMA, scheduleRunOutcomes, scheduleStates } from "./schedule.ts";
import { SETTINGS_REPOSITORY_V1_SCHEMA } from "./settings.ts";
import { PERSON_V1_SCHEMA } from "./person-profile.ts";
import { createTaskActionCatalog } from "./task-action-contract.ts";
import { createScheduleActionCatalog } from "./schedule-action-contract.ts";
import { createRuntimeSessionActionCatalog } from "./runtime-session-action-contract.ts";
import { createRuntimeInstanceActionCatalog, createRuntimeInstanceKindContract } from "./runtime-instance-contract.ts";
import { createSettingsActionCatalog } from "./settings-action-contract.ts";
import { createPersonActionCatalog } from "./person-action-contract.ts";
import { createSquadActionCatalog } from "./squad-action-contract.ts";
import { createAssignmentActionCatalog } from "./assignment-action-contract.ts";
import {
  DEFAULT_ENTITY_ACTION_RESULT_CONTRACT,
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
  executionContract,
  noActionCatalog,
  withDeclaredEntityActions,
  withDerivedActionReturns,
  type ActionReturnsContract,
  type EntityActionDescriptorFacets,
} from "./entity-action-descriptor.ts";
import { hostStateStores, stateStoresForKind, type StateStoreDeclaration } from "./entity-state-stores.ts";
import { hostAggregateSchema } from "./host.ts";
import { guiInteractionPolicy, identityGuiRejectionPolicy } from "./gui-interaction-policy.ts";
import { runtimeReleasePolicy, runtimeReleasePolicyJudgment } from "./runtime-release-readiness.ts";
import { supplyChainReleasePolicy, supplyChainReleasePolicyJudgment } from "./supply-chain-release-readiness.ts";
import { storageReadPolicy, storageReadJudgment, storageReadAdditionalJudgments } from "./storage-read-policy.ts";
import {
  decisionAdmissionPolicy,
  decisionAdmissionJudgments,
  decisionStandingClassPolicy,
} from "./decision-admission.ts";
import { storageScopePolicy, storageScopePolicyJudgments } from "./storage-scope-policy.ts";
import { taskLeasePolicy, taskLeasePolicyJudgments, taskLeasePhasePolicy } from "./task-lease-policy.ts";
import { taskExecutionWipPolicy } from "./task-wip-policy.ts";
import { todoSoftLimitPolicy } from "./todo-soft-limit.ts";
import { settingsDefaultsPolicy } from "./settings-field-declarations.ts";
import { scheduleOccurrencePolicy } from "./schedule-action-contract.ts";
import { guiAdmissionPolicy, guiAdmissionPolicyJudgments } from "./gui-admission-policy.ts";
import { gateMappingPolicy, gateMappingPolicyJudgments } from "./gate-mapping-policy.ts";
import {
  storageReplayPolicy,
  storageReplayJudgments,
  canonicalContractDecodePolicy,
  documentClaimPolicy,
  documentSyncRoutingPolicy,
  verticalDecodeDetailPolicy,
} from "./storage-replay-policy.ts";
import { completionGateOverridePolicy, completionGateOverrideJudgment } from "./completion-gate-policy.ts";
import { writerLifecyclePolicy } from "./writer-lifecycle-policy.ts";
import {
  managedIdentityPolicy,
  builtinAuthorizationContractPolicy,
  managedClientScopePolicy,
  identityLoginMapperPolicy,
  managedAuthorizationSettingsPolicy,
  identityAdapterContractPolicy,
  identityAdminNotFoundPolicy,
  identitySessionLifetimePolicy,
  identityDatabaseProcessPolicy,
  identityHealthProbePolicy,
  identityFleetPrincipalPolicy,
} from "./managed-identity-policy.ts";
import { guiQueryPacing } from "./gui-query-pacing.ts";
import { taskLeaseGuidancePolicy, returnToPlannedJudgment } from "./task-lease-guidance.ts";
import sourceContractFacets from "./source-contract-facets.json" with { type: "json" };

const sourceContracts = sourceContractFacets as Readonly<
  Record<
    string,
    {
      readonly judgments: readonly import("./ontology-source.ts").OntologyJudgmentDeclaration[];
      readonly contracts: readonly import("./ontology-source.ts").OntologySourceContract[];
    }
  >
>;

export type EntityStorageForm =
  | "lifecycle"
  | "schema"
  | "composite"
  | "host_frontmatter"
  | "hosted-entity"
  | "composite-manifest-blob";
export type DispositionLevel = "D1" | "D2" | "D3" | "D4";
export type DispositionAction = "retire" | "supersede" | "invalidate" | "archive" | "tombstone" | "hard-delete";

export interface EntityAnchorDeclaration {
  readonly entityRef: string;
  readonly anchors: ReadonlyArray<{ readonly field: string; readonly idField: string; readonly ref: string }>;
}
export interface EntityCanonicalProjectionDeclaration {
  readonly row: {
    readonly idField: string;
    readonly ownerField: string | null;
  };
}
export interface EntityRelationProjectionDeclaration {
  readonly source: {
    readonly field: string;
    readonly refTemplate: string;
  };
  readonly target: {
    readonly field: string;
    readonly refTemplate: string;
  };
  readonly direction: "directed";
  readonly strength: "strong" | "weak";
  readonly origin: "generated" | "inferred";
  readonly rationale: string;
}
export interface DispositionMatrixEntry {
  readonly level: DispositionLevel;
  readonly action: DispositionAction;
  readonly supported: boolean;
  readonly writeOpKinds: ReadonlyArray<string>;
  readonly reason: string;
}
export interface EntityDispositionMatrix {
  readonly entries: Readonly<Record<DispositionAction, DispositionMatrixEntry>>;
}

function dispositionMatrix(entries: ReadonlyArray<DispositionMatrixEntry>): EntityDispositionMatrix {
  return {
    entries: Object.fromEntries(entries.map((entry) => [entry.action, entry])) as Readonly<
      Record<DispositionAction, DispositionMatrixEntry>
    >,
  };
}

function supported(
  level: DispositionLevel,
  action: DispositionAction,
  writeOpKinds: ReadonlyArray<string>,
  reason: string,
): DispositionMatrixEntry {
  return { level, action, supported: true, writeOpKinds, reason };
}

function unsupported(level: DispositionLevel, action: DispositionAction, reason: string): DispositionMatrixEntry {
  return { level, action, supported: false, writeOpKinds: [], reason };
}

export type { EntityKind, EntityResidencyFacets, RegisteredEntity } from "./base-entity.ts";

export type EntityKindContract<E extends BaseEntity = BaseEntity, T = unknown> = EntityTypeContract<E> & {
  readonly judgments?: readonly import("./ontology-source.ts").OntologyJudgmentDeclaration[];
  readonly sourceContracts?: readonly import("./ontology-source.ts").OntologySourceContract[];
  readonly policies?: readonly import("./ontology-source.ts").OntologyPolicyDeclaration[];
  readonly ontologyExemptions?: readonly import("./ontology-source.ts").OntologySourceExemption[];
  readonly schema: EntityDocumentJsonSchema<T>;
  readonly relations: {
    readonly directions: readonly RelationDirection[];
    readonly edges: readonly {
      readonly type: RelationType;
      readonly sourceKind: string;
      readonly targetKind: string;
      readonly projection?: EntityRelationProjectionDeclaration;
    }[];
  };
  readonly canonicalProjection: EntityCanonicalProjectionDeclaration | null;
  readonly stateStores: readonly StateStoreDeclaration[];
  readonly statusVocabulary?: readonly { readonly field: string; readonly words: readonly string[] }[];
  readonly actionCatalog: {
    readonly ref: string;
    readonly actions: readonly EntityActionContract[];
    readonly reason?: string;
  } | null;
  readonly entityStore: {
    readonly document: {
      readonly pathTemplate: string;
      readonly mediaType: "application/json";
      readonly policyId: typeof ENTITY_DOCUMENT_POLICY_ID;
    };
    readonly validate?: (value: unknown) => readonly string[];
  } | null;
  readonly authoring: {
    readonly kind:
      | "generic-entity-store"
      | "task-lifecycle"
      | "fact-event"
      | "decision-event"
      | "agent-runtime-event"
      | "schedule-event"
      | "settings-event"
      | "relation-event";
    readonly contractRef: string;
  } | null;
  readonly sdkExposure: EntitySdkExposure;
  readonly framework?: {
    readonly schemaId: string;
    readonly mutabilityContract: "entityFieldContracts";
    readonly anchors: EntityAnchorDeclaration;
    readonly dispositionMatrix: EntityDispositionMatrix;
    readonly storageForm: EntityStorageForm;
  };
};

export interface EntitySdkExposure {
  readonly sdk: { readonly target: string; readonly schemaId: string } | null;
  readonly agentCapability: { readonly target: string; readonly schemaId: string } | null;
}

export interface EntityActionContract extends EntityActionDescriptorFacets {
  readonly id: string;
  readonly version: ContractVersion;
  readonly actor: {
    readonly source: "authenticated-binding";
    readonly authorityRef: string;
  };
  readonly target: {
    readonly kind: string;
    readonly refTemplate: string;
  };
  readonly input: EntityActionInputContract;
  readonly policy: {
    readonly ref: string;
    readonly action: string | null;
  };
  readonly criteria: readonly {
    readonly ref: string;
    readonly failureCode: string;
    readonly explain: string;
  }[];
  readonly concurrency: {
    readonly expectedVersion: Readonly<Record<string, unknown>>;
    readonly leasePolicy: Readonly<Record<string, unknown>>;
    readonly occurrenceClaim: Readonly<Record<string, unknown>>;
    readonly idempotency: Readonly<Record<string, unknown>>;
    readonly artifactOwnership: Readonly<Record<string, unknown>>;
  };
  readonly effects: readonly {
    readonly ref: string;
    readonly projection: string;
  }[];
  readonly returns: ActionReturnsContract;
  readonly explain: string;
  readonly sdkExposure: EntitySdkExposure;
  readonly execution: EntityActionExecutionContract | null;
}

export interface EntityActionInputField {
  /** Constraints of the resolved transport value, after CLI file/JSON expansion. */
  readonly wire?: {
    readonly omit?: boolean;
    readonly required?: boolean;
    readonly pattern?: string;
    readonly maxLength?: number;
    readonly minimum?: number;
    readonly nullable?: boolean;
    readonly normalization?: "NFC";
    readonly enum?: readonly string[];
  };
  readonly field: string;
  readonly description?: string;
  readonly type?:
    | "string"
    | "number"
    | "boolean"
    | "string-array"
    | "fact-hold-array"
    | "json-object"
    | "json-object-array";
  readonly value?:
    | { readonly kind: "string"; readonly enumRef?: readonly string[]; readonly regex?: string }
    | { readonly kind: "number" }
    | { readonly kind: "boolean" }
    | { readonly kind: "array"; readonly items: NonNullable<EntityActionInputField["value"]> }
    | {
        readonly kind: "object";
        readonly schemaRef?: string;
        readonly fields: readonly EntityActionInputField[];
      };
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly schemaRef?: string;
  readonly fields?: readonly EntityActionInputField[];
  readonly items?: EntityActionInputField;
  readonly cli?: {
    readonly name: string;
    readonly kind: "single" | "repeated" | "boolean";
    readonly error: { readonly code: string };
    readonly description?: string;
    readonly jsonFields?: readonly string[];
    readonly jsonAllowedFields?: readonly string[];
    readonly jsonEnums?: Readonly<Record<string, readonly string[]>>;
    readonly jsonSchema?: {
      readonly schemaRef: string;
      readonly fields: readonly EntityActionInputField[];
    };
    /** Edge-local decoding performed before the action crosses the Fleet channel. */
    readonly codec?:
      | { readonly kind: "json-object"; readonly source: "file" | "value"; readonly maxBytes: number }
      | {
          readonly kind: "markdown-file" | "text-file" | "line-list-file";
          readonly target: string;
          readonly maxBytes: number;
        };
    readonly conflictsWith?: readonly string[];
    readonly format?: string;
    readonly projection?: "number" | "fact-hold-array" | "json-object" | "json-object-array";
  };
}

export interface EntityActionInputContract {
  readonly schema: "entity-action-input/v1" | "entity-action-input/v2";
  readonly fields: readonly EntityActionInputField[];
  readonly exactlyOneOf: readonly (readonly string[])[];
}

export type EntityActionExplanation = Omit<EntityActionContract, "execution">;

export interface EntityKindExplanation {
  readonly schema: "entity-kind-explanation/v1";
  readonly kind: string;
  readonly residency: EntityResidencyFacets;
  readonly documentSchema: {
    readonly id: string;
    readonly fields: ReturnType<typeof explainEntityJsonSchema>;
  };
  readonly id: EntityKindContract["id"];
  readonly relations: EntityKindContract["relations"];
  readonly canonicalProjection: EntityKindContract["canonicalProjection"];
  readonly stateStores: EntityKindContract["stateStores"];
  readonly statusVocabulary: NonNullable<EntityKindContract["statusVocabulary"]>;
  readonly transitions: {
    readonly catalogRef: string | null;
    readonly available: readonly string[];
    readonly actions: readonly EntityActionExplanation[];
    readonly reason: string | null;
  };
  readonly authoring: EntityKindContract["authoring"];
  readonly sdkExposure: EntitySdkExposure;
  readonly framework: EntityKindContract["framework"] | null;
  readonly boundedContextExceptions: readonly BoundedContextActionException[];
}

const declarationDocument = (pathTemplate: string) =>
  Object.freeze({ pathTemplate, mediaType: "application/json" as const, policyId: ENTITY_DOCUMENT_POLICY_ID });
export const noSdkExposure: EntitySdkExposure = Object.freeze({ sdk: null, agentCapability: null });
const capabilityExposure = (target: string, schemaId: string): EntitySdkExposure =>
  Object.freeze({
    sdk: Object.freeze({ target: `${target[0]!.toUpperCase()}${target.slice(1)}Capability`, schemaId }),
    agentCapability: Object.freeze({ target, schemaId }),
  });
export const entityAction = (
  kind: string,
  identity: EntityKindContract["id"],
  id: string,
  sdkExposure: EntitySdkExposure = noSdkExposure,
  execution: EntityActionExecutionContract | null = null,
): EntityActionContract => {
  const descriptor: EntityActionContract = {
    id,
    version: CONTRACT_VERSION_1_0,
    actor: Object.freeze({ source: "authenticated-binding" as const, authorityRef: "actor-identity/v1" }),
    target: Object.freeze({ kind, refTemplate: identity.refTemplate }),
    input: emptyActionInput,
    policy: Object.freeze({ ref: "keycloak-policy@1", action: null }),
    criteria: Object.freeze([]),
    concurrency: defaultConcurrency(kind, identity.refTemplate),
    effects: Object.freeze([]),
    stateTransition: null,
    result: DEFAULT_ENTITY_ACTION_RESULT_CONTRACT,
    failureCodes: Object.freeze([]),
    publication: null,
    ownedArtifacts: Object.freeze([]),
    managedDocuments: Object.freeze([]),
    followUps: Object.freeze([]),
    returns: Object.freeze({ schema: "action-result/v1", fields: Object.freeze([]), guidance: Object.freeze([]) }),
    explain: `${kind}.${id} is declared but has no executable implementation.`,
    sdkExposure,
    execution,
  };
  return withDerivedActionReturns(descriptor);
};
const emptyActionInput: EntityActionInputContract = Object.freeze({
  schema: "entity-action-input/v1",
  fields: Object.freeze([]),
  exactlyOneOf: Object.freeze([]),
});
const defaultConcurrency = (kind: string, refTemplate: string): EntityActionContract["concurrency"] =>
  Object.freeze({
    expectedVersion: Object.freeze({ authority: "canonical-ledger-cut", required: false }),
    leasePolicy: Object.freeze({ authority: "none" }),
    occurrenceClaim: Object.freeze({ authority: kind === "schedule" ? "schedule-occurrence-claim" : "not-applicable" }),
    idempotency: Object.freeze({ authority: "operation-id" }),
    artifactOwnership: Object.freeze({ owner: "entity", refTemplate }),
  });
export const genericAuthoring = Object.freeze({
  kind: "generic-entity-store" as const,
  contractRef: "entity-event/v1",
});
export const genericEntityStore = (pathTemplate: string, validate?: (value: unknown) => readonly string[]) =>
  Object.freeze({ document: declarationDocument(pathTemplate), ...(validate ? { validate } : {}) });

const taskExposure = capabilityExposure("task", "task-frontmatter");
const factExposure = capabilityExposure("fact", "fact-event");
const decisionExposure = capabilityExposure("decision", "decision-package");

const entityTypeContractFields = (kind: EntityKind): Omit<EntityTypeContract, "kind"> => {
  const contract = requireEntityTypeContract(kind);
  return {
    residency: contract.residency,
    id: contract.id,
    relationEndpoint: contract.relationEndpoint,
    baseActions: contract.baseActions,
    assignmentCapability: contract.assignmentCapability,
  };
};
const taskIdentity = requireEntityTypeContract("task").id;
const factIdentity = requireEntityTypeContract("fact").id;
const decisionIdentity = requireEntityTypeContract("decision").id;
const agentIdentity = requireEntityTypeContract("agent").id;
const executionIdentity = requireEntityTypeContract("execution").id;
const reviewIdentity = requireEntityTypeContract("review").id;
const runtimeSessionIdentity = requireEntityTypeContract("runtime-session").id;
const runtimeInstanceIdentity = requireEntityTypeContract("runtime-instance").id;
const scheduleIdentity = requireEntityTypeContract("schedule").id;
const settingsIdentity = requireEntityTypeContract("settings").id;
const personIdentity = requireEntityTypeContract("person").id;
const relationIdentity = requireEntityTypeContract("relation").id;
const runtimeInstanceActionCatalog = createRuntimeInstanceActionCatalog({
  identity: runtimeInstanceIdentity,
  noSdkExposure,
  entityAction,
  executionContract: (ingress, read) => executionContract(ingress, null, read),
});
const decisionFramework = Object.freeze({
  schemaId: "decision-package",
  mutabilityContract: "entityFieldContracts" as const,
  anchors: {
    entityRef: "decision/{decisionId}",
    anchors: [
      { field: "claims", idField: "claimId", ref: "decision/{decisionId}/{claimId}" },
      { field: "chosen", idField: "id", ref: "decision/{decisionId}/{id}" },
      { field: "rejected", idField: "id", ref: "decision/{decisionId}/{id}" },
    ],
  },
  dispositionMatrix: dispositionMatrix([
    supported("D1", "retire", ["decision_retired"], "decision semantic retirement preserves organizational memory"),
    supported("D1", "supersede", ["decision_related"], "decision correction is expressed as a supersedes relation"),
    unsupported("D1", "invalidate", "decision invalidation is modeled as retire or supersede"),
    unsupported("D2", "archive", "decision archive/version-rollup is declared but not writable in M5 F5"),
    unsupported("D3", "tombstone", "bad proposed decisions are rejected, not tombstoned"),
    unsupported("D4", "hard-delete", "decision is why-memory and must never be physically deleted"),
  ]),
  storageForm: "lifecycle" as const,
});
const taskFramework = Object.freeze({
  schemaId: "task-frontmatter",
  mutabilityContract: "entityFieldContracts" as const,
  anchors: { entityRef: "task/{task_id}", anchors: [] },
  dispositionMatrix: dispositionMatrix([
    unsupported("D1", "supersede", "replay/v1 does not expose authored task package disposition writes"),
    unsupported("D1", "retire", "replay/v1 does not expose authored task package disposition writes"),
    unsupported("D1", "invalidate", "task invalidation is not a task disposition action"),
    unsupported("D2", "archive", "replay/v1 does not expose authored task package disposition writes"),
    unsupported("D3", "tombstone", "replay/v1 does not expose authored task package disposition writes"),
    unsupported("D4", "hard-delete", "replay/v1 does not expose authored task package disposition writes"),
  ]),
  storageForm: "lifecycle" as const,
});
const factFramework = Object.freeze({
  schemaId: "fact-event",
  mutabilityContract: "entityFieldContracts" as const,
  anchors: { entityRef: "fact/{fact_id}", anchors: [] },
  dispositionMatrix: dispositionMatrix([
    supported("D1", "invalidate", ["fact_recorded"], "fact invalidation is a superseding append-only Fact event"),
    unsupported("D1", "retire", "fact semantic exit is invalidate, not retire"),
    unsupported("D1", "supersede", "fact supersession remains an invalidation-class D1 action"),
    supported(
      "D2",
      "archive",
      ["fact_archived", "fact_unarchived"],
      "fact archive retires the managed document while the event and projection row stay canonical",
    ),
    unsupported("D3", "tombstone", "fact is append-only and has no single-record tombstone semantics"),
    unsupported("D4", "hard-delete", "fact must never be physically deleted as a standalone entity"),
  ]),
  storageForm: "lifecycle" as const,
});

const relationsFor = (kind: string): EntityKindContract["relations"] => {
  const edges = canonicalRelationDirections
    .filter((entry) => entry.sourceKind === kind)
    .map(({ type, sourceKind, targetKind }) => ({ type, sourceKind, targetKind }));
  return Object.freeze({ directions: edges.length ? (["directed"] as const) : [], edges: Object.freeze(edges) });
};

const executableAction = (
  kind: string,
  identity: EntityKindContract["id"],
  id: string,
  ingress: string,
  compile: EntityActionCompileHook | null,
  sdkExposure: EntitySdkExposure,
  read = false,
) => entityAction(kind, identity, id, sdkExposure, executionContract(ingress, compile, read));

const catalogRuntimeAction = (
  kind: string,
  identity: EntityKindContract["id"],
  id: string,
  ingress: string,
  sdkExposure: EntitySdkExposure,
  topology: NonNullable<EntityActionExecutionContract["topology"]> = "ledger-write",
  remoteEdgeAdmission: NonNullable<EntityActionExecutionContract["remoteEdgeAdmission"]> = "rejected",
) => {
  const declared = executableAction(kind, identity, id, ingress, null, sdkExposure);
  return Object.freeze({
    ...declared,
    execution: Object.freeze({
      ...declared.execution!,
      implementation: "catalog-runtime" as const,
      topology,
      remoteEdgeAdmission,
      targetIdField: identity.field,
    }),
  });
};

const baseEntityAction = (
  kind: string,
  identity: EntityKindContract["id"],
  id: "pin" | "unpin",
): EntityActionContract =>
  Object.freeze({
    ...entityAction(kind, identity, id, noSdkExposure),
    input: Object.freeze({
      schema: "entity-action-input/v1" as const,
      fields: Object.freeze([{ field: "entityRef", type: "string" as const, required: true }]),
      exactlyOneOf: Object.freeze([]),
    }),
    policy: Object.freeze({ ref: "keycloak-policy@1", action: `${kind}/${id}` }),
    criteria: Object.freeze([
      Object.freeze({
        ref: "entity-pin/target",
        failureCode: "entity_not_found",
        explain: "The target EntityRef must identify an existing local entity before its pin state changes.",
      }),
    ]),
    failureCodes: Object.freeze([
      Object.freeze({
        code: "entity_not_found",
        source: "criterion" as const,
        explain: "The target EntityRef does not resolve to an existing local entity.",
        nextCapabilityRef: "entity.read",
      }),
    ]),
    effects: Object.freeze([{ ref: "entity-pin-event/v1", projection: "EntityPinProjection" }]),
    explain: `${kind}.${id} changes the shared Entity pin state through the canonical writer.`,
    execution: Object.freeze({
      ingress: id === "pin" ? "entity-pin" : "entity-unpin",
      compile: null,
      read: false,
      implementation: "catalog-runtime" as const,
      topology: "center-forward-write" as const,
      remoteEdgeAdmission: "via-center-forward" as const,
      targetIdField: "entityRef",
    }),
  });

const withBaseEntityActions = <T extends readonly EntityKindContract[]>(contracts: T): T =>
  Object.freeze(
    contracts.map((contract) => {
      const facets = sourceContracts[contract.kind];
      if (facets)
        contract = {
          ...contract,
          sourceContracts: facets.contracts,
          judgments: [...(contract.judgments ?? []), ...facets.judgments],
        };
      const actionCatalog = contract.actionCatalog;
      if (actionCatalog === null || actionCatalog.reason !== undefined) return contract;
      const existing = new Set(actionCatalog.actions.map(({ id }) => id)),
        actions = [
          ...actionCatalog.actions,
          ...(existing.has("pin") ? [] : [baseEntityAction(contract.kind, contract.id, "pin")]),
          ...(existing.has("unpin") ? [] : [baseEntityAction(contract.kind, contract.id, "unpin")]),
        ];
      return Object.freeze({
        ...contract,
        actionCatalog: Object.freeze({ ...actionCatalog, actions: Object.freeze(actions) }),
      });
    }),
  ) as unknown as T;

const taskActionCatalog = createTaskActionCatalog((id) => entityAction("task", taskIdentity, id, taskExposure));
const assignmentCatalogFor = (kind: string, identity: EntityKindContract["id"], exposure: EntitySdkExposure) =>
  createAssignmentActionCatalog(kind, identity.refTemplate, (id) => entityAction(kind, identity, id, exposure));

const scheduleActionCatalog = createScheduleActionCatalog(
  (id) => entityAction("schedule", scheduleIdentity, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const agentActionCatalog = createAgentActionCatalog(
  (id) => entityAction("agent", agentIdentity, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const runtimeSessionCatalog = createRuntimeSessionActionCatalog(
  (id) => entityAction("runtime-session", runtimeSessionIdentity, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const settingsActionCatalog = createSettingsActionCatalog(
  (id) => entityAction("settings", settingsIdentity, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const personActionCatalog = createPersonActionCatalog(
  (id) => entityAction("person", personIdentity, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const squadActionCatalog = createSquadActionCatalog(
  (id) => entityAction("squad", requireEntityTypeContract("squad").id, id),
  DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT,
);

const factActionCatalog = Object.freeze({
  ref: "kernel/fact-event/v1",
  actions: Object.freeze([
    executableAction("fact", factIdentity, "record", "fact-record", compileFactRecordAction, factExposure),
    executableAction("fact", factIdentity, "reclassify", "fact-reclassify", compileFactReclassifyAction, factExposure),
    executableAction(
      "fact",
      factIdentity,
      "type-register",
      "fact-type-register",
      compileFactRecordAction,
      factExposure,
    ),
    executableAction("fact", factIdentity, "archive", "fact-archive", compileFactArchiveAction, factExposure),
    executableAction("fact", factIdentity, "unarchive", "fact-unarchive", compileFactUnarchiveAction, factExposure),
    entityAction("fact", factIdentity, "promote", noSdkExposure, executionContract("distill-promote", null, false)),
    catalogRuntimeAction("fact", factIdentity, "rematerialize", "fact-rematerialize", factExposure),
    executableAction("fact", factIdentity, "type-list", "fact-type-list", null, factExposure, true),
    executableAction("fact", factIdentity, "show", "fact-show", null, factExposure, true),
  ]),
});

const decisionWriteAction = (id: Parameters<typeof decisionActionCompiler>[0], ingress: string) =>
  executableAction("decision", decisionIdentity, id, ingress, decisionActionCompiler(id), decisionExposure);

const decisionAuxiliaryActions = {
  decision_amended: ["amend", "decision-amend"],
  decision_repinned: ["repin", "decision-repin"],
  decision_claim_declared: ["declare-claim", "decision-claim-add"],
  decision_claim_fulfillment_declared: ["fulfill-claim", "decision-claim-fulfill"],
} as const satisfies Partial<
  Record<(typeof decisionEventTypes)[number], readonly [Parameters<typeof decisionActionCompiler>[0], string]>
>;

const decisionActionCatalog = Object.freeze({
  ref: "kernel/decision-event/v1",
  actions: Object.freeze([
    decisionWriteAction("propose", "decision-propose"),
    // Accept is the one Decision write whose guard failure must guide the operator: review-required
    // rejections are attributed to this criterion and forward dispatch-review as receipt nextActions.
    ...decisionTransitionDefinitions.flatMap(({ action }) => {
      if (action === "supersede") return [entityAction("decision", decisionIdentity, action, decisionExposure)];
      return [
        action === "accept"
          ? Object.freeze({
              ...decisionWriteAction(action, `decision-${action}`),
              criteria: Object.freeze([
                {
                  ref: DECISION_ACCEPT_REVIEW_CRITERION_REF,
                  failureCode: "review_required",
                  explain:
                    "Acceptance requires an approved review of the current content whenever repository review policy covers the Decision's risk tier.",
                },
              ]),
            })
          : decisionWriteAction(action, `decision-${action}`),
      ];
    }),
    ...Object.values(decisionAuxiliaryActions).map(([id, ingress]) => decisionWriteAction(id, ingress)),
    catalogRuntimeAction("decision", decisionIdentity, "dispatch-review", "decision-dispatch-review", decisionExposure),
    catalogRuntimeAction("decision", decisionIdentity, "rematerialize", "decision-rematerialize", decisionExposure),
    decisionWriteAction("review", "decision-review"),
    decisionWriteAction("respond-review", "decision-respond-review"),
    decisionWriteAction("override-review", "decision-override-review"),
    decisionWriteAction("transition", "decision-transition"),
    executableAction(
      "decision",
      decisionIdentity,
      "reckon",
      "decision-reckon",
      compileDecisionReckonAction,
      decisionExposure,
    ),
    executableAction("decision", decisionIdentity, "validate", "decision-validate", null, decisionExposure, true),
    executableAction("decision", decisionIdentity, "list", "decision-list", null, decisionExposure, true),
    executableAction("decision", decisionIdentity, "show", "decision-show", null, decisionExposure, true),
  ]),
});

const relationActionInput = (fields: readonly EntityActionInputField[]): EntityActionInputContract =>
  Object.freeze({ schema: "entity-action-input/v1", fields, exactlyOneOf: [] });
const relationExecutableAction = (
  id: "relate" | "unrelate" | "reconfirm",
  input: EntityActionInputContract,
): EntityActionContract => {
  const declared = executableAction(
    "relation",
    relationIdentity,
    id,
    `relation-${id}`,
    relationActionCompiler(id),
    noSdkExposure,
  );
  return Object.freeze({
    ...declared,
    input,
    criteria: Object.freeze([
      {
        ref: "relation/aggregate-revision",
        failureCode: id === "reconfirm" ? "version_conflict" : "revision_conflict",
        explain: "The expected Relation aggregate revision must equal the projected revision at the canonical cut.",
      },
      ...(id === "relate"
        ? [
            {
              ref: "relation/acyclic-type",
              failureCode: "relation_cycle",
              explain:
                "An acyclic Relation type must not introduce a cycle in the current canonical Relation projection.",
            },
          ]
        : []),
    ]),
    concurrency: Object.freeze({
      expectedVersion: Object.freeze({ authority: "relation-aggregate-revision", required: true }),
      leasePolicy: Object.freeze({ authority: "none" }),
      occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
      idempotency: Object.freeze({ authority: "operation-id" }),
      artifactOwnership: Object.freeze({ owner: "initiating-execution", refTemplate: "execution/{executionId}" }),
    }),
    effects: Object.freeze([{ ref: `relation/${id}`, projection: "relation/v1" }]),
    explain: `relation.${id} appends a relation-event/v1 transition under the relation/<relationId> revision fence.`,
  });
};
const relationActionCatalog = Object.freeze({
  ref: "kernel/relation-event/v1",
  actions: Object.freeze([
    entityAction(
      "relation",
      relationIdentity,
      "migrate-assignment",
      noSdkExposure,
      executionContract("assignment-migrate", null, false),
    ),
    relationExecutableAction(
      "relate",
      relationActionInput([
        { field: "sourceRef", type: "string", required: true },
        { field: "targetRef", type: "string", required: true },
        { field: "relationType", type: "string", required: true, enum: relationTypes },
        { field: "direction", type: "string", required: false, enum: relationDirections },
        { field: "origin", type: "string", required: false, enum: relationOrigins },
        { field: "rationale", type: "string", required: true },
        { field: "expectedVersion", type: "number", required: true },
      ]),
    ),
    relationExecutableAction(
      "unrelate",
      relationActionInput([
        { field: "relationId", type: "string", required: true, regex: relationIdentity.pattern },
        { field: "reason", type: "string", required: true },
        { field: "expectedVersion", type: "number", required: true },
      ]),
    ),
    relationExecutableAction(
      "reconfirm",
      relationActionInput([
        { field: "relationId", type: "string", required: true, regex: relationIdentity.pattern },
        { field: "rationale", type: "string", required: true },
        { field: "expectedVersion", type: "number", required: true },
      ]),
    ),
  ]),
});

/**
 * Canonical-stream kinds (dec_2446BC2F8C68630F71AE3E3BD7/CH4). Each row owns one ledger stream that
 * had no registered kind, so its write roads could only declare a null catalogId. The rows carry no
 * entity store and no projection: they name the stream, its identity and the executable Actions the
 * daemon already implements (the same declared-only shape as relation/migrate-assignment).
 */
const documentKindSchema: EntityDocumentJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "document/v1",
    type: "object",
    additionalProperties: false,
    required: ["path", "policyId"],
    properties: {
      path: { type: "string", minLength: 1 },
      policyId: { type: "string", minLength: 1 },
      blobSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      size: { type: "number" },
      retirementReason: { type: "string", minLength: 1 },
    },
  },
  migrationKindSchema: EntityDocumentJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "migration/v1",
    type: "object",
    additionalProperties: false,
    required: ["repositoryId", "migratedFrom"],
    properties: {
      repositoryId: { type: "string", const: "repository" },
      migratedFrom: { type: "string", minLength: 1 },
      generation: { type: "string", enum: ["v0"] },
      entityKind: { type: "string", minLength: 1 },
    },
  },
  scriptExecutionKindSchema: EntityDocumentJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "script-execution/v1",
    type: "object",
    additionalProperties: false,
    required: ["scriptId", "mode"],
    properties: {
      scriptId: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["dry-run", "apply"] },
      status: { type: "string", minLength: 1 },
      planDigest: { type: "string", "x-nullable": true },
    },
  },
  verticalDeclarationKindSchema: EntityDocumentJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "vertical-declaration/v1",
    type: "object",
    additionalProperties: false,
    required: ["declarationId", "revision"],
    properties: {
      declarationId: { type: "string", const: "default" },
      revision: { type: "number" },
      verticalId: { type: "string", minLength: 1 },
      kindId: { type: "string", pattern: "^KND-[0-9a-f]{32}$" },
    },
  };

const documentIdentity = requireEntityTypeContract("document").id,
  migrationIdentity = requireEntityTypeContract("migration").id,
  scriptExecutionIdentity = requireEntityTypeContract("script-execution").id,
  verticalDeclarationIdentity = requireEntityTypeContract("vertical-declaration").id,
  // The daemon executes these roads directly; the catalog entry names the stream and the ingress only.
  declaredStreamAction = (
    kind: string,
    identity: EntityKindContract["id"],
    id: string,
    ingress: string,
    explain: string,
  ) => Object.freeze({ ...executableAction(kind, identity, id, ingress, null, noSdkExposure), explain });

const documentActionCatalog = Object.freeze({
    ref: "kernel/doc-event/v1",
    actions: Object.freeze([
      declaredStreamAction(
        "document",
        documentIdentity,
        "submit",
        "doc-submit",
        "Publish authored document bytes as one canonical doc-event/v1 write.",
      ),
      declaredStreamAction(
        "document",
        documentIdentity,
        "retire",
        "doc-retire",
        "Retire a canonical document by appending a document deletion with a reason.",
      ),
      declaredStreamAction(
        "document",
        documentIdentity,
        "conflict-resolve",
        "doc-conflict-resolve",
        "Resolve a local doc conflict by publishing the merged canonical document.",
      ),
      declaredStreamAction(
        "document",
        documentIdentity,
        "conflict-overwrite-center",
        "doc-conflict-overwrite-center",
        "Resolve a local doc conflict by publishing the local scratch copy over the center document.",
      ),
    ]),
  }),
  migrationActionCatalog = Object.freeze({
    ref: "kernel/migration-import-event/v1",
    actions: Object.freeze([
      declaredStreamAction(
        "migration",
        migrationIdentity,
        "import",
        "migrate-import",
        "Import v0 ledger entities as migration-import-event/v1 records.",
      ),
    ]),
  }),
  scriptExecutionActionCatalog = Object.freeze({
    ref: "kernel/vertical-script-action/v1",
    actions: Object.freeze([
      declaredStreamAction(
        "script-execution",
        scriptExecutionIdentity,
        "run",
        "script-run",
        "Run one vertical script; its document changes publish as canonical doc events.",
      ),
    ]),
  }),
  verticalDeclarationActionCatalog = Object.freeze({
    ref: "kernel/vertical-declaration-event/v1",
    actions: Object.freeze([
      declaredStreamAction(
        "vertical-declaration",
        verticalDeclarationIdentity,
        "migrate",
        "vertical-declaration-migrate",
        "Seed the canonical vertical declaration from the bundled default.",
      ),
      declaredStreamAction(
        "vertical-declaration",
        verticalDeclarationIdentity,
        "upsert-kind",
        "vertical-kind-upsert",
        "Create or update one Artifact kind inside the canonical vertical declaration.",
      ),
      declaredStreamAction(
        "vertical-declaration",
        verticalDeclarationIdentity,
        "publish-kind-schema",
        "vertical-kind-publish-schema",
        "Append a schema version to one Artifact kind in the canonical vertical declaration.",
      ),
      declaredStreamAction(
        "vertical-declaration",
        verticalDeclarationIdentity,
        "retire-kind",
        "vertical-kind-retire",
        "Retire one Artifact kind in the canonical vertical declaration.",
      ),
    ]),
  });
// prettier-ignore
export const entityKindContracts = withBaseEntityActions(withDeclaredEntityActions([
  {
    kind: "task",
    ...entityTypeContractFields("task"),
    schema: taskSchema,
    relations: relationsFor("task"),
    canonicalProjection: null,
    stateStores: stateStoresForKind("task"),
    judgments: [...taskLeasePolicyJudgments, completionGateOverrideJudgment, returnToPlannedJudgment, {
      id: "submit-validation",
      symbol: "packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateSubmitExecution",
      inputs: ["TaskLifecycleSnapshot", "SubmitExecutionCommand", "SubmitExecutionProof"],
      output: "ContractValidationIssue[]",
      failureCodes: ["invalid_transition", "invalid_proof", "invalid_submission"],
      explain: "Submission admission belongs to the task aggregate; the daemon evaluates its snapshot-only checks before delivery preparation.",
      consumers: ["packages/kernel/src/domain/task-lifecycle-command-transitions.ts"],
      sources: [{
        candidateId: "judgment:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateSubmitExecution:10b201310af5449294f8c4687cbf7b35",
        route: "submitTask → shared snapshot checks; applyTransition → submit.validate → validateSubmitExecution",
      }],
    }],
    policies: [presetExecutionPolicy, taskRemoteEdgePolicy, ...taskSubmissionPolicies, taskLeasePolicy, taskLeasePhasePolicy, ...taskKernelPolicies, taskExecutionWipPolicy, completionGateOverridePolicy, taskLeaseGuidancePolicy, {
      id: "runtime-dispatch-mutation", ownerRef: "task/release", unit: "task lease generation",
      bounds: "claimOpId must identify the same task, execution and lease version; held/reserving leases fence mutations except contract migration and parent-only amendment.",
      defaultValue: null, version: 1, scope: "center task mutation",
      reason: "Runtime settlement cannot release a later holder or bypass the existing mutation fence.",
      fixtures: ["packages/daemon/test/runtime-spawn-lifecycle-settlement.integration.test.ts"],
      sources: [
      { candidateId: "policy:packages/daemon:packages/daemon/src/repo-cell-task-mutation.ts#taskMutation:4254517165b44213a35c3638508ba56d", route: "packages/daemon/src/repo-cell-task-mutation.ts#taskMutation" },
      { candidateId: "policy:packages/daemon:packages/daemon/src/repo-cell-task-mutation.ts#taskMutation:c2a07f207dff3812d7cd929fca87048e", route: "packages/daemon/src/repo-cell-task-mutation.ts#taskMutation" },
      { candidateId: "policy:packages/daemon:packages/daemon/src/repo-cell-open.ts#openRepoWriterCell.releaseUnadmittedLease.releaseAction:1548d05acb20300aa42a5aa0827c30db", route: "rejected dispatch → task/release with the exact claimOpId" },
      ],
    }, {
      id: "submit-lease-proof", ownerRef: "task", unit: "SubmitExecution proof",
      bounds: "A normal submit owns the held execution lease and source; an amendment binds the unleased submitted execution. Session disposition is complete, partial or unavailable.",
      defaultValue: null, version: 1, scope: "task submission and amendment authority",
      reason: "The existing aggregate proof checks stay authoritative when snapshot admission runs before delivery preparation.",
      fixtures: ["packages/kernel/test/contracts/task-lifecycle-replay.test.ts", "packages/daemon/test/closeout-submit-holder.integration.test.ts"],
      sources: [{
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateSubmitExecution:25667664434e5d90dece2184f84e0396",
        route: "submit.validate → validateSubmitExecution amendment proof",
      }, {
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#validateSubmitExecution:580d7b6b06944f3f6414ed1fd48d0e8d",
        route: "submit.validate → validateSubmitExecution active lease proof",
      }],
    }, {
      id: "mutation-event-vocabulary", ownerRef: "task", unit: "task-event/v1 discriminator",
      bounds: "Only audit commands release/amend/archive/supersede/delete/reopen/contract-migrate select their matching declared event type.",
      defaultValue: null, version: 1, scope: "task aggregate mutation drafts",
      reason: "Event tags are selected inside the aggregate; no command or event is selected by default.",
      fixtures: ["packages/kernel/test/contracts/task-lifecycle-replay.test.ts", "packages/daemon/test/task-maintenance-acceptance.integration.test.ts"],
      sources: [{
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-event.ts#taskSurfaceEventTypes.release:29d7468222b464c15b20cbe3d927b75a",
        route: "taskMutationDraft → createTaskEvent",
      }, {
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-event.ts#taskSurfaceEventTypes.contract-migrate:367083fb060c5b49e6cc9d07604c199e",
        route: "taskMutationDraft → createTaskEvent",
      }],
    }, {
      id: "lease-release-replay-atomicity", ownerRef: "task", unit: "lease_released event",
      bounds: "An absent lease only accepts an unpublished reserving lease for the event execution without a status mutation; otherwise the current lease and execution must match, and any status mutation must be an allowed block. Both paths preserve the expected task and leave no lease.",
      defaultValue: null, version: 1, scope: "task lease release replay",
      reason: "Historical Squad reservation releases replay as no-ops without admitting mismatched leases, executions or task mutations.",
      fixtures: ["packages/kernel/test/contracts/task-lifecycle-replay.test.ts"],
      sources: [{
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:e8a815183d5178e3286a6601795565f3",
        route: "replayTaskLifecycleEvent → assertReplay lease_released atomicity",
      }],
    }, {
      id: "runtime-lease-release", ownerRef: "task", unit: "task lifecycle transition",
      bounds: "Release requires the current task, execution, lease version, person, write source and a nonempty reason.",
      defaultValue: "release", version: 1, scope: "runtime settlement of the current task lease",
      reason: "The existing offline-capable settlement transition retains its authority checks while emitting through the aggregate.",
      fixtures: ["packages/kernel/test/contracts/task-lifecycle-lowrisk-rework.test.ts"],
      sources: [{
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-runtime-lease-transition.ts#releaseRuntimeLease:42071ecbd09d23461798f3ebce8ef7eb",
        route: "releaseRuntimeLease → createTaskEvent",
      }],
    }],
    statusVocabulary: [{ field: "lifecycle.status", words: domainStatuses }],
    actionCatalog: Object.freeze({
      ...taskActionCatalog,
      actions: Object.freeze([
        ...taskActionCatalog.actions.filter((action) => action.id !== "assign" && action.id !== "unassign"),
        ...assignmentCatalogFor("task", taskIdentity, taskExposure),
      ]),
    }),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: taskExposure,
    framework: taskFramework,
  },
  {
    kind: "fact",
    judgments: [
      {
        id: "factAdmission",
        symbol: "packages/kernel/src/domain/fact-admission.ts#assertFactAdmissionAtCut",
        inputs: ["FactAdmissionState", "FactEventV1"],
        output: "void or FactProjectionError",
        failureCodes: ["entity_not_found", "invalid_transition", "fact_type_unregistered", "relation_invalid"],
        explain:
          "Admit Fact observations, reclassification and archive transitions at one canonical cut, preserving observation data and current liveness.",
        consumers: [
          "packages/storage/src/projection/fact-event-projection.ts",
          "packages/storage/src/projection/rebuildable-task-projection-knowledge-queries.ts",
          "packages/storage/src/pg/pg-task-projection.ts",
          "packages/daemon/src/fact-archive-document.ts",
        ],
        sources: [
          {
            candidateId:
              "judgment:packages/kernel:packages/kernel/src/domain/fact-admission.ts#assertFactAdmissionAtCut:1fef43dfa9c5af4f4af3c20547213f41",
            route: "domain",
          },
        ],
        consumerRules: [
          {
            pathPattern: "^packages/(?:daemon|storage|cli|gui)/",
            pattern: "reclassification changed observation data|is already superseded\\.",
            reason: "consume kernel Fact admission instead of repeating observation or supersession guards",
          },
          {
            pathPattern: "^packages/daemon/src/fact-archive",
            pattern: "\\.archived\\s*(?:===|!==)",
            reason: "consume the kernel Fact archive-transition verdict",
          },
        ],
      },
    ],
    ...entityTypeContractFields("fact"),
    schema: factSchema,
    relations: relationsFor("fact"),
    canonicalProjection: null,
    stateStores: stateStoresForKind("fact"),
    statusVocabulary: [{ field: "state", words: ["standing", "superseded_fact"] }],
    actionCatalog: Object.freeze({
      ...factActionCatalog,
      actions: Object.freeze([
        ...factActionCatalog.actions,
        ...assignmentCatalogFor("fact", factIdentity, factExposure),
      ]),
    }),
    entityStore: null,
    authoring: { kind: "fact-event", contractRef: "fact-event/v1" },
    sdkExposure: factExposure,
    framework: factFramework,
  },
  {
    kind: "decision",
    judgments: [
      ...decisionAdmissionJudgments,
      {
        id: "coverageOf",
        symbol: "packages/kernel/src/domain/decision-coverage.ts#coverageOf",
        inputs: ["decisions", "facts", "tasks", "relations"],
        output: "readonly CoverageResult[]",
        failureCodes: [],
        explain:
          "Claim fulfillment uses current evidence, completed delivery or an in-effect standing policy; live refuters veto coverage.",
        consumers: [
          "packages/storage/src/projection/decision-projection-coverage.ts",
          "packages/storage/src/pg/pg-knowledge-queries.ts",
        ],
        sources: [
          {
            candidateId:
              "judgment:packages/kernel:packages/kernel/src/domain/decision-coverage.ts#coverageOf:d3df3a660dcee479e2e2d67a090725b2",
            route: "domain",
          },
        ],
        consumerRules: [
          {
            pathPattern: "^packages/(?:storage|daemon|cli|gui|kernel/src/projection)/",
            pattern:
              "(?:function|const)\\s+(?:coveragePath|firstFact|standingPolicy)\\b|(?:EXISTS|COUNT\\s*\\()[\\s\\S]{0,240}(?:evidenced-by|supersedes-fact)",
            reason: "consume coverageOf; SQL and edge helpers must not infer claim coverage or Fact liveness",
            flags: "iu",
          },
        ],
      },
      {
        id: "coveragePath",
        symbol: "packages/kernel/src/domain/decision-coverage.ts#coveragePath",
        inputs: ["decision", "claimRef", "mode", "bySource", "live", "done"],
        output: "{ covered, path, coveringFactRef? }",
        failureCodes: [],
        explain:
          "Find the first satisfying canonical fulfillment path, with cycle-safe transitive evidence traversal.",
        consumers: ["packages/kernel/src/domain/decision-coverage.ts"],
        sources: [
          {
            candidateId:
              "judgment:packages/kernel:packages/kernel/src/domain/decision-coverage.ts#coveragePath:3fc54b7fb52e46ff07f7c1cabb3ef861",
            route: "domain",
          },
        ],
      },
    ],
    ...entityTypeContractFields("decision"),
    schema: decisionSchema,
    relations: relationsFor("decision"),
    canonicalProjection: null,
    stateStores: stateStoresForKind("decision"),
    policies: [decisionAdmissionPolicy, decisionStandingClassPolicy,{
      id: "acceptance-draft-fields", ownerRef: "decision", unit: "decision-event/v1 acceptance draft",
      bounds: "standingPolicy starts false; policyRevision is copied only when numeric; the acceptance writer retains final admission.",
      defaultValue: false, version: 1, scope: "Decision accept action compilation",
      reason: "The existing draft defaults and optional revision retain their wire values when construction moves to the aggregate.",
      fixtures: ["packages/kernel/test/contracts/entity-action-execution.test.ts", "packages/kernel/test/contracts/aggregate-event-construction.test.ts"],
      sources: [{
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/entity-action-execution.ts#decisionEvent.standingPolicy:14a7dca707325bd3e89236d8e10fcce1",
        route: "decisionEvent accept → createDecisionEvent",
      }, {
        candidateId: "policy:packages/kernel:packages/kernel/src/domain/entity-action-execution.ts#decisionEvent:632f66e278185119f03056ac899f9b11",
        route: "decisionEvent accept → createDecisionEvent",
      }],
    }],
    statusVocabulary: [{ field: "state", words: decisionStates }],
    actionCatalog: Object.freeze({
      ...decisionActionCatalog,
      actions: Object.freeze([
        ...decisionActionCatalog.actions,
        ...assignmentCatalogFor("decision", decisionIdentity, decisionExposure),
      ]),
    }),
    entityStore: null,
    authoring: { kind: "decision-event", contractRef: "decision-event/v1" },
    sdkExposure: decisionExposure,
    framework: decisionFramework,
  },
  {
    kind: "relation",
    ...entityTypeContractFields("relation"),
    schema: relationSchema,
    relations: relationsFor("relation"),
    canonicalProjection: {
      row: { idField: "id", ownerField: null },
    },
    stateStores: stateStoresForKind("relation"),
    statusVocabulary: [{ field: "state", words: relationStates }],
    actionCatalog: relationActionCatalog,
    entityStore: null,
    authoring: { kind: "relation-event", contractRef: "relation-event/v1" },
    sdkExposure: noSdkExposure,
    policies: [relationEndpointPolicy],
  },
  {
    kind: "todo",
    ...entityTypeContractFields("todo"),
    schema: todoSchema,
    relations: {
      directions: ["directed"],
      edges: canonicalRelationDirections.filter((edge) => edge.sourceKind === "todo"),
    },
    canonicalProjection: { row: { idField: "id", ownerField: null } },
    stateStores: stateStoresForKind("todo"),
    actionCatalog: createTodoActionCatalog((id) => entityAction("todo", requireEntityTypeContract("todo").id, id)),
    entityStore: genericEntityStore("todos/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
    policies: [todoSoftLimitPolicy],
  },
  {
    kind: "agent",
    ...entityTypeContractFields("agent"),
    schema: AGENT_DECLARATION_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: { row: { idField: "id", ownerField: null } },
    stateStores: stateStoresForKind("agent"),
    actionCatalog: Object.freeze({
      ...agentActionCatalog,
      actions: Object.freeze([
        ...agentActionCatalog.actions,
        ...assignmentCatalogFor("agent", agentIdentity, noSdkExposure),
      ]),
    }),
    entityStore: genericEntityStore("agents/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "squad",
    ...entityTypeContractFields("squad"),
    schema: SQUAD_DECLARATION_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: { row: { idField: "id", ownerField: null } },
    stateStores: stateStoresForKind("squad"),
    actionCatalog: Object.freeze({
      ...squadActionCatalog,
      actions: Object.freeze([
        ...squadActionCatalog.actions,
        ...assignmentCatalogFor("squad", requireEntityTypeContract("squad").id, noSdkExposure),
      ]),
    }),
    entityStore: genericEntityStore("squads/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
    policies: [squadLeaderTurnPolicy],
  },
  {
    kind: "execution",
    ...entityTypeContractFields("execution"),
    schema: executionSchema,
    relations: {
      directions: ["directed"],
      edges: [
        {
          type: "executes",
          sourceKind: "execution",
          targetKind: "task",
          projection: {
            source: { field: "executionId", refTemplate: executionIdentity.refTemplate },
            target: { field: "taskId", refTemplate: taskIdentity.refTemplate },
            direction: "directed",
            strength: "strong",
            origin: "generated",
            rationale: "Execution belongs to its task lifecycle.",
          },
        },
      ],
    },
    canonicalProjection: {
      row: { idField: "executionId", ownerField: "taskId" },
    },
    stateStores: stateStoresForKind("execution"),
    statusVocabulary: [{ field: "state", words: executionStates }],
    actionCatalog: noActionCatalog(
      "kernel/task-lifecycle/v1",
      "Task lifecycle projection; no independent actions (decision/dec_A6B0EF213AE9643FD84EC5F197/CH1).",
    ),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: noSdkExposure,
    policies: [executionDelegationPolicy],
  },
  {
    kind: "review",
    ...entityTypeContractFields("review"),
    schema: reviewSchema,
    relations: {
      directions: ["directed"],
      edges: [
        {
          type: "reviews",
          sourceKind: "review",
          targetKind: "execution",
          projection: {
            source: { field: "reviewId", refTemplate: reviewIdentity.refTemplate },
            target: { field: "executionId", refTemplate: executionIdentity.refTemplate },
            direction: "directed",
            strength: "strong",
            origin: "generated",
            rationale: "Review records judgment for its execution.",
          },
        },
      ],
    },
    canonicalProjection: {
      row: { idField: "reviewId", ownerField: "taskId" },
    },
    stateStores: stateStoresForKind("review"),
    statusVocabulary: [{ field: "verdict", words: reviewVerdicts }],
    actionCatalog: noActionCatalog(
      "kernel/task-lifecycle/v1",
      "Task lifecycle projection; no independent actions (decision/dec_A6B0EF213AE9643FD84EC5F197/CH1).",
    ),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "runtime-session",
    ...entityTypeContractFields("runtime-session"),
    schema: runtimeSessionEntityV1Schema,
    relations: {
      directions: ["directed"],
      edges: [{ type: "executes", sourceKind: "runtime-session", targetKind: "task" }],
    },
    canonicalProjection: {
      row: { idField: "runtimeSessionId", ownerField: null },
    },
    stateStores: stateStoresForKind("runtime-session"),
    statusVocabulary: [
      { field: "liveness", words: ["live", "stale", "unknown", "exited"] },
      { field: "outcome", words: ["succeeded", "failed", "unknown", "cancelled", "stopped"] },
      {
        field: "semanticState",
        words: ["running", "succeeded", "failed", "cancelled", "stopped", "ended-indeterminate", "unavailable"],
      },
    ],
    actionCatalog: runtimeSessionCatalog,
    policies: dispatchLifecyclePolicies,
    judgments: [dispatchLifecycleJudgment],
    entityStore: null,
    authoring: { kind: "agent-runtime-event", contractRef: "agent-runtime-event/v1" },
    sdkExposure: noSdkExposure,
  },
  createRuntimeInstanceKindContract({
    typeFields: entityTypeContractFields("runtime-instance"),
    actionCatalog: runtimeInstanceActionCatalog,
    noSdkExposure,
  }),
  {
    kind: "schedule",
    ...entityTypeContractFields("schedule"),
    schema: SCHEDULE_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: {
      row: { idField: "scheduleId", ownerField: null },
    },
    stateStores: stateStoresForKind("schedule"),
    statusVocabulary: [
      { field: "state", words: scheduleStates },
      { field: "status.lastRun.outcome", words: scheduleRunOutcomes },
    ],
    actionCatalog: Object.freeze({
      ...scheduleActionCatalog,
      actions: Object.freeze([
        ...scheduleActionCatalog.actions,
        ...assignmentCatalogFor("schedule", scheduleIdentity, noSdkExposure),
      ]),
    }),
    entityStore: null,
    authoring: { kind: "schedule-event", contractRef: "schedule-event/v1" },
    sdkExposure: noSdkExposure,
    policies: [scheduleOccurrencePolicy],
  },
  {
    kind: "settings",
    ...entityTypeContractFields("settings"),
    schema: SETTINGS_REPOSITORY_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: {
      row: { idField: "settingsId", ownerField: null },
    },
    stateStores: stateStoresForKind("settings"),
    actionCatalog: settingsActionCatalog,
    entityStore: null,
    authoring: { kind: "settings-event", contractRef: "settings-event/v1" },
    sdkExposure: noSdkExposure,
    policies: [settingsDefaultsPolicy],
  },
  {
    kind: "person",
    ...entityTypeContractFields("person"),
    schema: PERSON_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("person"),
    actionCatalog: personActionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "document",
    ...entityTypeContractFields("document"),
    schema: documentKindSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("document"),
    actionCatalog: documentActionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
    policies: [documentClaimPolicy, documentSyncRoutingPolicy],
  },
  {
    kind: "migration",
    ...entityTypeContractFields("migration"),
    schema: migrationKindSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("migration"),
    actionCatalog: migrationActionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "script-execution",
    ...entityTypeContractFields("script-execution"),
    schema: scriptExecutionKindSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("script-execution"),
    actionCatalog: scriptExecutionActionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "vertical-declaration",
    ...entityTypeContractFields("vertical-declaration"),
    schema: verticalDeclarationKindSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: stateStoresForKind("vertical-declaration"),
    actionCatalog: verticalDeclarationActionCatalog,
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
    policies: [verticalDecodeDetailPolicy],
  },
  {
    ...hostEntityTypeContract,
    judgments: [runtimeReleasePolicyJudgment, supplyChainReleasePolicyJudgment, storageReadJudgment, ...storageReadAdditionalJudgments, ...storageReplayJudgments, ...storageScopePolicyJudgments, ...guiAdmissionPolicyJudgments, ...gateMappingPolicyJudgments],
    policies: [
      cliOperationalPolicy, cliContractPolicy,
      writerLifecyclePolicy,
      managedIdentityPolicy,
      guiQueryPacing,
      guiInteractionPolicy,
      guiAdmissionPolicy,
      gateMappingPolicy,
      storageReadPolicy,
      storageReplayPolicy,
      canonicalContractDecodePolicy,
      ...hostKernelPolicies,
      storageScopePolicy,
      runtimeReleasePolicy,
      supplyChainReleasePolicy,
      {
        id: "fleet-numeric-input",
        ownerRef: "action:daemon-fleet-edge-sync",
        unit: "decimal TCP port text / byte count text",
        bounds:
          "CLI lexical check: port is 0 or 1–5 decimal digits without leading zeros (0..99999); quota is 1–16 decimal digits without leading zeros (1..9999999999999999). Transport validation applies separately.",
        defaultValue: null,
        version: 1,
        scope: "daemon fleet center start / edge sync: explicit flags or fleet-edge.json values",
        reason: "Declare the existing fleetNumber lexical admission boundary without changing accepted input.",
        fixtures: ["packages/cli/test/daemon-fleet-cli.test.ts"],
        sources: [
          {
            candidateId:
              "policy:packages/cli:packages/cli/src/daemon/control.ts#fleetControl:ffe26bc40e4269ed71c7ce30faa894d0",
            route: "daemon.fleet.edge.sync",
          },
        ],
      },
      artifactLocatorPolicy,
      taskReviewAttributionPolicy,
      builtinAuthorizationContractPolicy,
      dshBrokerPolicy,
      dshPresentationPolicy,
      managedClientScopePolicy,
      identityLoginMapperPolicy,
      managedAuthorizationSettingsPolicy,
      identityAdapterContractPolicy,
      identityAdminNotFoundPolicy,
      identitySessionLifetimePolicy,
      identityDatabaseProcessPolicy,
      identityHealthProbePolicy,
      identityFleetPrincipalPolicy,
      identityGuiRejectionPolicy,
      {
        id: "daemon-protocol-fleet",
        ownerRef: "host",
        unit: "daemon protocol/Fleet admission, timeout, retry and quota values",
        bounds: "Existing daemon protocol, client, transport, access and Fleet literals retain their current validation branches, defaults, retry budgets and timeout propagation.",
        defaultValue: null,
        version: 1,
        scope: "packages/daemon protocol, client, transport, access and Fleet boundary",
        reason: "Register existing daemon boundary policy sources in the shared host contract without changing runtime behavior.",
        fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
        sources: [
          { candidateId: "policy:packages/daemon:packages/daemon/src/access-admin-service.ts#receiptListLimit:57b413e426ea45d13caed4eb1d609d65", route: "packages/daemon/src/access-admin-service.ts#receiptListLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:2", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:3", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:4", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:5", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.progressDeadline:28fbe7e0adf69ee5e629ee021ecf46bf", route: "packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.progressDeadline" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/daemon-service.ts#runDaemonServiceCommand.result.timeoutSignal:a0ffb54437f00b213319ed2bd17e59c2", route: "packages/daemon/src/client/daemon-service.ts#runDaemonServiceCommand.result.timeoutSignal" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig:71e97e6c158cd623dfe2d07654cc3d18", route: "packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig:fbabdfeeabe85e6e0f0aaa95e5ba5c27", route: "packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/local-json-rpc-stream.ts#reconnectAttemptLimit:c6b45c93c3c045b7b178f5ffc6b16f1b", route: "packages/daemon/src/client/local-json-rpc-stream.ts#reconnectAttemptLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/client/terminal-relay.ts#relayDaemonTerminal.detach.timeoutMs:a883cef9fc71b79b83aa77c3644939a5", route: "packages/daemon/src/client/terminal-relay.ts#relayDaemonTerminal.detach.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-center-admission.ts#prepareFleetCenterAdmission:9655ee83a3bfb823317404523b9e3185", route: "packages/daemon/src/fleet-center-admission.ts#prepareFleetCenterAdmission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-center-admission.ts#syncFleetEdgeMirror:1f8bd7df94f8b6ded8aae2a29bf74b2a", route: "packages/daemon/src/fleet-center-admission.ts#syncFleetEdgeMirror" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-center-config.ts#readFleetCenterConfig:b55f993806ec30b68c7727e7b880f2ee", route: "packages/daemon/src/fleet-center-config.ts#readFleetCenterConfig" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-git-preflight.ts#gitTimeoutMs:f3473930845686b0016e7a2e6d7dd653", route: "packages/daemon/src/fleet-edge-git-preflight.ts#gitTimeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-git-preflight.ts#gitFetchTimeoutMs:d7bc5a53eb91e75cda86928d5e011ce4", route: "packages/daemon/src/fleet-edge-git-preflight.ts#gitFetchTimeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:89b25555fb25353fed758c96a141a15a", route: "packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:2aa23988b576f7993582719ff14f10d7", route: "packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:6de6f18030ea9fe60f616bea9d75500c", route: "packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#runtimeOverviewPageLimit:432ae75beaa1d97d1545d6c6c75fc5cf", route: "packages/daemon/src/fleet-edge-runtime.ts#runtimeOverviewPageLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.recoverEdgeReviewerReview.timeoutMs:1e68bc5ad24e9809c166c766170bb923", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.recoverEdgeReviewerReview.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext.executionId:61b2eb926a33088d5da971f5f20374c6", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext.executionId" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:694f90d7281ffb91476471d3952b9935", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:4368c535502fcff7e6c130fe664e669d", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:61b2eb926a33088d5da971f5f20374c6", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.onRuntimeOutcome:18552b0195152b438b36a4942500d6cb", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.onRuntimeOutcome" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.onAttemptTerminal.settled:3260edbfa383301559c9e7bece3e78a1", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.onAttemptTerminal.settled" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.runSchedule:943f3321456b1149301dffc546c83476", route: "packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.runSchedule" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#taskRuntimeContext:7dfefa24e53538d618ff71ca8895074b", route: "packages/daemon/src/fleet-edge-runtime.ts#taskRuntimeContext" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#verifyFleetTaskSubmitHolder:14085f29822d258e9ba1df56ece5c97d", route: "packages/daemon/src/fleet-edge-task.ts#verifyFleetTaskSubmitHolder" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.waitMs:8cb535b041e6770a62d1db5651e147f0", route: "packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.waitMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask:fa3da66cf6e2bbcc0dc7616243c35e5c", route: "packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.authorize:14085f29822d258e9ba1df56ece5c97d", route: "packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.authorize" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.timeoutMs:1e68bc5ad24e9809c166c766170bb923", route: "packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.attachTaskDocs.descriptors.timeoutMs:1e68bc5ad24e9809c166c766170bb923", route: "packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.attachTaskDocs.descriptors.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-write.ts#BACKOFF_MIN_MS:cb763693917117827939028c2eb095f1", route: "packages/daemon/src/fleet-edge-write.ts#BACKOFF_MIN_MS" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-write.ts#BACKOFF_MAX_MS:019bfde8f55888b912020a3a468d6743", route: "packages/daemon/src/fleet-edge-write.ts#BACKOFF_MAX_MS" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-edge-write.ts#runFleetEdgeRetry.attempt:11ab76e8d0c02192aa2b1be4c6731dd8", route: "packages/daemon/src/fleet-edge-write.ts#runFleetEdgeRetry.attempt" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet-task-delivery.ts#assertFleetDeliveryHolder:d24c9064b6f713519f68d752098c35e3", route: "packages/daemon/src/fleet-task-delivery.ts#assertFleetDeliveryHolder" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue:6ee5ea5aa3ebb16d6998452dcd08ff1a", route: "packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue.acquire:d2185cb6a2a6cfdc063704076b76171d", route: "packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue.acquire" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-delivery-drain.ts#createFleetDeliveryDrain.admit.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/center-delivery-drain.ts#createFleetDeliveryDrain.admit.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-hello-guard.ts#trackedSourceLimit:74783ecd43901c1ebd289dd876afcc97", route: "packages/daemon/src/fleet/center-hello-guard.ts#trackedSourceLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-lease-claims.ts#uploadWindow.limit:5a54c37d9e45cbd0b420e16e838b8c2e", route: "packages/daemon/src/fleet/center-lease-claims.ts#uploadWindow.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-lease-claims.ts#reclaimConsumedClaims.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/center-lease-claims.ts#reclaimConsumedClaims.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-lease-claims.ts#discardOwnedClaims.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/center-lease-claims.ts#discardOwnedClaims.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.REQUEST_RECEIPT_LIMIT:73c57d68613140ec5ded8a48ecae8b85", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.REQUEST_RECEIPT_LIMIT" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released:c634ea4f4d8960a8ac39fbdbce66e15c:2", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.admitReplica:89abda51ae346ee745663c7b0c55471b", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.admitReplica" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:f432688bfdf28796038fda7a3faf5afa", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:1bfcfc598ecd35e03e60db29c5b67620", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:2ab74bd0e156d6731a10b18d0806768b", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:1b338d396a4c7609d3a6cfb4a96bea12", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:911d8a441b8dec3dfbae3b49585c0357", route: "packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-transport.ts#serve.retryable:88f471d203aaf3435eafc42f1e4997ce", route: "packages/daemon/src/fleet/center-transport.ts#serve.retryable" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/center-transport.ts#serve.retryable:9d137020ab8a9d1567f6f03db930fe95", route: "packages/daemon/src/fleet/center-transport.ts#serve.retryable" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/command-protocol.ts#FLEET_HELLO_TIMEOUT_MS:c6a9ae6c461b31c2572c53bb7b6b5951", route: "packages/daemon/src/fleet/command-protocol.ts#FLEET_HELLO_TIMEOUT_MS" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/command-protocol.ts#FLEET_HELLO_FAILURE_LIMIT:48a170af39fc736d526f6ec23f3e7c89", route: "packages/daemon/src/fleet/command-protocol.ts#FLEET_HELLO_FAILURE_LIMIT" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/command-transfer.ts#FleetTransferAssembler.push.retryable:49188e32d290298ebe7a0c207681d989", route: "packages/daemon/src/fleet/command-transfer.ts#FleetTransferAssembler.push.retryable" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#DEFAULT_QUOTA_FRACTION:d281df789b788f42879056823d9946c1", route: "packages/daemon/src/fleet/edge-join-client.ts#DEFAULT_QUOTA_FRACTION" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#joinFleetEdge:a0303276c88d116a4206d1f6a1799c55", route: "packages/daemon/src/fleet/edge-join-client.ts#joinFleetEdge" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#joinFleetEdge.synced.timeoutMs:1e68bc5ad24e9809c166c766170bb923", route: "packages/daemon/src/fleet/edge-join-client.ts#joinFleetEdge.synced.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#deriveEdgeJoinQuotaBytes:6dc54d57fc380020dbfe8878bb85b2a3", route: "packages/daemon/src/fleet/edge-join-client.ts#deriveEdgeJoinQuotaBytes" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#validateFleetOriginAddress.result.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05", route: "packages/daemon/src/fleet/edge-join-client.ts#validateFleetOriginAddress.result.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/edge-join-ssh-tunnel.ts#startupTimeoutMs:03186d7c538a78eea23357e304ea20c7", route: "packages/daemon/src/fleet/edge-join-ssh-tunnel.ts#startupTimeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#leaseRows.runtimeSessionId:b50e578b4c4037af9205216797c42a25", route: "packages/daemon/src/fleet/fleet-overview-read.ts#leaseRows.runtimeSessionId" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#validateNodeRow:a1113d2bf0742179c00b5a062ab5cb00", route: "packages/daemon/src/fleet/fleet-overview-read.ts#validateNodeRow" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#EVENT_PAGE_LIMIT:ed4924a88b6116eeae88c9bd215c192f", route: "packages/daemon/src/fleet/fleet-overview-read.ts#EVENT_PAGE_LIMIT" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.page.limit:566e0d0917d2d5e10ead25ab3a9e3260", route: "packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.page.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.page.leaseOnly:7d0d008d737a90dacc53b3213c67778a", route: "packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.page.leaseOnly" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId:0cc48a35900f8a2d906a6e56c185315b", route: "packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId:56e970c86bbf4db803eaeceea83d747c", route: "packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/forwarding-intent.ts#forwardingIntentIssue:16800eef7e7892d4fe4742af8daee7b5", route: "packages/daemon/src/fleet/forwarding-intent.ts#forwardingIntentIssue" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/node-retirement.ts#createNodeRetirement.inspect:336cc07944400915dc63d9b9c760cb7a", route: "packages/daemon/src/fleet/node-retirement.ts#createNodeRetirement.inspect" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/peer.ts#REPLICATION_IDLE_TIMEOUT_MS:26600deb72b8b4c4532b38bd1ba5e5b9", route: "packages/daemon/src/fleet/peer.ts#REPLICATION_IDLE_TIMEOUT_MS" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/peer.ts#peerFor.transfers.onTimeout.retryable:88f471d203aaf3435eafc42f1e4997ce", route: "packages/daemon/src/fleet/peer.ts#peerFor.transfers.onTimeout.retryable" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/replica-generation.ts#createGenerationReaders.acquire.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/replica-generation.ts#createGenerationReaders.acquire.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/resource-budget.ts#DOC_SHOW_BUDGET_LIMITS:9670e0c007b2759d19baf6772ecd74ad", route: "packages/daemon/src/fleet/resource-budget.ts#DOC_SHOW_BUDGET_LIMITS" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/resource-budget.ts#createResourceBudget.reserve.released:c634ea4f4d8960a8ac39fbdbce66e15c", route: "packages/daemon/src/fleet/resource-budget.ts#createResourceBudget.reserve.released" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/transport-contract.ts#contentTransportContract.quotaOwner:ae6e90c390260356498a1fcd986bd840", route: "packages/daemon/src/fleet/transport-contract.ts#contentTransportContract.quotaOwner" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/transport-contract.ts#failurePolicies.quota_exceeded:65e0e64c9d972311d77e93b0fd82ae46", route: "packages/daemon/src/fleet/transport-contract.ts#failurePolicies.quota_exceeded" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/fleet/transport-contract.ts#failurePolicies.content_claim_mismatch:99b079cb25cc857c92c6b9a3f00859ff", route: "packages/daemon/src/fleet/transport-contract.ts#failurePolicies.content_claim_mismatch" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.errors.nodeAutoClaim:70cfc10d6603af9cf12e5446b9195ade", route: "packages/daemon/src/gui-s3-control.ts#validateSystemStatus.errors.nodeAutoClaim" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.maxConcurrent:8ac1df28cecd20076ac1df48da992d67", route: "packages/daemon/src/gui-s3-control.ts#validateSystemStatus.maxConcurrent" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.allowedAgentIds:5710c973998faafa0fc53d3a1e33b1a9", route: "packages/daemon/src/gui-s3-control.ts#validateSystemStatus.allowedAgentIds" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/host-action-authorization.ts#evaluateFleetAction.policyRef:4f0492d69afdb92f14dac4ff97639d19", route: "packages/daemon/src/host-action-authorization.ts#evaluateFleetAction.policyRef" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/hosting-provider.ts#detectHostingProvider.timeout:f2101e6de6857fc1337be200d9d22bf4", route: "packages/daemon/src/hosting-provider.ts#detectHostingProvider.timeout" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/hosting-provider.ts#hasOriginRemote.timeout:f2101e6de6857fc1337be200d9d22bf4", route: "packages/daemon/src/hosting-provider.ts#hasOriginRemote.timeout" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/agent-entity-gui-contract.ts#squadDetailChecks:2992fb30fa14879ed9b3a56065fb291e", route: "packages/daemon/src/protocol/agent-entity-gui-contract.ts#squadDetailChecks" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-agent.ts#agentHistoryLimit:075abffb0f3c07df85b8fcc6df0b29c0", route: "packages/daemon/src/protocol/daemon-protocol-commands-agent.ts#agentHistoryLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-decision-lifecycle.ts#defineCenterForwardArbiterCommand.admission:9f01bc772226841415b8fc2e6c07478e", route: "packages/daemon/src/protocol/daemon-protocol-commands-decision-lifecycle.ts#defineCenterForwardArbiterCommand.admission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-event.ts#eventListLimit:c9a5b45e2d2bfedea0eec3db15110906", route: "packages/daemon/src/protocol/daemon-protocol-commands-event.ts#eventListLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-people.ts#peopleWriteTopology.admission:9f01bc772226841415b8fc2e6c07478e", route: "packages/daemon/src/protocol/daemon-protocol-commands-people.ts#peopleWriteTopology.admission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:2", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:3", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:4", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:5", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:2", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:3", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:6", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:7", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:8", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:4", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:9", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:10", route: "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand.admission:9f01bc772226841415b8fc2e6c07478e", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand.admission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand:c79f19d96686565b7a11211d4b7c6cbf", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:2", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.admission:d43014f50cf523fc92be2084ed1f127c", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.admission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:3", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b", route: "packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#settingsWriteTopology.admission:9f01bc772226841415b8fc2e6c07478e", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#settingsWriteTopology.admission" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonRepositoryReadMethods.params.payload.generatedAt:bab3b56fbceedb0102dd1b7203f77e7a", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonRepositoryReadMethods.params.payload.generatedAt" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.policy:5774ea82d1f8ba5e47cd3d1f88548297", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.policy" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.threshold:7feb991d966e75d119019ed879c47bec", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.threshold" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.quotaBytes:842ebae6741341893bdba402c5e5bb52", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.quotaBytes" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes:6ee226975efe9d400b66020a67b74729", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes:6ee226975efe9d400b66020a67b74729:2", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.timeoutMs:a01eacadb58ddacea39848a1288008cf", route: "packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.riskTier:9311e769015637044dbb5cfed85bf3bc", route: "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.riskTier" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.claims:144c85f3905ab00818e41bf657851398", route: "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.claims" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.timeoutMs:d02b1e232b41987e44ddd45121bbdb3a", route: "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.timeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:2", route: "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:3", route: "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:4", route: "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:5", route: "packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validateReckoningRead:f33a5cdd4f195ff160f9ba63da6b2cb8", route: "packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validateReckoningRead" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validatePolicyMetadataRead:e892d9c9b9f1cfa95daa0960e1bbd3ab", route: "packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validatePolicyMetadataRead" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateRuntimeSessionGroupsPayload:8a3faa70835380737c28d6e123ee56b9", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateRuntimeSessionGroupsPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateSquadRunListPayload:34a28521d5382e1856120133c9716dfd", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateSquadRunListPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateAgendaQueryPayload:9d497038a11c02c733bdb06047b3a178", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateAgendaQueryPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateTaskDispatchesPayload:2e7fec41ec0eb76b4ef0d96616a18cd8", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateTaskDispatchesPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload:cf88a413616e032301357bbe6ccba6f3", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload:47f9cc8191031de3fb5a53f1f9c92c09", route: "packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonUseCaseProjectionPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonUseCaseProjectionPayloadShape.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.leaseOnly:5973c87cd792d7f35cddf633aef8b8a4", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.leaseOnly" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonRelationQueryPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonRelationQueryPayloadShape.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonArtifactsListPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonArtifactsListPayloadShape.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonAgendaPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc", route: "packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonAgendaPayloadShape.limit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-task-completion.ts#validateDaemonTaskCompletion:53bfe398c2e676421c927aa703882ba2", route: "packages/daemon/src/protocol/daemon-protocol-task-completion.ts#validateDaemonTaskCompletion" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-validate-entities.ts#validateTaskClaimableResult:48e00cf5d8e0133ec4ff5b25db2e7302", route: "packages/daemon/src/protocol/daemon-protocol-validate-entities.ts#validateTaskClaimableResult" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-validate-results.ts#writeReceipt:c829de6b1cc9cc83ba7fc87034003f7b", route: "packages/daemon/src/protocol/daemon-protocol-validate-results.ts#writeReceipt" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/gui-result-validation.ts#validateTaskRuntimeContextRead:2e43f537ef1583d90d9cb5e7a2db6462", route: "packages/daemon/src/protocol/gui-result-validation.ts#validateTaskRuntimeContextRead" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/gui-result-validation.ts#validateDaemonTaskWip:e61e19aa284460df35e9b0bebc08d1d4", route: "packages/daemon/src/protocol/gui-result-validation.ts#validateDaemonTaskWip" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/json-rpc-types.ts#validationValueLimit:885a82ea197f869c903181ad7328ac0d", route: "packages/daemon/src/protocol/json-rpc-types.ts#validationValueLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/json-rpc-types.ts#validationStringLimit:72bb6221aa07e45cde007aa544e91160", route: "packages/daemon/src/protocol/json-rpc-types.ts#validationStringLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/json-rpc-types.ts#validationArrayLimit:106b9f088689f17714def31546ddaa90", route: "packages/daemon/src/protocol/json-rpc-types.ts#validationArrayLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/json-rpc-types.ts#validationDepthLimit:45cb7fe21a9fca8712d504d148128537", route: "packages/daemon/src/protocol/json-rpc-types.ts#validationDepthLimit" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/protocol/schedules-gui-contract.ts#validateSchedulesList:7062238218b82b4dcbe411b9e762f76e", route: "packages/daemon/src/protocol/schedules-gui-contract.ts#validateSchedulesList" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/remote-proxy.ts#connectTimeoutMs:8023c90431ade8f7d71727989b219dcc", route: "packages/daemon/src/remote-proxy.ts#connectTimeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/remote-proxy.ts#helloTimeoutMs:ec3f721f37fe0fe0bde449d675a75caf", route: "packages/daemon/src/remote-proxy.ts#helloTimeoutMs" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting:e9223ea1f35451c5a3e5a78e4b9e9b66", route: "packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting" },
          { candidateId: "policy:packages/daemon:packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting:44c9510588b412fe3102d073ff7c4f32", route: "packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting" },
        ],
      },
    ],
    schema: hostAggregateSchema,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    stateStores: hostStateStores,
    statusVocabulary: [{ field: "process", words: ["running", "stopped"] }],
    actionCatalog: noActionCatalog("kernel/host/v1", "Host process aggregate; lifecycle helpers own operational stores."),
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
  },
] as const satisfies readonly EntityKindContract[]));

/** Policy scopes for the shared base pin actions, including runtime-local entity kinds. */
export const baseEntityPolicyActions = Object.freeze(
  entityKindContracts.flatMap(({ kind }) => [`${kind}/pin`, `${kind}/unpin`]),
);

const entityKindContractByKind = new Map<string, EntityKindContract>(
  entityKindContracts.map((contract) => [contract.kind, contract]),
);
const executableActionsByIngress = new Map<string, EntityActionContract>(),
  taskActionsByTransition = new Map<string, EntityActionContract>();
for (const { actionCatalog, assignmentCapability, kind } of entityKindContracts as readonly EntityKindContract[]) {
  const assignmentActions = new Set(
    (actionCatalog?.actions ?? []).map(({ id }) => id).filter((id) => id === "assign" || id === "unassign"),
  );
  if (
    assignmentCapability === "supported" &&
    (assignmentActions.size !== 2 || !assignmentActions.has("assign") || !assignmentActions.has("unassign"))
  )
    throw new Error(`Entity kind ${kind} declares assignment capability without assign/unassign Actions.`);
  if (assignmentCapability === "none" && assignmentActions.size > 0)
    throw new Error(`Entity kind ${kind} exposes assignment Actions without assignment capability.`);
  for (const action of actionCatalog?.actions ?? []) {
    if (action.execution?.ingress !== undefined && !executableActionsByIngress.has(action.execution.ingress))
      executableActionsByIngress.set(action.execution?.ingress, action);
    if (kind === "task")
      for (const key of [action.id, `task.${action.id}`, action.execution?.lifecycle?.transitionId])
        if (key !== undefined && !taskActionsByTransition.has(key)) taskActionsByTransition.set(key, action);
  }
}
export function getEntityKindContract(kind: string): EntityKindContract | undefined {
  return entityKindContractByKind.get(kind);
}

export function isRelationEndpointKind(kind: string): kind is EntityKind {
  return getEntityKindContract(kind)?.relationEndpoint.eligible === true;
}

export function getExecutableEntityAction(ingress: string): EntityActionContract | undefined {
  return executableActionsByIngress.get(ingress);
}

export function getTaskActionForTransition(transitionId: string): EntityActionContract | undefined {
  return taskActionsByTransition.get(transitionId);
}

export function requireEntityKindContract(kind: string): EntityKindContract {
  const contract = getEntityKindContract(kind);
  if (!contract)
    throw Object.assign(new Error(`Entity kind ${kind} is not registered.`), { code: "entity_kind_not_found" });
  return contract;
}

export type EntityStoreKindContract = EntityKindContract & {
  readonly entityStore: NonNullable<EntityKindContract["entityStore"]>;
  readonly authoring: { readonly kind: "generic-entity-store"; readonly contractRef: string };
};

export function requireEntityStoreKindContract(kind: string): EntityStoreKindContract {
  const contract = requireEntityKindContract(kind);
  if (contract.entityStore === null || contract.authoring?.kind !== "generic-entity-store")
    throw Object.assign(new Error(`Entity kind ${kind} has no generic entity-store surface.`), {
      code: "entity_kind_has_dedicated_authoring",
    });
  return contract as EntityStoreKindContract;
}

export function explainEntityKind(kind: string): EntityKindExplanation {
  return explainEntityKindContract(requireEntityKindContract(kind));
}

/**
 * The one explanation projection. Built-in kinds reach it through `explainEntityKind`;
 * vertical artifact kinds are compiled outside this registry, so they hand their own
 * contract to the same function rather than growing a second explanation shape.
 */
export function explainEntityKindContract(contract: EntityKindContract): EntityKindExplanation {
  const actions =
    contract.actionCatalog?.actions.map(({ execution: _execution, ...action }) => Object.freeze(action)) ?? [];
  return {
    schema: "entity-kind-explanation/v1",
    kind: contract.kind,
    residency: contract.residency,
    documentSchema: { id: contract.schema.$id, fields: explainEntityJsonSchema(contract.schema) },
    id: contract.id,
    relations: contract.relations,
    canonicalProjection: contract.canonicalProjection,
    stateStores: contract.stateStores,
    statusVocabulary: contract.statusVocabulary ?? [],
    transitions: {
      catalogRef: contract.actionCatalog?.ref ?? null,
      available:
        contract.actionCatalog?.actions.filter(({ execution }) => execution !== null).map(({ id }) => id) ?? [],
      actions,
      reason: contract.actionCatalog?.reason ?? null,
    },
    authoring: contract.authoring,
    sdkExposure: contract.sdkExposure,
    framework: contract.framework ?? null,
    boundedContextExceptions,
  };
}

export function entityDocumentPath(contract: EntityStoreKindContract, id: string): string {
  if (!compiledPattern(contract.id.pattern).test(id))
    throw Object.assign(new Error(`${id} is not a valid ${contract.kind} id.`), { code: "invalid_entity_id" });
  return contract.entityStore.document.pathTemplate.replace("{id}", id);
}

/**
 * Where an entity's owned raw objects live. The entity's own declaration path, minus its extension, is the
 * root; the object keeps its shape underneath. Two entities therefore never contend for the same target no
 * matter what their sources were called.
 */
export function entityContentRoot(contract: EntityStoreKindContract, id: string): string {
  const document = entityDocumentPath(contract, id),
    extension = document.slice(document.lastIndexOf("/") + 1).lastIndexOf(".");
  return extension <= 0 ? document : document.slice(0, document.lastIndexOf("."));
}

export function entityContentPath(contract: EntityStoreKindContract, id: string, relativePath: string): string {
  return normalizeRelativeDocumentPath(`${entityContentRoot(contract, id)}/${relativePath}`);
}
