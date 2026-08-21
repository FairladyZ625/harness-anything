import type { TaskFrontmatter } from "../schemas/registry.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { DecisionProposalPayload } from "../domain/decision-event.ts";
import type { FactEventPayload } from "../domain/fact-event.ts";
import { sessionFieldContracts } from "./session-declaration.ts";

export type EntityKindWithFieldCoverage = "decision" | "task" | "fact" | "relation" | "session";
export type EntityFieldMutability = "immutable" | "lifecycle" | "amendable" | "derived";
export type EntityFieldReadSurface =
  | { readonly kind: "projection"; readonly path: string; readonly queryable: boolean }
  | { readonly kind: "show"; readonly path: string };
export type EntityFieldWriteSurface =
  | { readonly kind: "amend"; readonly operation: "replace" | "append" | "metadata" }
  | { readonly kind: "lifecycle"; readonly operation: string };

export interface EntityFieldContract {
  readonly mutability: EntityFieldMutability;
  readonly read: ReadonlyArray<EntityFieldReadSurface>;
  readonly write: ReadonlyArray<EntityFieldWriteSurface>;
  readonly reason?: string;
}

export type DecisionFieldKey = Exclude<keyof DecisionProposalPayload, "body" | "claims" | "fulfillments" | "relations"> | "schema" | "decisionId" | "state" | "proposer" | "arbiter" | "claims" | "relations" | "judgmentConsents" | "body";
export type TaskFieldKey = keyof TaskFrontmatter;
export type FactFieldKey = Exclude<keyof FactEventPayload, "factsDocumentClaim"> | "factId";
export type RelationFieldKey = keyof EntityRelationRecord;

export const decisionFieldContracts = {
  schema: immutable("schema discriminator is fixed by the entity kind", show("decision.schema")),
  decisionId: immutable("decision identity is create-only", projection("decisionId", true), show("decision.decisionId")),
  title: immutable("proposal fields are immutable", projection("title", true), show("decision.title")),
  state: lifecycle("Decision events own state", [lifecycleWrite("decision-accept/reject/defer/retire")], projection("state", true), show("decision.state")),
  riskTier: immutable("risk tier is creation-time governance metadata", show("decision.riskTier")),
  urgency: immutable("urgency is creation-time governance metadata", show("decision.urgency")),
  vertical: immutable("vertical routing is creation-time governance metadata", show("decision.vertical")),
  preset: immutable("preset routing is creation-time governance metadata", show("decision.preset")),
  appliesTo: immutable("scope changes require a new Decision", projection("appliesTo", false), show("decision.appliesTo")),
  decisionClass: immutable("classification never grants consent", show("decision.decisionClass")),
  proposer: immutable("proposal actor is canonical event provenance", show("decision.proposer")),
  arbiter: lifecycle("outcome events bind a transport arbiter; agents cannot judge their own proposal", [lifecycleWrite("decision-accept/reject/defer")], show("decision.arbiter")),
  question: immutable("changing the core question changes the decision identity; use supersede", projection("question", true), show("decision.question")),
  chosen: immutable("proposal choices do not change", projection("chosen", false), show("decision.chosen")),
  rejected: immutable("proposal rejections do not change", projection("rejected", false), show("decision.rejected")),
  claims: amendable([amendWrite("append"), amendWrite("metadata")], show("decision.claims")),
  relations: amendable([amendWrite("append"), amendWrite("metadata")], show("decision.relations")),
  judgmentConsents: lifecycle("outcome events append content-pinned consent", [lifecycleWrite("decision-accept/reject/defer")], show("decision.judgmentConsents")),
  body: amendable([amendWrite("append")], show("decision.body"))
} satisfies Record<DecisionFieldKey, EntityFieldContract>;

export const taskFieldContracts = {
  schema: immutable("schema discriminator is fixed by the entity kind", show("task.schema")),
  task_id: immutable("task identity is create-only; use supersede for replacement", projection("taskId", true), show("task.task_id")),
  title: immutable("task title is creation-time identity text", projection("title", true), show("task.title")),
  parent: immutable("parent is a creation-time task hierarchy binding", projection("parentTaskId", true), show("task.parent")),
  lifecycle: immutable("legacy authored lifecycle binding is read-only in replay/v1", projection("canonicalStatus/rawStatus/lifecycleEngine", true), show("task.lifecycle")),
  packageDisposition: immutable("legacy authored package disposition is read-only in replay/v1", projection("packageDisposition", true), show("task.packageDisposition")),
  workKind: immutable("work kind is create-time task metadata", projection("workKind", true), show("task.workKind")),
  riskTier: immutable("risk tier is create-time task metadata or one-time derives-edge seed", projection("riskTier", true), show("task.riskTier")),
  urgency: immutable("urgency is create-time task metadata or one-time derives-edge seed", projection("urgency", true), show("task.urgency")),
  vertical: immutable("vertical routing is create-time task metadata", projection("vertical", true), show("task.vertical")),
  preset: immutable("preset routing is create-time task metadata", projection("preset", true), show("task.preset")),
  provenance: immutable("provenance is bound by create/write services, not amended as content", show("task.provenance")),
  profile: immutable("profile is create-time preset metadata", projection("profile", true), show("task.profile")),
  createdBy: immutable("createdBy is captured from the local author at task creation", projection("createdBy", false), show("task.createdBy"))
} satisfies Record<TaskFieldKey, EntityFieldContract>;

export const factFieldContracts = {
  factId: immutable("fact identity is append-only; record a new fact with supersedes to correct it", show("fact.factId")),
  statement: immutable("fact statements are append-only observations; changing reality requires a superseding fact", show("fact.statement")),
  evidenceSource: immutable("fact evidence source is provenance-bearing and cannot be amended", show("fact.evidenceSource")),
  observedAt: immutable("observation time is provenance-bearing evidence and cannot be amended", show("fact.observedAt")),
  confidence: immutable("confidence is captured with the observation; later doubt is expressed by another fact or invalidation", show("fact.confidence")),
  memoryClass: immutable("memory class is create-time classification", show("fact.memoryClass")),
  memoryTags: immutable("memory tags are create-time classification", show("fact.memoryTags")),
  provenance: immutable("provenance is bound by create/write services, not amended as content", show("fact.provenance")),
  supersedes: immutable("fact supersession is declared atomically at record time", show("fact.supersedes"))
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
  relation: relationFieldContracts,
  session: sessionFieldContracts
} as const;

export const decisionAmendableFields = ["claims", "relations", "body"] as const satisfies ReadonlyArray<DecisionFieldKey>;

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
