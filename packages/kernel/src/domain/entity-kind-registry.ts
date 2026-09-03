import { AGENT_DECLARATION_V1_SCHEMA, SQUAD_DECLARATION_V1_SCHEMA } from "./agent-squad-schema.ts";
import { createAgentActionCatalog } from "./agent-action-contract.ts";
import { runtimeSessionEntityV1Schema } from "./agent-runtime.ts";
import { decisionEventTypes, decisionStates } from "./decision-event-types.ts";
import {
  requireEntityTypeContract,
  type BaseEntity,
  type EntityKind,
  type EntityResidencyFacets,
  type EntityTypeContract,
} from "./base-entity.ts";
import { CONTRACT_VERSION_1_0, type ContractVersion } from "./contract-version.ts";
import { DEFAULT_POLICY } from "./default-policy.ts";
import { explainEntityJsonSchema, type EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { decisionSchema, executionSchema, factSchema, reviewSchema, taskSchema } from "./entity-document-schemas.ts";
import {
  compileDecisionReckonAction,
  compileFactRecordAction,
  compileFactReclassifyAction,
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
} from "./entity-relation.ts";
import { relationSchema } from "./entity-kind-relation-schema.ts";
import { executionStates } from "./execution.ts";
import { domainStatuses } from "./lifecycle-status.ts";
import { policyPredicateNames, POLICY_DECLARATION_V1_SCHEMA } from "./policy.ts";
import type { PolicyActionRule, PolicyPredicateName } from "./policy.ts";
import { canonicalRelationDirections } from "./relation-direction.ts";
import { reviewVerdicts } from "./review.ts";
import { SCHEDULE_V1_SCHEMA, scheduleEventTypes, scheduleRunOutcomes, scheduleStates } from "./schedule.ts";
import { SETTINGS_REPOSITORY_V1_SCHEMA } from "./settings.ts";
import { PERSON_V1_SCHEMA } from "./people-roster.ts";
import { createTaskActionCatalog } from "./task-action-contract.ts";
import { createScheduleActionCatalog } from "./schedule-action-contract.ts";
import { createRuntimeSessionActionCatalog } from "./runtime-session-action-contract.ts";
import { createSettingsActionCatalog } from "./settings-action-contract.ts";
import { createPersonActionCatalog } from "./person-action-contract.ts";
import { createSquadActionCatalog } from "./squad-action-contract.ts";
import type { ActionReturnsContract } from "./receipt-guidance.ts";
export const ENTITY_DOCUMENT_POLICY_ID = "typed-entity/v1";

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
export interface EmbeddedCanonicalEventDeclaration {
  readonly schema: string;
  readonly types: ReadonlyArray<string>;
  readonly payloadField: string;
}
export interface EntityCanonicalProjectionDeclaration {
  readonly embeddedEvents: ReadonlyArray<EmbeddedCanonicalEventDeclaration>;
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
      | "people-event"
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
  readonly policy?: {
    readonly predicates: readonly PolicyPredicateName[];
    readonly actions: readonly string[];
    readonly rules: readonly PolicyActionRule[];
  };
};

export interface EntitySdkExposure {
  readonly sdk: { readonly target: string; readonly schemaId: string } | null;
  readonly agentCapability: { readonly target: string; readonly schemaId: string } | null;
}

export interface EntityActionContract {
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
  readonly field: string;
  readonly type:
    | "string"
    | "number"
    | "boolean"
    | "string-array"
    | "fact-hold-array"
    | "json-object"
    | "json-object-array";
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly cli?: {
    readonly name: string;
    readonly kind: "single" | "repeated" | "boolean";
    readonly error: { readonly code: string };
    readonly jsonFields?: readonly string[];
    readonly jsonEnums?: Readonly<Record<string, readonly string[]>>;
    readonly conflictsWith?: readonly string[];
    readonly format?: string;
    readonly projection?: "number" | "fact-hold-array";
  };
}

export interface EntityActionInputContract {
  readonly schema: "entity-action-input/v1";
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
  readonly policy: {
    readonly predicates: readonly PolicyPredicateName[];
    readonly actions: readonly string[];
    readonly rules: readonly PolicyActionRule[];
  } | null;
  readonly boundedContextExceptions: readonly BoundedContextActionException[];
}

export interface BoundedContextActionException {
  readonly actions: readonly string[];
  readonly boundedContext: "preset-library" | "daemon-user-root" | "terminal-host";
  readonly residency: "runtime-local";
  readonly reason: string;
}

const declarationDocument = (pathTemplate: string) =>
  Object.freeze({ pathTemplate, mediaType: "application/json" as const, policyId: ENTITY_DOCUMENT_POLICY_ID });
export const noSdkExposure: EntitySdkExposure = Object.freeze({ sdk: null, agentCapability: null });
const capabilityExposure = (target: string, schemaId: string): EntitySdkExposure =>
  Object.freeze({
    sdk: Object.freeze({ target: `${target[0]!.toUpperCase()}${target.slice(1)}Capability`, schemaId }),
    agentCapability: Object.freeze({ target, schemaId }),
  });
const entityAction = (
  kind: string,
  identity: EntityKindContract["id"],
  id: string,
  sdkExposure: EntitySdkExposure = noSdkExposure,
  execution: EntityActionExecutionContract | null = null,
): EntityActionContract =>
  Object.freeze({
    id,
    version: CONTRACT_VERSION_1_0,
    actor: Object.freeze({ source: "authenticated-binding" as const, authorityRef: "actor-identity/v1" }),
    target: Object.freeze({ kind, refTemplate: identity.refTemplate }),
    input: emptyActionInput,
    policy: Object.freeze({ ref: "default@5", action: null }),
    criteria: Object.freeze([]),
    concurrency: defaultConcurrency(kind, identity.refTemplate),
    effects: Object.freeze([]),
    returns: actionResultContract,
    explain: `${kind}.${id} is declared but has no executable implementation.`,
    sdkExposure,
    execution,
  });
const noActionCatalog = (ref: string, reason: string) => Object.freeze({ ref, actions: Object.freeze([]), reason });

const executionContract = (
  ingress: string,
  compile: EntityActionCompileHook | null,
  read: boolean,
): EntityActionExecutionContract =>
  Object.freeze({ ingress, compile, read, implementation: compile || read ? "compiled-event" : "declared-only" });
const emptyActionInput: EntityActionInputContract = Object.freeze({
  schema: "entity-action-input/v1",
  fields: Object.freeze([]),
  exactlyOneOf: Object.freeze([]),
});
const actionResultContract = Object.freeze({
  schema: "action-result/v1" as const,
  fields: Object.freeze([
    "outcome",
    "opId",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextAction",
    "nextActions",
    "guidance",
  ]),
  guidance: Object.freeze([]),
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

export const artifactEntityImportActionInput = Object.freeze({
  schema: "entity-action-input/v1" as const,
  fields: Object.freeze([
    { field: "entityKind", type: "string" as const, required: true },
    { field: "locator", type: "string" as const, required: true },
    { field: "expectedVersion", type: "number" as const, required: true },
    { field: "title", type: "string" as const, required: false },
    { field: "entityId", type: "string" as const, required: false },
    { field: "sourceIdentity", type: "string" as const, required: false },
    { field: "idempotencyKey", type: "string" as const, required: false },
    { field: "dryRun", type: "boolean" as const, required: false },
  ]),
  exactlyOneOf: Object.freeze([]),
} as const satisfies EntityActionInputContract);

export function artifactEntityActionCatalog(
  kind: string,
  identity: EntityKindContract["id"],
): NonNullable<EntityKindContract["actionCatalog"]> {
  const declared = entityAction(
    kind,
    identity,
    "import",
    noSdkExposure,
    Object.freeze({
      ingress: "entity-import",
      compile: null,
      read: false,
      implementation: "catalog-runtime" as const,
      topology: "center-forward-write" as const,
      targetIdField: "entityId",
    }),
  );
  return Object.freeze({
    ref: "kernel/entity-event/v1",
    actions: Object.freeze([
      Object.freeze({
        ...declared,
        input: artifactEntityImportActionInput,
        criteria: Object.freeze([
          Object.freeze({
            ref: "entity/aggregate-revision",
            failureCode: "revision_conflict",
            explain: "The expected Entity revision must equal the latest canonical observation revision.",
          }),
          Object.freeze({
            ref: "entity/source-resolution",
            failureCode: "source_resolution_failed",
            explain:
              "The declared resolver must return either authoritative content or an authoritative missing result.",
          }),
        ]),
        concurrency: Object.freeze({
          expectedVersion: Object.freeze({ authority: "entity-aggregate-revision", required: true }),
          leasePolicy: Object.freeze({ authority: "center-repo-cell-single-writer" }),
          occurrenceClaim: Object.freeze({ authority: "entity-observation-id" }),
          idempotency: Object.freeze({ authority: "entity-source-resolution-operation-id" }),
          artifactOwnership: Object.freeze({
            owner: "entity-revision",
            refTemplate: "entity/{entityId}/revision/{revision}",
          }),
        }),
        effects: Object.freeze([
          Object.freeze({ ref: "entity-event/entity_content_observed", projection: "entity/v1" }),
          Object.freeze({ ref: "entity-event/entity_target_missing", projection: "entity/v1" }),
        ]),
        explain:
          `${kind}.import resolves one artifact source and appends entity-event/v1 under the ` +
          "entity aggregate revision fence; dry-run performs no write.",
      }),
    ]),
  });
}

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
  };
};
const taskIdentity = requireEntityTypeContract("task").id;
const factIdentity = requireEntityTypeContract("fact").id;
const decisionIdentity = requireEntityTypeContract("decision").id;
const agentIdentity = requireEntityTypeContract("agent").id;
const executionIdentity = requireEntityTypeContract("execution").id;
const reviewIdentity = requireEntityTypeContract("review").id;
const runtimeSessionIdentity = requireEntityTypeContract("runtime-session").id;
const scheduleIdentity = requireEntityTypeContract("schedule").id;
const settingsIdentity = requireEntityTypeContract("settings").id;
const personIdentity = requireEntityTypeContract("person").id;
const relationIdentity = requireEntityTypeContract("relation").id;
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
    unsupported("D2", "archive", "fact follows its owner task archive and is not archived singly"),
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

const taskActionCatalog = createTaskActionCatalog(
  (id) => entityAction("task", taskIdentity, id, taskExposure),
  actionResultContract,
);

const scheduleActionCatalog = createScheduleActionCatalog(
  (id) => entityAction("schedule", scheduleIdentity, id),
  actionResultContract,
);

const agentActionCatalog = createAgentActionCatalog(
  (id) => entityAction("agent", agentIdentity, id),
  actionResultContract,
);

const runtimeSessionActionCatalog = createRuntimeSessionActionCatalog(
  (id) => entityAction("runtime-session", runtimeSessionIdentity, id),
  actionResultContract,
);

const settingsActionCatalog = createSettingsActionCatalog(
  (id) => entityAction("settings", settingsIdentity, id),
  actionResultContract,
);

const personActionCatalog = createPersonActionCatalog(
  (id) => entityAction("person", personIdentity, id),
  actionResultContract,
);

const squadActionCatalog = createSquadActionCatalog(
  (id) => entityAction("squad", requireEntityTypeContract("squad").id, id),
  actionResultContract,
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
    executableAction("fact", factIdentity, "search", "fact-search", null, factExposure, true),
    executableAction("fact", factIdentity, "type-list", "fact-type-list", null, factExposure, true),
    executableAction("fact", factIdentity, "show", "fact-show", null, factExposure, true),
  ]),
});

