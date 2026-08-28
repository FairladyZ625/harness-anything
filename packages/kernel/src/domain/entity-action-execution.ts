import { sha256Text } from "../integrity/stable-hash.ts";
import type { SessionIdentity } from "./agent-runtime.ts";
import { sessionProvenance } from "./agent-runtime.ts";
import type { ActorIdentity } from "./actor-identity.ts";
import type { DecisionAmendableSnapshot, DecisionEventDraftV1 } from "./decision-event.ts";
import { deriveRelationId } from "./entity-relation.ts";
import {
  factMemoryTags,
  type FactConfidence,
  type FactEventDraftV1,
  type FactEventV1,
  type FactMemoryClass,
} from "./fact-event.ts";
import { timestamp } from "./timestamp.ts";
import type { WriteSource } from "./write-chain.contract.ts";

export type EntityActionReceiptShape =
  | "decision-list/v1"
  | "decision-repin/v1"
  | "decision-show/v1"
  | "decision-validate/v1"
  | "decision-write/v1"
  | "fact-search/v1"
  | "fact-show/v1"
  | "fact-write/v1";

export interface EntityActionRejectionContract {
  readonly invalidInput: "invalid_command";
  readonly contentPending?: "content_not_ready";
  readonly entityMissing?: "entity_not_found";
  readonly authorizationDenied?: "actor_unauthorized";
  readonly transitionDenied?: "invalid_transition";
}

export interface EntityActionExecutionContract {
  readonly ingress: string;
  readonly compile: EntityActionCompileHook | null;
  readonly receipt: {
    readonly shape: EntityActionReceiptShape;
    readonly visibility: "center";
    readonly settlement: "projection" | "publication-cut";
  };
  readonly rejections: EntityActionRejectionContract;
}

export interface EntityActionCompileInput {
  readonly action: Readonly<Record<string, unknown>>;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly session: SessionIdentity;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly rejections: EntityActionRejectionContract;
  readonly coverage?: {
    readonly decisionId: string;
    readonly taskId: string;
    readonly basisRevision: number;
    readonly rows: readonly {
      readonly claimRef: string;
      readonly status: string;
      readonly basisRevision: number;
    }[];
  };
}

export type EntityActionDraft =
  | { readonly kind: "decision"; readonly event: DecisionEventDraftV1 }
  | { readonly kind: "fact"; readonly event: FactEventDraftV1 };
export type EntityActionCompileHook = (input: EntityActionCompileInput) => EntityActionDraft;

export function compileFactRecordAction(input: EntityActionCompileInput): EntityActionDraft {
  const action = input.action,
    confidence = action.confidence as FactConfidence,
    memoryClass = action.memoryClass as FactMemoryClass,
    memoryTags = stringList(action.memoryTags),
    observedAt = typeof action.observedAt === "string" ? action.observedAt : input.occurredAt;
  if (
    !(["low", "medium", "high"] as const).includes(confidence) ||
    !(["semantic", "episodic", "procedural"] as const).includes(memoryClass) ||
    memoryTags.some((tag) => !factMemoryTags.includes(tag as never))
  )
    invalid(input, "Fact classification is invalid.");
  if (!timestamp(input.occurredAt) || !timestamp(observedAt))
    invalid(input, "Fact timestamps must be ISO-8601 UTC values ending in Z.");
  if (
    action.supersedes !== undefined &&
    (!record(action.supersedes) ||
      !/^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(String(action.supersedes.factRef)) ||
      typeof action.supersedes.rationale !== "string" ||
      [...action.supersedes.rationale].length < 1 ||
      [...action.supersedes.rationale].length > 199)
  )
    invalid(input, "Fact supersedes requires a canonical ref and rationale of at most 199 characters.");
  return {
    kind: "fact",
    event: {
      schema: "fact-event/v1",
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      ...(typeof action.taskId === "string" && action.taskId.trim() ? { taskId: action.taskId.trim() } : {}),
      factId:
        typeof action.factId === "string"
          ? requiredText(input, action.factId, "factId")
          : `F-${digest(input.opId).slice(0, 8).toUpperCase()}`,
      type: "fact_recorded",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        statement: requiredText(input, action.statement, "statement"),
        evidenceSource: requiredText(input, action.evidenceSource, "evidenceSource"),
        observedAt,
        confidence,
        memoryClass,
        memoryTags: memoryTags as FactEventV1["payload"]["memoryTags"],
        provenance: [sessionProvenance(input.session, input.occurredAt)],
        ...(record(action.supersedes)
          ? {
              supersedes: action.supersedes as {
                readonly factRef: string;
                readonly rationale: string;
              },
            }
          : {}),
      },
    },
  };
}

export type DecisionActionCompilerId =
  | "accept"
  | "amend"
  | "declare-claim"
  | "defer"
  | "fulfill-claim"
  | "propose"
  | "relate"
  | "reject"
  | "repin"
  | "replace-relation"
  | "retire"
  | "retire-relation"
  | "supersede"
  | "transition";

