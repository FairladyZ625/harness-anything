import type { VerticalDefinition } from "../schemas/registry.ts";
import taskFrontmatterJsonSchema from "../../schemas/json/task-frontmatter.schema.json" with { type: "json" };
import decisionPackageJsonSchema from "../../schemas/json/decision-package.schema.json" with { type: "json" };
import factEventJsonSchema from "../../schemas/json/fact-event.schema.json" with { type: "json" };
import { AGENT_DECLARATION_V1_SCHEMA, agentStates, SQUAD_DECLARATION_V1_SCHEMA } from "./agent-squad-schema.ts";
import { agentRuntimeEventTypes, runtimeSessionEntityV1Schema } from "./agent-runtime.ts";
import { decisionEventTypes, decisionStates, policyStates } from "./decision-event-types.ts";
import { CONTRACT_VERSION_1_0, type ContractVersion } from "./contract-version.ts";
import { DEFAULT_POLICY } from "./default-policy.ts";
import {
  explainEntityJsonSchema,
  type EntityDocumentJsonSchema,
  type EntityJsonObjectSchema,
  type EntityJsonSchemaNode,
} from "./entity-json-schema.ts";
import { deriveEntityKindIdentity } from "./entity-ref.ts";
import type { RelationDirection, RelationType } from "./entity-relation.ts";
import { executionStates } from "./execution.ts";
import { domainStatuses } from "./lifecycle-status.ts";
import { policyPredicateNames, POLICY_DECLARATION_V1_SCHEMA } from "./policy.ts";
import type { PolicyActionRule, PolicyPredicateName } from "./policy.ts";
import { canonicalRelationDirections } from "./relation-direction.ts";
import { reviewVerdicts } from "./review.ts";
import { TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";
import {
  dispositionMatrix,
  supported,
  unsupported,
  type EntityAnchorDeclaration,
  type EntityCanonicalProjectionDeclaration,
  type EntityDispositionMatrix,
  type EntityRelationProjectionDeclaration,
  type EntityStorageForm,
} from "../entity/registry-contract.ts";

export type EntityKindDeclaration = VerticalDefinition["entityKinds"][number];
export type EntityPackageScaffold = VerticalDefinition["packageScaffolds"][number];
export const ENTITY_DOCUMENT_POLICY_ID = "typed-entity/v1";
export type EntityRepositoryRootScaffold = VerticalDefinition["repositoryScaffold"]["entityRoots"][number];

export interface EntityKindRegistration {
  readonly id: string;
  readonly entityType: EntityKindDeclaration["entityType"];
  readonly contractEntity: boolean;
  readonly packageKind?: string;
  readonly schemaRef?: string;
  readonly packageScaffold?: EntityPackageScaffold;
  readonly repositoryRoot?: EntityRepositoryRootScaffold;
}

export interface EntityKindRegistry {
  readonly ids: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<EntityKindRegistration>;
  readonly byId: ReadonlyMap<string, EntityKindRegistration>;
}

export interface EntityKindContract<T = unknown> {
  readonly kind: string;
  readonly schema: EntityDocumentJsonSchema<T>;
  readonly id: {
    readonly field: string;
    readonly pattern: string;
    readonly refTemplate: string;
  };
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
    readonly kind: "generic-entity-store" | "task-lifecycle" | "fact-event" | "decision-event" | "agent-runtime-event";
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
}

export interface EntitySdkExposure {
  readonly sdk: { readonly target: string; readonly schemaId: string } | null;
  readonly agentCapability: { readonly target: string; readonly schemaId: string } | null;
}

export interface EntityActionContract {
  readonly id: string;
  readonly version: ContractVersion;
  readonly target: {
    readonly kind: string;
    readonly refTemplate: string;
  };
  readonly sdkExposure: EntitySdkExposure;
}

export interface EntityKindExplanation {
  readonly schema: "entity-kind-explanation/v1";
  readonly kind: string;
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
    readonly actions: readonly EntityActionContract[];
  };
  readonly authoring: EntityKindContract["authoring"];
  readonly sdkExposure: EntitySdkExposure;
  readonly framework: EntityKindContract["framework"] | null;
  readonly policy: {
    readonly predicates: readonly PolicyPredicateName[];
    readonly actions: readonly string[];
    readonly rules: readonly PolicyActionRule[];
  } | null;
}

const declarationDocument = (pathTemplate: string) =>
  Object.freeze({ pathTemplate, mediaType: "application/json" as const, policyId: ENTITY_DOCUMENT_POLICY_ID });