const decisionWriteAction = (id: Parameters<typeof decisionActionCompiler>[0], ingress: string) =>
  executableAction("decision", decisionIdentity, id, ingress, decisionActionCompiler(id), decisionExposure);

const decisionActionByEvent = {
  decision_proposed: ["propose", "decision-propose"],
  decision_accepted: ["accept", "decision-accept"],
  decision_rejected: ["reject", "decision-reject"],
  decision_deferred: ["defer", "decision-defer"],
  decision_superseded: ["supersede", "decision-supersede"],
  decision_retired: ["retire", "decision-retire"],
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
    ...Object.values(decisionActionByEvent).map(([id, ingress]) => {
      return decisionWriteAction(id, ingress);
    }),
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
      {
        ref: "relation/acyclic-dependency",
        failureCode: "relation_cycle",
        explain: "A depends-on Relation must not introduce a cycle in the canonical Relation projection.",
      },
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

export const entityKindContracts = Object.freeze([
  {
    kind: "task",
    ...entityTypeContractFields("task"),
    schema: taskSchema,
    relations: relationsFor("task"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "lifecycle.status", words: domainStatuses }],
    actionCatalog: taskActionCatalog,
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: taskExposure,
    framework: taskFramework,
  },
  {
    kind: "fact",
    ...entityTypeContractFields("fact"),
    schema: factSchema,
    relations: relationsFor("fact"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "state", words: ["standing", "superseded_fact"] }],
    actionCatalog: factActionCatalog,
    entityStore: null,
    authoring: { kind: "fact-event", contractRef: "fact-event/v1" },
    sdkExposure: factExposure,
    framework: factFramework,
  },
  {
    kind: "decision",
    ...entityTypeContractFields("decision"),
    schema: decisionSchema,
    relations: relationsFor("decision"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "state", words: decisionStates }],
    actionCatalog: decisionActionCatalog,
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
      embeddedEvents: [],
      row: { idField: "id", ownerField: null },
    },
    statusVocabulary: [{ field: "state", words: relationStates }],
    actionCatalog: relationActionCatalog,
    entityStore: null,
    authoring: { kind: "relation-event", contractRef: "relation-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "agent",
    ...entityTypeContractFields("agent"),
    schema: AGENT_DECLARATION_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: { embeddedEvents: [], row: { idField: "id", ownerField: null } },
    actionCatalog: agentActionCatalog,
    entityStore: genericEntityStore("agents/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "squad",
    ...entityTypeContractFields("squad"),
    schema: SQUAD_DECLARATION_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: { embeddedEvents: [], row: { idField: "id", ownerField: null } },
    actionCatalog: squadActionCatalog,
    entityStore: genericEntityStore("squads/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "policy",
    ...entityTypeContractFields("policy"),
    schema: POLICY_DECLARATION_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    actionCatalog: noActionCatalog(
      "kernel/policy/v1",
      "Declaration entity; no independent write path (decision/dec_6FCDFB67623333335987D2542E/CH1).",
    ),
    entityStore: null,
    authoring: null,
    sdkExposure: noSdkExposure,
    policy: {
      predicates: policyPredicateNames,
      actions: DEFAULT_POLICY.actions,
      rules: DEFAULT_POLICY.rules ?? [],
    },
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
      embeddedEvents: [
        {
          schema: "task-event/v1",
          types: [
            "execution_started",
            "lease_renewed",
            "execution_submitted",
            "execution_executor_declared",
            "review_recorded",
            "review_consent_recorded",
            "code_doc_reconciled",
            "code_doc_repointed",
            "completion_gate_verified",
            "task_completed",
            "lease_released",
          ],
          payloadField: "execution",
        },
      ],
      row: { idField: "executionId", ownerField: "taskId" },
    },
    statusVocabulary: [{ field: "state", words: executionStates }],
    actionCatalog: noActionCatalog(
      "kernel/task-lifecycle/v1",
      "Task lifecycle projection; no independent actions (decision/dec_A6B0EF213AE9643FD84EC5F197/CH1).",
    ),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: noSdkExposure,
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
      embeddedEvents: [
        {
          schema: "task-event/v1",
          types: ["review_recorded", "review_consent_recorded"],
          payloadField: "review",
        },
      ],
      row: { idField: "reviewId", ownerField: "taskId" },
    },
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
      embeddedEvents: [],
      row: { idField: "runtimeSessionId", ownerField: null },
    },
    statusVocabulary: [
      { field: "liveness", words: ["live", "stale", "unknown", "exited"] },
      { field: "outcome", words: ["succeeded", "failed", "unknown", "cancelled"] },
      {
        field: "semanticState",
        words: ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
      },
    ],
    actionCatalog: runtimeSessionActionCatalog,
    entityStore: null,
    authoring: { kind: "agent-runtime-event", contractRef: "agent-runtime-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "schedule",
    ...entityTypeContractFields("schedule"),
    schema: SCHEDULE_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: {
      embeddedEvents: [
        {
          schema: "schedule-event/v1",
          types: scheduleEventTypes,
          payloadField: "schedule",
        },
      ],
      row: { idField: "scheduleId", ownerField: null },
    },
    statusVocabulary: [
      { field: "state", words: scheduleStates },
      { field: "status.lastRun.outcome", words: scheduleRunOutcomes },
    ],
    actionCatalog: scheduleActionCatalog,
    entityStore: null,
    authoring: { kind: "schedule-event", contractRef: "schedule-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "settings",
    ...entityTypeContractFields("settings"),
    schema: SETTINGS_REPOSITORY_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: {
      embeddedEvents: [{ schema: "settings-event/v1", types: ["settings_changed"], payloadField: "settings" }],
      row: { idField: "settingsId", ownerField: null },
    },
    actionCatalog: settingsActionCatalog,
    entityStore: null,
    authoring: { kind: "settings-event", contractRef: "settings-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "person",
    ...entityTypeContractFields("person"),
    schema: PERSON_V1_SCHEMA,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    actionCatalog: personActionCatalog,
    entityStore: null,
    authoring: { kind: "people-event", contractRef: "people-event/v1" },
    sdkExposure: noSdkExposure,
  },
] as const satisfies readonly EntityKindContract[]);