export function decisionActionCompiler(id: DecisionActionCompilerId): EntityActionCompileHook {
  return (input) => ({ kind: "decision", event: decisionEvent(id, input) });
}

export function compileDecisionReckonAction(input: EntityActionCompileInput): EntityActionDraft {
  const coverage = input.coverage;
  if (!coverage) invalid(input, "Decision coverage is required for reckon.");
  const report = coverage.rows.map((row) => `${row.claimRef}=${row.status}`).join(", ") || "no load-bearing claims";
  return {
    kind: "fact",
    event: {
      schema: "fact-event/v1",
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      taskId: coverage.taskId,
      factId: `F-${digest(input.opId).slice(0, 8).toUpperCase()}`,
      type: "fact_recorded",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        statement: `Decision ${coverage.decisionId} coverage at basisRevision ${coverage.basisRevision}: ${report}.`,
        evidenceSource: `decision/${coverage.decisionId}@${coverage.basisRevision}`,
        observedAt: input.occurredAt,
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: ["abstract_rule"],
        provenance: [sessionProvenance(input.session, input.occurredAt)],
      },
    },
  };
}

function decisionEvent(id: DecisionActionCompilerId, input: EntityActionCompileInput): DecisionEventDraftV1 {
  const action = input.action,
    decisionId =
      id === "propose"
        ? `dec_${digest(input.opId).slice(0, 26).toUpperCase()}`
        : requiredText(input, action.decisionId, "decisionId"),
    base = {
      schema: "decision-event/v1" as const,
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      decisionId,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
    };
  if (id === "propose")
    return {
      ...base,
      type: "decision_proposed",
      payload: {
        title: requiredText(input, action.title, "title"),
        question: requiredText(input, action.question, "question"),
        riskTier: choice(input, action.riskTier, ["low", "medium", "high"], "riskTier"),
        urgency: choice(input, action.urgency, ["low", "medium", "high"], "urgency"),
        vertical: requiredText(input, action.vertical, "vertical"),
        preset: requiredText(input, action.preset, "preset"),
        appliesTo: object(input, action.appliesTo, "appliesTo") as never,
        decisionClass: choice(input, action.decisionClass, ["ordinary", "standing_policy"], "decisionClass"),
        chosen: nonEmptyArray(input, action.chosen, "chosen") as never,
        rejected: nonEmptyArray(input, action.rejected, "rejected") as never,
        body: typeof action.body === "string" ? action.body : `\n# ${requiredText(input, action.title, "title")}\n`,
        claims: array(input, action.claims, "claims") as never,
        fulfillments: array(input, action.fulfillments, "fulfillments") as never,
        relations: proposalRelations(input, action.relations, decisionId),
        provenance: [sessionProvenance(input.session, input.occurredAt)],
      },
    };
  if (id === "transition") return transitionEvent(input, base);
  if (id === "accept")
    return {
      ...base,
      type: "decision_accepted",
      payload: {
        rationale: short(input, action.rationale, "rationale"),
        judgmentOnlyRationale:
          typeof action.judgmentOnlyRationale === "string"
            ? short(input, action.judgmentOnlyRationale, "judgmentOnlyRationale")
            : null,
        fulfillments: [],
        standingPolicy: false,
      },
    };
  if (id === "reject")
    return { ...base, type: "decision_rejected", payload: { reason: short(input, action.reason, "reason") } };
  if (id === "defer")
    return { ...base, type: "decision_deferred", payload: { reason: short(input, action.reason, "reason") } };
  if (id === "supersede")
    return { ...base, type: "decision_superseded", payload: { reason: short(input, action.reason, "reason") } };
  if (id === "retire")
    return { ...base, type: "decision_retired", payload: { reason: short(input, action.reason, "reason") } };
  if (id === "amend")
    return {
      ...base,
      type: "decision_amended",
      payload: {
        next: object(input, action.next, "next") as unknown as DecisionAmendableSnapshot,
        fields: stringList(action.fields),
        body: typeof action.body === "string" ? action.body : null,
      },
    };
  if (id === "repin")
    return {
      ...base,
      type: "decision_repinned",
      payload: { migrationEvidence: requiredText(input, action.migrationEvidence, "migrationEvidence") },
    };
  if (id === "declare-claim")
    return {
      ...base,
      type: "decision_claim_declared",
      payload: {
        claimId: requiredText(input, action.claimId, "claimId"),
        text: requiredText(input, action.text, "text"),
        loadBearing: action.loadBearing !== false,
      },
    };
  if (id === "fulfill-claim")
    return {
      ...base,
      type: "decision_claim_fulfillment_declared",
      payload: {
        claimId: requiredText(input, action.claimId, "claimId"),
        mode: choice(input, action.mode, ["evidenced", "delivered", "standing_policy"], "mode"),
      },
    };
  if (id === "relate") return relationEvent(input, base);
  if (id === "retire-relation")
    return {
      ...base,
      type: "decision_relation_retired",
      payload: {
        relationId: requiredText(input, action.relationId, "relationId"),
        reason: requiredText(input, action.reason, "reason"),
      },
    };
  return replacementEvent(input, base);
}

function transitionEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "type" | "payload">,
): DecisionEventDraftV1 {
  const action = input.action,
    state = choice(
      input,
      action.targetState,
      ["in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
      "targetState",
    ),
    reason = `Transitioned to ${state} via the canonical Decision lifecycle command.`;
  if (state === "in_effect")
    return {
      ...base,
      type: "decision_accepted",
      payload: {
        rationale:
          typeof action.judgmentOnlyRationale === "string"
            ? short(input, action.judgmentOnlyRationale, "judgmentOnlyRationale")
            : reason,
        judgmentOnlyRationale:
          typeof action.judgmentOnlyRationale === "string"
            ? short(input, action.judgmentOnlyRationale, "judgmentOnlyRationale")
            : null,
        fulfillments: array(input, action.fulfillments, "fulfillments") as never,
        standingPolicy: action.standingPolicy === true,
      },
    };
  if (state === "rejected") return { ...base, type: "decision_rejected", payload: { reason } };
  if (state === "deferred") return { ...base, type: "decision_deferred", payload: { reason } };
  return state === "superseded"
    ? { ...base, type: "decision_superseded", payload: { reason } }
    : { ...base, type: "decision_retired", payload: { reason } };
}

function relationEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "type" | "payload">,
): DecisionEventDraftV1 {
  const action = input.action,
    identity = {
      source: `decision/${base.decisionId}/${requiredText(input, action.anchor, "anchor")}`,
      target: requiredText(input, action.target, "target"),
      type: requiredText(input, action.relationType, "relationType") as never,
      direction: "directed" as const,
    };
  return {
    ...base,
    type: "decision_related",
    payload: {
      relation: {
        relation_id: deriveRelationId(identity),
        ...identity,
        strength: "strong",
        origin: "declared",
        rationale: requiredText(input, action.rationale, "rationale"),
        state: "active",
      },
    },
  };
}

function replacementEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "type" | "payload">,
): DecisionEventDraftV1 {
  const action = input.action,
    identity = {
      source: `decision/${base.decisionId}/${requiredText(input, action.anchor, "anchor")}`,
      target: requiredText(input, action.target, "target"),
      type: requiredText(input, action.relationType, "relationType") as never,
      direction: "directed" as const,
    },
    replacement = {
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong" as const,
      origin: "declared" as const,
      rationale: short(input, action.rationale, "rationale"),
      state: "active" as const,
    };
  return {
    ...base,
    type: "decision_relation_replaced",
    payload: {
      relationId: requiredText(input, action.relationId, "relationId"),
      reason: `Replaced atomically by ${replacement.relation_id}.`,
      replacement,
      body: typeof action.body === "string" ? action.body : null,
    },
  };
}

function proposalRelations(input: EntityActionCompileInput, value: unknown, decisionId: string) {
  return array(input, value, "relations").map((entry) => {
    const relation = object(input, entry, "relation"),
      identity = {
        source: `decision/${decisionId}/${requiredText(input, relation.anchor, "anchor")}`,
        target: requiredText(input, relation.target, "target"),
        type: requiredText(input, relation.type, "type") as never,
        direction: "directed" as const,
      };
    return {
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong" as const,
      origin: "declared" as const,
      rationale: short(input, relation.rationale, "rationale"),
      state: "active" as const,
    };
  });
}

function requiredText(input: EntityActionCompileInput, value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  invalid(input, `${field} is required.`);
}
function short(input: EntityActionCompileInput, value: unknown, field: string): string {
  const text = requiredText(input, value, field);
  if ([...text].length <= 199) return text;
  invalid(input, `${field} must contain at most 199 characters.`);
}
function nonEmptyArray(input: EntityActionCompileInput, value: unknown, field: string): readonly unknown[] {
  if (Array.isArray(value) && value.length) return value;
  invalid(input, `${field} must be a non-empty array.`);
}
function array(input: EntityActionCompileInput, value: unknown, field: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  invalid(input, `${field} must be an array.`);
}
function object(input: EntityActionCompileInput, value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (record(value)) return value;
  invalid(input, `${field} must be an object.`);
}
function choice<T extends string>(
  input: EntityActionCompileInput,
  value: unknown,
  choices: readonly T[],
  field: string,
): T {
  if (typeof value === "string" && choices.includes(value as T)) return value as T;
  invalid(input, `${field} is invalid.`);
}
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(input: EntityActionCompileInput, message: string): never {
  throw Object.assign(new Error(message), { code: input.rejections.invalidInput });
}
function digest(value: string): string {
  return sha256Text(value);
}
function eventId(opId: string): string {
  return `event-${digest(opId)}`;
}