const noSdkExposure: EntitySdkExposure = Object.freeze({ sdk: null, agentCapability: null });
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
): EntityActionContract =>
  Object.freeze({
    id,
    version: CONTRACT_VERSION_1_0,
    target: Object.freeze({ kind, refTemplate: identity.refTemplate }),
    sdkExposure,
  });
const actionCatalog = (
  ref: string,
  kind: string,
  identity: EntityKindContract["id"],
  ids: readonly string[],
  sdkExposure: EntitySdkExposure = noSdkExposure,
) => Object.freeze({ ref, actions: Object.freeze(ids.map((id) => entityAction(kind, identity, id, sdkExposure))) });
const genericAuthoring = Object.freeze({ kind: "generic-entity-store" as const, contractRef: "entity-event/v1" });
const genericEntityStore = (pathTemplate: string, validate?: (value: unknown) => readonly string[]) =>
  Object.freeze({ document: declarationDocument(pathTemplate), ...(validate ? { validate } : {}) });

const taskExposure = capabilityExposure("task", "task-frontmatter");
const factExposure = capabilityExposure("fact", "fact-event");
const decisionExposure = capabilityExposure("decision", "decision-package");

const taskIdentity = deriveEntityKindIdentity("task");
const factIdentity = deriveEntityKindIdentity("fact");
const decisionIdentity = deriveEntityKindIdentity("decision");
const agentIdentity = deriveEntityKindIdentity("agent");
const squadIdentity = deriveEntityKindIdentity("squad");
const policyIdentity = deriveEntityKindIdentity("policy");
const executionIdentity = deriveEntityKindIdentity("execution");
const reviewIdentity = deriveEntityKindIdentity("review");
const runtimeSessionIdentity = deriveEntityKindIdentity("runtime-session");
const executionIdPattern = executionIdentity.pattern;
const reviewIdPattern = reviewIdentity.pattern;
const lifecycleTaskIdPattern = taskIdentity.pattern;
const opaqueObject = (): EntityJsonObjectSchema => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
});
const nullableOpaqueObject = (): EntityJsonSchemaNode => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
  "x-nullable": true,
});

function explainableSchema(
  id: string,
  source: Readonly<{ required?: readonly string[]; properties?: Readonly<Record<string, unknown>> }>,
): EntityDocumentJsonSchema {
  const properties = Object.fromEntries(
    Object.entries(source.properties ?? {}).map(([name, node]) => [name, explainableNode(node)]),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    properties,
    required: source.required ?? [],
    additionalProperties: false,
  };
}

function explainableNode(value: unknown): EntityJsonSchemaNode {
  const node = typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
  const description = typeof node.description === "string" ? node.description : undefined;
  const inferred =
    typeof node.type === "string"
      ? node.type
      : typeof node.const === "string"
        ? "string"
        : typeof node.const === "number"
          ? "number"
          : typeof node.const === "boolean"
            ? "boolean"
            : "object";
  if (inferred === "string") return { type: "string", ...(description ? { description } : {}) };
  if (inferred === "number" || inferred === "integer" || inferred === "boolean" || inferred === "null")
    return { type: inferred, ...(description ? { description } : {}) };
  if (inferred === "array") return { type: "array", items: opaqueObject(), ...(description ? { description } : {}) };
  return { ...opaqueObject(), ...(description ? { description } : {}) };
}

const taskSchema = explainableSchema("task-frontmatter", taskFrontmatterJsonSchema);
const factSchema = explainableSchema("fact-event", factEventJsonSchema);
const decisionSchema = explainableSchema("decision-package", decisionPackageJsonSchema);

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
  anchors: { entityRef: "fact/{task_id}/{fact_id}", anchors: [] },
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
const executionSchema: EntityDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Execution/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "execution/v1" },
    executionId: { type: "string", pattern: executionIdPattern, minLength: 1 },
    taskId: { type: "string", pattern: lifecycleTaskIdPattern, minLength: 1 },
    nodeId: { type: "string", const: "implementation" },
    iteration: { type: "integer" },
    state: { type: "string", enum: ["active", "submitted", "accepted", "changes_requested", "abandoned"] },
    actor: opaqueObject(),
    claimedAt: { type: "string", minLength: 1 },
    submittedAt: { type: "string", minLength: 1, "x-nullable": true },
    closedAt: { type: "string", minLength: 1, "x-nullable": true },
    submission: nullableOpaqueObject(),
  },
  required: [
    "schema",
    "executionId",
    "taskId",
    "nodeId",
    "iteration",
    "state",
    "actor",
    "claimedAt",
    "submittedAt",
    "closedAt",
    "submission",
  ],
  additionalProperties: false,
};
const reviewSchema: EntityDocumentJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Review/v1",
  type: "object",
  properties: {
    schema: { type: "string", const: "review/v1" },
    reviewId: { type: "string", pattern: reviewIdPattern, minLength: 1 },
    taskId: { type: "string", pattern: lifecycleTaskIdPattern, minLength: 1 },
    executionId: { type: "string", pattern: executionIdPattern, minLength: 1 },
    verdict: { type: "string", enum: ["approved", "changes_requested", "dismissed"] },
    actor: opaqueObject(),
    capabilityRef: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    evidenceChecked: { type: "array", items: { type: "string", minLength: 1 } },
    commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    iteration: { type: "integer" },
    contentDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    reviewedAt: { type: "string", minLength: 1 },
  },
  required: [
    "schema",
    "reviewId",
    "taskId",
    "executionId",
    "verdict",
    "actor",
    "capabilityRef",
    "reason",
    "evidenceChecked",
    "commitSha",
    "iteration",
    "contentDigest",
    "reviewedAt",
  ],
  additionalProperties: false,
};