const entityKindContractByKind = new Map<string, EntityKindContract>(
  entityKindContracts.map((contract) => [contract.kind, contract]),
);

export const boundedContextExceptions: readonly BoundedContextActionException[] = Object.freeze([
  Object.freeze({
    actions: Object.freeze(["settings-update"]),
    boundedContext: "daemon-user-root" as const,
    residency: "runtime-local" as const,
    reason: "The locale field is a daemon-local preference and never appears in settings-event/v1.",
  }),
  Object.freeze({
    actions: Object.freeze(["preset-install", "preset-seed", "preset-uninstall"]),
    boundedContext: "preset-library" as const,
    residency: "runtime-local" as const,
    reason: "Preset library installation mutates the selected workspace library and has no canonical repository event.",
  }),
  Object.freeze({
    actions: Object.freeze([
      "daemon.runtimeInstance.create",
      "daemon.runtimeInstance.list",
      "daemon.runtimeInstance.show",
      "daemon.runtimeInstance.update",
      "daemon.runtimeInstance.delete",
    ]),
    boundedContext: "daemon-user-root" as const,
    residency: "runtime-local" as const,
    reason: "Runtime instance configuration belongs to the daemon user's host registry, outside a RepoCell ledger.",
  }),
  Object.freeze({
    actions: Object.freeze([
      "repo.terminal.spawn",
      "repo.terminal.input",
      "repo.terminal.resize",
      "repo.terminal.detach",
      "repo.terminal.terminate",
      "repo.terminal.attach",
    ]),
    boundedContext: "terminal-host" as const,
    residency: "runtime-local" as const,
    reason: "Terminal process state is ephemeral host state and never claims canonical repository settlement.",
  }),
]);

