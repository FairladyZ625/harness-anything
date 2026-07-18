import { DecisionPackageSchema, EntityRelationRecordSchema, FactRecordSchema, TaskFrontmatterSchema } from "../schemas/registry.ts";
import {
  decisionFieldContracts,
  factFieldContracts,
  relationFieldContracts,
  taskFieldContracts,
  type DecisionFieldKey,
  type FactFieldKey,
  type RelationFieldKey,
  type TaskFieldKey
} from "./field-contracts.ts";
import { canonicalEntityKinds, type CanonicalEntityKind } from "./canonical-kinds.ts";
import { executionDeclaration } from "./execution-declaration.ts";
import { consentDeclaration } from "./consent-declaration.ts";
import { reviewDeclaration } from "./review-declaration.ts";
import { readyManagedSemanticDiff } from "./managed-semantic-diff.ts";
import {
  readyIdentityProjectionFacets,
  readyStorageLocator,
  typedOnlySemanticDiff
} from "./registry-compiler.ts";
import { sessionEntityRegistration } from "./session-declaration.ts";
import type { DispositionAction, DispositionLevel, DispositionMatrixEntry, EntityDispositionMatrix, EntityRegistration } from "./registry-contract.ts";

export {
  compileRegistryMutationPlan,
  createWritableEntityRegistry
} from "./registry-compiler.ts";
export { assertManagedSemanticRegions, readyManagedSemanticDiff } from "./managed-semantic-diff.ts";
export type {
  RegistryMutationPlanInput,
  StoragePlan
} from "./registry-compiler.ts";
export { entityStorageForms, isEntityStorageForm } from "./registry-contract.ts";
export type {
  CompositeManifestBlobDeclaration,
  DispositionAction,
  DispositionLevel,
  DispositionMatrixEntry,
  EntityAnchorDeclaration,
  EntityDispositionMatrix,
  EntityDocumentCodec,
  EntityProjectionColumnDeclaration,
  EntityProjectionDeclaration,
  EntityRegistration,
  EntityRootResolverDeclaration,
  EntityStorageForm,
  HostedEntityDeclaration,
  SectionWriteMode,
  SemanticDiffCandidateDocument,
  SemanticDiffCandidateTree,
  SemanticDiffCompileContext,
  SemanticDiffDocumentPolicy,
  SemanticDiffMutationIntent,
  SemanticDiffSectionPolicy,
  SemanticRegionClass
} from "./registry-contract.ts";
export type KernelEntityKind = CanonicalEntityKind;
export const entityRegistryVersion = 1 as const;
export const decisionSemanticMutationActions = {
  propose: "propose",
  state: "state",
  amend: "amend",
  relation: "relation"
} as const;

export type EntityRegistryShape = {
  readonly decision: EntityRegistration<DecisionFieldKey>;
  readonly task: EntityRegistration<TaskFieldKey>;
  readonly fact: EntityRegistration<FactFieldKey>;
  readonly relation: EntityRegistration<RelationFieldKey>;
  readonly module: EntityRegistration<string, "module">;
  readonly session: typeof sessionEntityRegistration;
  readonly execution: typeof executionDeclaration;
  readonly consent: typeof consentDeclaration;
  readonly review: typeof reviewDeclaration;
};