const relationsFor = (kind: string): EntityKindContract["relations"] => {
  const edges = canonicalRelationDirections
    .filter((entry) => entry.sourceKind === kind)
    .map(({ type, sourceKind, targetKind }) => ({ type, sourceKind, targetKind }));
  return Object.freeze({ directions: edges.length ? (["directed"] as const) : [], edges: Object.freeze(edges) });
};

const decisionActionByEvent = {
  decision_proposed: "propose",
  decision_accepted: "accept",
  decision_rejected: "reject",
  decision_deferred: "defer",
  decision_superseded: "supersede",
  decision_retired: "retire",
  decision_amended: "amend",
  decision_repinned: "repin",
  decision_claim_declared: "declare-claim",
  decision_claim_fulfillment_declared: "fulfill-claim",
  decision_related: "relate",
  decision_relation_retired: "retire-relation",
  decision_relation_replaced: "replace-relation",
} as const satisfies Record<(typeof decisionEventTypes)[number], string>;
const decisionActionIds = decisionEventTypes.map((type) => decisionActionByEvent[type]);

export const entityKindContracts = Object.freeze([
  {
    kind: "task",
    schema: taskSchema,
    id: taskIdentity,
    relations: relationsFor("task"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "lifecycle.status", words: domainStatuses }],
    actionCatalog: actionCatalog(
      "kernel/task-lifecycle/v1",
      "task",
      taskIdentity,
      TASK_LIFECYCLE_TRANSITIONS.map(({ id }) => id),
      taskExposure,
    ),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: taskExposure,
    framework: taskFramework,
  },
  {
    kind: "fact",
    schema: factSchema,
    id: factIdentity,
    relations: relationsFor("fact"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "state", words: ["standing", "superseded_fact"] }],
    actionCatalog: actionCatalog("kernel/fact-event/v1", "fact", factIdentity, ["record"], factExposure),
    entityStore: null,
    authoring: { kind: "fact-event", contractRef: "fact-event/v1" },
    sdkExposure: factExposure,
    framework: factFramework,
  },
  {
    kind: "decision",
    schema: decisionSchema,
    id: decisionIdentity,
    relations: relationsFor("decision"),
    canonicalProjection: null,
    statusVocabulary: [{ field: "state", words: decisionStates }],
    actionCatalog: actionCatalog(
      "kernel/decision-event/v1",
      "decision",
      decisionIdentity,
      decisionActionIds,
      decisionExposure,
    ),
    entityStore: null,
    authoring: { kind: "decision-event", contractRef: "decision-event/v1" },
    sdkExposure: decisionExposure,
    framework: decisionFramework,
  },
  {
    kind: "agent",
    schema: AGENT_DECLARATION_V1_SCHEMA,
    id: agentIdentity,
    relations: { directions: [], edges: [] },
    canonicalProjection: { embeddedEvents: [], row: { idField: "id", ownerField: null } },
    statusVocabulary: [{ field: "state", words: agentStates }],
    actionCatalog: actionCatalog("kernel/agent-declaration/v1", "agent", agentIdentity, [
      "configure",
      "activate",
      "retire",
    ]),
    entityStore: genericEntityStore("agents/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "squad",
    schema: SQUAD_DECLARATION_V1_SCHEMA,
    id: squadIdentity,
    relations: { directions: [], edges: [] },
    canonicalProjection: { embeddedEvents: [], row: { idField: "id", ownerField: null } },
    actionCatalog: null,
    entityStore: genericEntityStore("squads/{id}.json"),
    authoring: genericAuthoring,
    sdkExposure: noSdkExposure,
  },
  {
    kind: "policy",
    schema: POLICY_DECLARATION_V1_SCHEMA,
    id: policyIdentity,
    relations: { directions: [], edges: [] },
    canonicalProjection: null,
    statusVocabulary: [{ field: "state", words: policyStates }],
    actionCatalog: actionCatalog("kernel/policy/v1", "policy", policyIdentity, ["draft", "activate", "retire"]),
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
    schema: executionSchema,
    id: executionIdentity,
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
    actionCatalog: actionCatalog("kernel/task-lifecycle/v1", "execution", executionIdentity, [
      "start",
      "renew",
      "submit",
      "complete",
      "release",
    ]),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "review",
    schema: reviewSchema,
    id: reviewIdentity,
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
    actionCatalog: actionCatalog("kernel/task-lifecycle/v1", "review", reviewIdentity, ["record"]),
    entityStore: null,
    authoring: { kind: "task-lifecycle", contractRef: "task-event/v1" },
    sdkExposure: noSdkExposure,
  },
  {
    kind: "runtime-session",
    schema: runtimeSessionEntityV1Schema,
    id: runtimeSessionIdentity,
    relations: {
      directions: ["directed"],
      edges: [{ type: "executes", sourceKind: "runtime-session", targetKind: "task" }],
    },
    canonicalProjection: null,
    statusVocabulary: [
      { field: "liveness", words: ["live", "stale", "unknown", "exited"] },
      { field: "outcome", words: ["succeeded", "failed", "unknown", "cancelled"] },
      {
        field: "semanticState",
        words: ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
      },
    ],
    actionCatalog: actionCatalog(
      "kernel/agent-runtime-event/v1",
      "runtime-session",
      runtimeSessionIdentity,
      agentRuntimeEventTypes.filter((type) => type.startsWith("runtime_session_")),
    ),
    entityStore: null,
    authoring: { kind: "agent-runtime-event", contractRef: "agent-runtime-event/v1" },
    sdkExposure: noSdkExposure,
  },
] as const satisfies readonly EntityKindContract[]);

