import type { TaskFrontmatter } from "../schemas/registry.ts";
import type { DecisionPackage } from "../schemas/decision-package.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { FactRecordDocument } from "../schemas/fact-record.ts";

export type EntityKindWithFieldCoverage = "decision" | "task" | "fact" | "relation";
export type EntityFieldMutability = "immutable" | "lifecycle" | "amendable" | "derived";
export type EntityFieldReadSurface =
  | { readonly kind: "projection"; readonly path: string; readonly queryable: boolean }
  | { readonly kind: "show"; readonly path: string };
export type EntityFieldWriteSurface =
  | { readonly kind: "amend"; readonly operation: "replace" | "append" }
  | { readonly kind: "lifecycle"; readonly operation: string };

export interface EntityFieldContract {
  readonly mutability: EntityFieldMutability;
  readonly read: ReadonlyArray<EntityFieldReadSurface>;
  readonly write: ReadonlyArray<EntityFieldWriteSurface>;
  readonly reason?: string;
}

export type DecisionFieldKey = keyof DecisionPackage;
export type TaskFieldKey = keyof TaskFrontmatter;
export type FactFieldKey = keyof FactRecordDocument;
export type RelationFieldKey = keyof EntityRelationRecord;

export const decisionFieldContracts = {
  schema: immutable("schema discriminator is fixed by the entity kind", show("decision.schema")),
  decision_id: immutable("decision identity is create-only; use supersede for identity changes", projection("decisionId", true), show("decision.decision_id")),
  _coordinatorWatermark: derived("coordinator computes the committed write watermark", show("decision._coordinatorWatermark")),
  title: amendable([amendWrite("replace")], projection("title", true), show("decision.title")),
  state: lifecycle("decision lifecycle transitions own state", [lifecycleWrite("decision-accept/reject/defer/supersede/retire")], projection("state", true), show("decision.state")),
  riskTier: immutable("risk tier is creation-time governance metadata", show("decision.riskTier")),
  urgency: immutable("urgency is creation-time governance metadata", show("decision.urgency")),
  vertical: immutable("vertical routing is creation-time governance metadata", show("decision.vertical")),
  preset: immutable("preset routing is creation-time governance metadata", show("decision.preset")),
  applies_to: immutable("module/product-line scope changes require a superseding decision", projection("moduleKeys/productLineKeys", true), show("decision.applies_to")),
  proposedBy: immutable("proposal actor is provenance and cannot be amended", show("decision.proposedBy")),
  proposedAt: immutable("proposal timestamp is provenance and cannot be amended", show("decision.proposedAt")),
  arbiter: lifecycle("decision lifecycle transitions own arbiter", [lifecycleWrite("decision-accept/reject/defer/supersede/retire")], show("decision.arbiter")),
  decidedAt: lifecycle("decision lifecycle transitions own decidedAt", [lifecycleWrite("decision-accept/reject/defer/supersede/retire")], projection("decidedAt", true), show("decision.decidedAt")),
  provenance: immutable("provenance is bound by create/write services, not amended as content", show("decision.provenance")),
  question: immutable("changing the core question changes the decision identity; use supersede", projection("question", true), show("decision.question")),
  chosen: amendable([amendWrite("append")], projection("chosen", false), show("decision.chosen")),
  rejected: amendable([amendWrite("append")], projection("rejected", false), show("decision.rejected")),
  claims: amendable([amendWrite("append")], show("decision.claims")),
  relations: immutable("relation changes require relation/evidence-specific write surfaces", show("decision.relations"))
} satisfies Record<DecisionFieldKey, EntityFieldContract>;

export const taskFieldContracts = {
  schema: immutable("schema discriminator is fixed by the entity kind", show("task.schema")),
  task_id: immutable("task identity is create-only; use supersede for replacement", projection("taskId", true), show("task.task_id")),
  title: immutable("task title has no amend surface yet; changing identity-level text requires supersede", projection("title", true), show("task.title")),
  parent: immutable("parent is a create-time task hierarchy binding; create a new child or supersede to change hierarchy", projection("parentTaskId", true), show("task.parent")),
  lifecycle: lifecycle("task lifecycle commands own lifecycle binding", [lifecycleWrite("status-set/reopen/archive/delete/supersede")], projection("canonicalStatus/rawStatus/lifecycleEngine", true), show("task.lifecycle")),
  packageDisposition: lifecycle("task archive/delete/reopen commands own package disposition", [lifecycleWrite("archive/delete/reopen/supersede")], projection("packageDisposition", true), show("task.packageDisposition")),
  vertical: immutable("vertical routing is create-time task metadata", projection("vertical", true), show("task.vertical")),
  preset: immutable("preset routing is create-time task metadata", projection("preset", true), show("task.preset")),
  provenance: immutable("provenance is bound by create/write services, not amended as content", show("task.provenance")),
  profile: immutable("profile is create-time preset metadata", projection("profile", true), show("task.profile")),
  createdBy: immutable("createdBy is captured from the local author at task creation", projection("createdBy", false), show("task.createdBy"))
} satisfies Record<TaskFieldKey, EntityFieldContract>;