export const entityRegistry = {
  decision: {
    kind: "decision",
    schema: DecisionPackageSchema,
    mutabilityContract: decisionFieldContracts,
    anchors: {
      entityRef: "decision/{decision_id}",
      anchors: [
        { field: "claims", idField: "id", ref: "decision/{decision_id}/{id}" },
        { field: "chosen", idField: "id", ref: "decision/{decision_id}/{id}" },
        { field: "rejected", idField: "id", ref: "decision/{decision_id}/{id}" }
      ]
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["decision_retire"], "decision semantic retirement preserves organizational memory"),
      supported("D1", "supersede", ["decision_supersede"], "decision correction is expressed as supersession"),
      unsupported("D1", "invalidate", "decision invalidation is modeled as retire or supersede"),
      unsupported("D2", "archive", "decision archive/version-rollup is declared but not writable in M5 F5"),
      unsupported("D3", "tombstone", "bad proposed decisions are rejected, not tombstoned"),
      unsupported("D4", "hard-delete", "decision is why-memory and must never be physically deleted")
    ]),
    storageForm: "lifecycle",
    ...readyIdentityProjectionFacets("decision", ["decisionId"], {
      table: "decision_projection", idColumn: "decision_id", identityField: "decisionId"
    }),
    storageLocator: readyStorageLocator({
      locate: (identity) => {
        const documentPath = `decisions/decision-${identity.decisionId}/decision.md`;
        return {
          targets: [{ kind: "document", path: documentPath, access: "exact" }],
          consistencyScope: `path:${documentPath}`
        };
      }
    }),
    mutationContract: { status: "ready", actions: Object.values(decisionSemanticMutationActions) },
    semanticDiff: readyManagedSemanticDiff("decision"),
  },
  task: {
    kind: "task",
    schema: TaskFrontmatterSchema,
    mutabilityContract: taskFieldContracts,
    anchors: {
      entityRef: "task/{task_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "supersede", ["package_supersede"], "task replacement is expressed as supersession"),
      unsupported("D1", "retire", "task semantic retirement uses supersede in the current task surface"),
      unsupported("D1", "invalidate", "task invalidation is not a task disposition action"),
      supported("D2", "archive", ["package_archive"], "task archive exits the work view while preserving the package"),
      supported("D3", "tombstone", ["package_tombstone"], "task tombstone preserves id existence after mistaken creation"),
      supported("D4", "hard-delete", ["package_delete_hard"], "task hard delete is allowed only after lower-bound checks and explicit confirmation")
    ]),
    storageForm: "lifecycle",
    ...readyIdentityProjectionFacets("task", ["taskId"], {
      table: "task_projection", idColumn: "task_id", identityField: "taskId"
    }),
    storageLocator: readyStorageLocator({
      locate: (identity, context) => {
        const packagePath = context.packagePath
          ? validateTaskPackagePath(context.packagePath, identity.taskId)
          : `tasks/${identity.taskId}`;
        const documentPath = context.documentPath;
        return {
          targets: [{
            kind: "document",
            path: documentPath ? `${packagePath}/${validateRegistryDocumentPath(documentPath)}` : packagePath,
            access: documentPath ? "exact" : "prefix"
          }],
          consistencyScope: `entity:task/${identity.taskId}`
        };
      }
    }),
    mutationContract: { status: "ready", actions: ["create", "transition", "append", "document"] },
    semanticDiff: readyManagedSemanticDiff("task"),
  },
  fact: {
    kind: "fact",
    schema: FactRecordSchema,
    mutabilityContract: factFieldContracts,
    anchors: {
      entityRef: "fact/{task_id}/{fact_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "invalidate", ["fact_invalidate"], "fact is append-only; invalidation is represented by an active invalidating relation"),
      unsupported("D1", "retire", "fact semantic exit is invalidate, not retire"),
      unsupported("D1", "supersede", "fact supersession uses a relation edge and remains an invalidation-class D1 action"),
      supported("D2", "archive", ["doc_write"], "fact-to-execution migration preserves the fact with a durable migration trace"),
      unsupported("D3", "tombstone", "fact is append-only and has no single-record tombstone semantics"),
      unsupported("D4", "hard-delete", "fact must never be physically deleted as a standalone entity")
    ]),
    storageForm: "schema",
    ...readyIdentityProjectionFacets("fact", ["taskId", "factId"]),
    storageLocator: readyStorageLocator({
      locate: (identity, context) => {
        const documentPath = context.documentPath
          ? validateHostedDocumentPath(context.documentPath, identity.taskId, "facts.md")
          : `tasks/${identity.taskId}/facts.md`;
        return {
          targets: [{ kind: "document", path: documentPath, access: "exact" }],
          consistencyScope: `path:${documentPath}`
        };
      }
    }),
    mutationContract: { status: "ready", actions: ["create", "invalidate"] },
    semanticDiff: readyManagedSemanticDiff("fact"),
  },
  relation: {
    kind: "relation",
    schema: EntityRelationRecordSchema,
    mutabilityContract: relationFieldContracts,
    anchors: {
      entityRef: "relation/{relation_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["relation_retire"], "relation semantic retirement preserves the hosted edge record while removing it from active graph semantics"),
      unsupported("D1", "supersede", "relation replacement is modeled as retire old edge plus append new edge"),
      unsupported("D1", "invalidate", "relation invalidation is modeled as retire or replacing the edge"),
      unsupported("D2", "archive", "relation storage is hosted in source frontmatter and follows the host document"),
      unsupported("D3", "tombstone", "relation exit is represented by retired state, not tombstone"),
      unsupported("D4", "hard-delete", "relation records are provenance-bearing and are not physically deleted")
    ]),
    storageForm: "host_frontmatter",
    ...readyIdentityProjectionFacets("relation", ["relationId"]),
    storageLocator: readyStorageLocator({ locate: locateRelationStorage }),
    mutationContract: { status: "ready", actions: ["create", "retire"] },
    semanticDiff: readyManagedSemanticDiff("relation"),
  },
  module: {
    kind: "module",
    schema: undefined,
    mutabilityContract: {
      identity: { mutability: "immutable", read: [{ kind: "show", path: "module.key" }], write: [], reason: "module key is stable" },
      registry: { mutability: "lifecycle", read: [{ kind: "show", path: "module.registry" }], write: [{ kind: "lifecycle", operation: "module-registry" }], reason: "module registry commands own canonical changes" }
    },
    anchors: { entityRef: "module/{moduleKey}", anchors: [] },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["module_registry_write"], "module unregister preserves registry history"),
      unsupported("D1", "supersede", "module changes amend the stable registry identity"),
      unsupported("D1", "invalidate", "module invalidation is not a registered disposition"),
      unsupported("D2", "archive", "module archive is not a registered disposition"),
      unsupported("D3", "tombstone", "module tombstone is not a registered disposition"),
      unsupported("D4", "hard-delete", "module registry history is retained")
    ]),
    storageForm: "schema",
    ...readyIdentityProjectionFacets("module", ["moduleKey"], {
      table: "module_attribution_projection",
      idColumn: "module_key",
      identityField: "moduleKey",
      materialization: "mutation-index"
    }),
    storageLocator: readyStorageLocator({
      locate: () => ({
        targets: [{ kind: "document", path: "modules.json", access: "exact" }],
        consistencyScope: "path:modules.json"
      })
    }),
    mutationContract: { status: "ready", actions: ["register", "unregister", "step"] },
    semanticDiff: typedOnlySemanticDiff("modules.json has no markdown heading section registered by OQ-4/CH2; transparent writes remain read/draft-only"),
  },
  session: sessionEntityRegistration,
  execution: executionDeclaration,
  consent: consentDeclaration,
  review: reviewDeclaration
} satisfies EntityRegistryShape;