const entityKindContractByKind = new Map<string, EntityKindContract>(
  entityKindContracts.map((contract) => [contract.kind, contract]),
);

export function getEntityKindContract(kind: string): EntityKindContract | undefined {
  return entityKindContractByKind.get(kind);
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
  return {
    schema: "entity-kind-explanation/v1",
    kind: contract.kind,
    documentSchema: { id: contract.schema.$id, fields: explainEntityJsonSchema(contract.schema) },
    id: contract.id,
    relations: contract.relations,
    canonicalProjection: contract.canonicalProjection,
    statusVocabulary: contract.statusVocabulary ?? [],
    transitions: {
      catalogRef: contract.actionCatalog?.ref ?? null,
      available: contract.actionCatalog?.actions.map(({ id }) => id) ?? [],
      actions: contract.actionCatalog?.actions ?? [],
    },
    authoring: contract.authoring,
    sdkExposure: contract.sdkExposure,
    framework: contract.framework ?? null,
    policy: contract.policy ?? null,
  };
}

export function entityDocumentPath(contract: EntityStoreKindContract, id: string): string {
  if (!new RegExp(contract.id.pattern, "u").test(id))
    throw Object.assign(new Error(`${id} is not a valid ${contract.kind} id.`), { code: "invalid_entity_id" });
  return contract.entityStore.document.pathTemplate.replace("{id}", id);
}

export function createEntityKindRegistry(vertical: VerticalDefinition): EntityKindRegistry {
  const packageScaffolds = new Map(vertical.packageScaffolds.map((scaffold) => [scaffold.entityKind, scaffold]));
  const repositoryRoots = new Map(vertical.repositoryScaffold.entityRoots.map((root) => [root.entityKind, root]));
  const entries = vertical.entityKinds.map(
    (entity): EntityKindRegistration => ({
      id: entity.id,
      entityType: entity.entityType,
      contractEntity: entity.contractEntity,
      ...(entity.entityType === "lifecycle" ? { packageKind: entity.packageKind } : { schemaRef: entity.schemaRef }),
      ...(packageScaffolds.get(entity.id) ? { packageScaffold: packageScaffolds.get(entity.id) } : {}),
      ...(repositoryRoots.get(entity.id) ? { repositoryRoot: repositoryRoots.get(entity.id) } : {}),
    }),
  );
  return {
    ids: entries.map((entry) => entry.id),
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

export function getEntityKind(registry: EntityKindRegistry, entityKind: string): EntityKindRegistration | undefined {
  return registry.byId.get(entityKind);
}