export function getEntityKindContract(kind: string): EntityKindContract | undefined {
  return entityKindContractByKind.get(kind);
}

export function isEntityKind(kind: string): kind is EntityKind {
  return entityKindContractByKind.has(kind);
}

export function isRelationEndpointKind(kind: string): kind is EntityKind {
  return getEntityKindContract(kind)?.relationEndpoint.eligible === true;
}

export function getExecutableEntityAction(ingress: string): EntityActionContract | undefined {
  for (const contract of entityKindContracts) {
    const action = contract.actionCatalog?.actions.find((candidate) => candidate.execution?.ingress === ingress);
    if (action) return action;
  }
  return undefined;
}

export function getTaskActionForTransition(transitionId: string): EntityActionContract | undefined {
  return getEntityKindContract("task")?.actionCatalog?.actions.find(
    (action) => action.execution?.lifecycle?.transitionId === transitionId,
  );
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
  const contract = requireEntityKindContract(kind);
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
    policy: contract.policy ?? null,
    boundedContextExceptions,
  };
}

export function entityDocumentPath(contract: EntityStoreKindContract, id: string): string {
  if (!new RegExp(contract.id.pattern, "u").test(id))
    throw Object.assign(new Error(`${id} is not a valid ${contract.kind} id.`), { code: "invalid_entity_id" });
  return contract.entityStore.document.pathTemplate.replace("{id}", id);
}