export const factFieldContracts = {
  schema: immutable("schema discriminator is fixed by the entity kind", show("fact.schema")),
  fact_id: immutable("fact identity is append-only; record a new fact or invalidate the old one", show("fact.fact_id")),
  statement: immutable("fact statements are append-only observations; changing reality requires a new fact or invalidate", show("fact.statement")),
  source: immutable("fact source is provenance-bearing evidence and cannot be amended", show("fact.source")),
  observedAt: immutable("observation time is provenance-bearing evidence and cannot be amended", show("fact.observedAt")),
  confidence: immutable("confidence is captured with the observation; later doubt is expressed by another fact or invalidation", show("fact.confidence")),
  memoryClass: immutable("memory class is create-time classification", show("fact.memoryClass")),
  memoryTags: immutable("memory tags are create-time classification", show("fact.memoryTags")),
  provenance: immutable("provenance is bound by create/write services, not amended as content", show("fact.provenance"))
} satisfies Record<FactFieldKey, EntityFieldContract>;

export const relationFieldContracts = {
  relation_id: derived("relation identity is sha256(source|target|type|direction) and changes when an endpoint or type changes", projection("relationId", true), show("relation.relation_id")),
  source: immutable("relation source is identity-bearing; replace the relation to change it", projection("source", true), show("relation.source")),
  target: immutable("relation target is identity-bearing; replace the relation to change it", projection("target", true), show("relation.target")),
  type: immutable("relation type is identity-bearing; replace the relation to change it", projection("type", true), show("relation.type")),
  strength: immutable("relation strength is provenance-bearing in the current write surface", projection("strength", true), show("relation.strength")),
  direction: immutable("relation direction is identity-bearing; replace the relation to change it", projection("direction", true), show("relation.direction")),
  origin: immutable("relation origin is provenance metadata", projection("origin", true), show("relation.origin")),
  rationale: immutable("relation rationale is captured at append; replace the relation to change it", show("relation.rationale")),
  state: lifecycle("relation lifecycle transitions own state", [lifecycleWrite("relation_retire")], projection("state", true), show("relation.state"))
} satisfies Record<RelationFieldKey, EntityFieldContract>;

export const entityFieldContracts = {
  decision: decisionFieldContracts,
  task: taskFieldContracts,
  fact: factFieldContracts,
  relation: relationFieldContracts
} as const;

export const decisionAmendableFields = ["title", "chosen", "rejected", "claims"] as const satisfies ReadonlyArray<DecisionFieldKey>;
export type DecisionAmendField = (typeof decisionAmendableFields)[number];
export type DecisionAmendOperation = Extract<EntityFieldWriteSurface, { readonly kind: "amend" }>["operation"];

export function isDecisionAmendField(value: string): value is DecisionAmendField {
  return value in decisionFieldContracts && decisionFieldContracts[value as keyof typeof decisionFieldContracts].mutability === "amendable";
}

export function decisionAmendFieldSupportsOperation(field: DecisionAmendField, operation: DecisionAmendOperation): boolean {
  return decisionFieldContracts[field].write.some((surface: EntityFieldWriteSurface) => surface.kind === "amend" && surface.operation === operation);
}

function immutable(reason: string, ...read: ReadonlyArray<EntityFieldReadSurface>): EntityFieldContract {
  return { mutability: "immutable", read, write: [], reason };
}

function lifecycle(reason: string, write: ReadonlyArray<EntityFieldWriteSurface>, ...read: ReadonlyArray<EntityFieldReadSurface>): EntityFieldContract {
  return { mutability: "lifecycle", read, write, reason };
}

function amendable(write: ReadonlyArray<EntityFieldWriteSurface>, ...read: ReadonlyArray<EntityFieldReadSurface>): EntityFieldContract {
  return { mutability: "amendable", read, write };
}

function derived(reason: string, ...read: ReadonlyArray<EntityFieldReadSurface>): EntityFieldContract {
  return { mutability: "derived", read, write: [], reason };
}

function projection(path: string, queryable: boolean): EntityFieldReadSurface {
  return { kind: "projection", path, queryable };
}

function show(path: string): EntityFieldReadSurface {
  return { kind: "show", path };
}

function amendWrite(operation: Extract<EntityFieldWriteSurface, { readonly kind: "amend" }>["operation"]): EntityFieldWriteSurface {
  return { kind: "amend", operation };
}

function lifecycleWrite(operation: string): EntityFieldWriteSurface {
  return { kind: "lifecycle", operation };
}