export const entityRegistryKinds = canonicalEntityKinds;

export function getEntityRegistration(kind: KernelEntityKind): EntityRegistryShape[typeof kind] {
  return entityRegistry[kind];
}

function dispositionMatrix(entries: ReadonlyArray<DispositionMatrixEntry>): EntityDispositionMatrix {
  const byAction = Object.fromEntries(entries.map((entry) => [entry.action, entry])) as Readonly<Record<DispositionAction, DispositionMatrixEntry>>;
  return { entries: byAction };
}

function supported(
  level: DispositionLevel,
  action: DispositionAction,
  writeOpKinds: ReadonlyArray<string>,
  reason: string
): DispositionMatrixEntry {
  return { level, action, supported: true, writeOpKinds, reason };
}

function unsupported(level: DispositionLevel, action: DispositionAction, reason: string): DispositionMatrixEntry {
  return { level, action, supported: false, writeOpKinds: [], reason };
}

function locateRelationStorage(
  _identity: Readonly<Record<string, string>>,
  context: Readonly<Record<string, string>>
): { readonly targets: ReadonlyArray<{ readonly kind: "document"; readonly path: string; readonly access: "exact" }>; readonly consistencyScope: string } {
  if (context.documentPath) {
    const factSource = /^fact\/([^/]+)\/[^/]+$/u.exec(context.sourceRef ?? "");
    if (!factSource?.[1]) throw new Error("RELATION_DOCUMENT_HOST_SOURCE_REQUIRED");
    const documentPath = validateHostedDocumentPath(context.documentPath, factSource[1], "facts.md");
    return {
      targets: [{ kind: "document", path: documentPath, access: "exact" }],
      consistencyScope: `path:${documentPath}`
    };
  }
  const sourceRef = context.sourceRef;
  if (!sourceRef) throw new Error("RELATION_STORAGE_SOURCE_REQUIRED");
  const segments = sourceRef.split("/").map(decodeCanonicalSegment);
  let documentPath: string;
  if (segments[0] === "task" && segments[1]) {
    documentPath = `tasks/${segments[1]}/INDEX.md`;
  } else if (segments[0] === "decision" && segments[1]) {
    documentPath = `decisions/decision-${segments[1]}/decision.md`;
  } else if (segments[0] === "fact" && segments[1] && segments[2]) {
    documentPath = `tasks/${segments[1]}/facts.md`;
  } else {
    throw new Error(`RELATION_STORAGE_SOURCE_UNSUPPORTED:${sourceRef}`);
  }
  return {
    targets: [{ kind: "document", path: documentPath, access: "exact" }],
    consistencyScope: `path:${documentPath}`
  };
}

function validateTaskPackagePath(value: string, taskId: string | undefined): string {
  const normalized = validateRegistryDocumentPath(value);
  const match = /^tasks\/([^/]+)$/u.exec(normalized);
  if (!match?.[1] || !taskId || (match[1] !== taskId && !match[1].startsWith(`${taskId}-`))) {
    throw new Error("INVALID_TASK_PACKAGE_PATH");
  }
  return normalized;
}

function validateHostedDocumentPath(value: string, taskId: string | undefined, fileName: string): string {
  const normalized = validateRegistryDocumentPath(value);
  const match = new RegExp(`^tasks/([^/]+)/${fileName.replace(".", "\\.")}$`, "u").exec(normalized);
  if (!match?.[1] || !taskId || (match[1] !== taskId && !match[1].startsWith(`${taskId}-`))) {
    throw new Error("INVALID_HOSTED_DOCUMENT_PATH");
  }
  return normalized;
}

function decodeCanonicalSegment(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.includes("/") || encodeURIComponent(decoded) !== value) {
    throw new Error(`INVALID_CANONICAL_ENTITY_SEGMENT:${value}`);
  }
  return decoded;
}

function validateRegistryDocumentPath(value: string): string {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) {
    throw new Error(`INVALID_REGISTRY_DOCUMENT_PATH:${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error(`INVALID_REGISTRY_DOCUMENT_PATH:${value}`);
  }
  return value;
}
