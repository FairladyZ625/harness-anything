import { hasOnlyFields, isNonEmptyString, isRecord, serializeEventEnvelope, type ActorIdentity, type EventEnvelope } from "./write-chain.contract.ts";
import { relationDirections, relationOrigins, relationStates, relationStrengths, relationTypes, type EntityRelationRecord } from "./entity-relation.ts";

export const factConfidenceLevels = ["low", "medium", "high"] as const;
export const factMemoryClasses = ["semantic", "episodic", "procedural"] as const;
export const factMemoryTags = ["episode", "procedural", "tool_memory", "pattern", "task_skill", "abstract_rule", "other"] as const;
export const factProvenanceRuntimes = ["human", "claude-code", "codex", "zcode", "antigravity"] as const;
export type FactConfidence = typeof factConfidenceLevels[number];
export type FactMemoryClass = typeof factMemoryClasses[number];
export type FactMemoryTag = typeof factMemoryTags[number];
export type FactProvenanceRuntime = typeof factProvenanceRuntimes[number];

export interface FactEventPayload {
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: readonly FactMemoryTag[];
  readonly provenance: readonly { readonly runtime: FactProvenanceRuntime; readonly sessionId: string; readonly boundAt: string }[];
  readonly supersedes?: { readonly factRef: string; readonly rationale: string };
}

export type FactEventV1 = EventEnvelope<"fact-event/v1", "fact_recorded", ActorIdentity, FactEventPayload> & {
  readonly taskId: string;
  readonly factId: string;
};

export const decisionEventTypes = ["decision_proposed", "decision_accepted", "decision_rejected", "decision_deferred", "decision_retired", "decision_claim_declared", "decision_claim_fulfillment_declared", "decision_related", "decision_relation_retired"] as const;
export const decisionStates = ["proposed", "accepted", "rejected", "deferred", "retired"] as const;
export const decisionFulfillmentModes = ["evidenced", "delivered", "standing_policy"] as const;
export type DecisionState = typeof decisionStates[number]; export type DecisionFulfillmentMode = typeof decisionFulfillmentModes[number];
export interface DecisionProposalPayload { readonly title: string; readonly question: string; readonly riskTier: "low" | "medium" | "high"; readonly urgency: "low" | "medium" | "high"; readonly vertical: string; readonly preset: string; readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] }; readonly decisionClass: "ordinary" | "standing_policy"; readonly chosen: readonly { readonly id: string; readonly text: string; readonly rationale?: string }[]; readonly rejected: readonly { readonly id: string; readonly text: string; readonly whyNot: string }[] }
export interface DecisionPayloads { readonly decision_proposed: DecisionProposalPayload; readonly decision_accepted: { readonly rationale: string }; readonly decision_rejected: { readonly reason: string }; readonly decision_deferred: { readonly reason: string }; readonly decision_retired: { readonly reason: string }; readonly decision_claim_declared: { readonly claimId: string; readonly text: string; readonly loadBearing: boolean }; readonly decision_claim_fulfillment_declared: { readonly claimId: string; readonly mode: DecisionFulfillmentMode }; readonly decision_related: { readonly relation: EntityRelationRecord }; readonly decision_relation_retired: { readonly relationId: string; readonly reason: string } }
export type DecisionEventV1 = { [T in keyof DecisionPayloads]: EventEnvelope<"decision-event/v1", T, ActorIdentity, DecisionPayloads[T]> & { readonly decisionId: string } }[keyof DecisionPayloads];

export function isFactId(value: string): boolean { return /^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value); }
export function factRef(taskId: string, factId: string): string { return `fact/${taskId}/${factId}`; }
export function isFactEvent(event: { readonly schema: string }): event is FactEventV1 { return event.schema === "fact-event/v1"; }
export function isDecisionEvent(event: { readonly schema: string }): event is DecisionEventV1 { return event.schema === "decision-event/v1"; }
export function serializeFactEvent(event: FactEventV1): string { const errors = validateFactEvent(event); if (errors.length) throw new Error(errors.join("; ")); return serializeEventEnvelope(event); }
export function serializeDecisionEvent(event: DecisionEventV1): string { const errors = validateDecisionEvent(event); if (errors.length) throw new Error(errors.join("; ")); return serializeEventEnvelope(event); }

export function validateDecisionEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["schema", "eventId", "workspaceRevision", "opId", "decisionId", "type", "actor", "source", "occurredAt", "payload"])
    || value.schema !== "decision-event/v1" || !includes(decisionEventTypes, value.type) || !decisionId(value.decisionId) || !timestamp(value.occurredAt) || !isRecord(value.payload)) return ["decision event envelope or payload is invalid"];
  try { serializeEventEnvelope(value as unknown as DecisionEventV1); } catch { return ["decision event envelope identity is invalid"]; }
  const payload = value.payload, type = value.type;
  if (type === "decision_proposed") return proposal(payload) ? [] : ["decision proposal payload is invalid"];
  if (type === "decision_accepted") return hasOnlyFields(payload, ["rationale"]) && codePoints(payload.rationale, 1, 199) ? [] : ["decision accepted payload is invalid"];
  if (type === "decision_rejected" || type === "decision_deferred" || type === "decision_retired") return hasOnlyFields(payload, ["reason"]) && codePoints(payload.reason, 1, 199) ? [] : [`${type} payload is invalid`];
  if (type === "decision_claim_declared") return hasOnlyFields(payload, ["claimId", "text", "loadBearing"]) && claimId(payload.claimId) && isNonEmptyString(payload.text) && typeof payload.loadBearing === "boolean" ? [] : ["decision claim payload is invalid"];
  if (type === "decision_claim_fulfillment_declared") return hasOnlyFields(payload, ["claimId", "mode"]) && claimId(payload.claimId) && includes(decisionFulfillmentModes, payload.mode) ? [] : ["decision fulfillment payload is invalid"];
  if (type === "decision_related") return hasOnlyFields(payload, ["relation"]) && relation(payload.relation) ? [] : ["decision relation payload is invalid"];
  return hasOnlyFields(payload, ["relationId", "reason"]) && typeof payload.relationId === "string" && /^rel_[0-9a-f]{16}$/u.test(payload.relationId) && codePoints(payload.reason, 1, 199) ? [] : ["decision relation retirement payload is invalid"];
}

export function validateFactEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["schema", "eventId", "workspaceRevision", "opId", "taskId", "factId", "type", "actor", "source", "occurredAt", "payload"])
    || value.schema !== "fact-event/v1" || value.type !== "fact_recorded" || !safeId(value.taskId) || typeof value.factId !== "string" || !isFactId(value.factId)
    || !timestamp(value.occurredAt) || !isRecord(value.payload) || !payloadFields(value.payload)) return ["fact event envelope or payload is invalid"];
  try { serializeEventEnvelope(value as unknown as FactEventV1); } catch { return ["fact event envelope identity is invalid"]; }
  const payload = value.payload;
  if (!isNonEmptyString(payload.statement) || !isNonEmptyString(payload.evidenceSource) || !timestamp(payload.observedAt)
    || !includes(factConfidenceLevels, payload.confidence) || !includes(factMemoryClasses, payload.memoryClass)
    || !Array.isArray(payload.memoryTags) || new Set(payload.memoryTags).size !== payload.memoryTags.length || payload.memoryTags.some((tag) => !includes(factMemoryTags, tag))
    || !Array.isArray(payload.provenance) || payload.provenance.length === 0 || payload.provenance.some((entry) => !provenance(entry)) || !uniqueProvenance(payload.provenance)
    || payload.supersedes !== undefined && !supersedes(payload.supersedes)) return ["fact event payload is invalid"];
  return [];
}

function payloadFields(value: Readonly<Record<string, unknown>>): boolean {
  const required = ["statement", "evidenceSource", "observedAt", "confidence", "memoryClass", "memoryTags", "provenance"];
  return required.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => required.includes(field) || field === "supersedes");
}
function provenance(value: unknown): boolean { return isRecord(value) && hasOnlyFields(value, ["runtime", "sessionId", "boundAt"])
  && includes(factProvenanceRuntimes, value.runtime) && isNonEmptyString(value.sessionId) && timestamp(value.boundAt); }
function uniqueProvenance(values: readonly unknown[]): boolean { const keys = values.map((value) => isRecord(value) ? `${String(value.runtime)}\0${String(value.sessionId)}` : ""); return new Set(keys).size === keys.length; }
function supersedes(value: unknown): boolean { return isRecord(value) && hasOnlyFields(value, ["factRef", "rationale"])
  && typeof value.factRef === "string" && /^fact\/[^/]+\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value.factRef) && codePoints(value.rationale, 1, 199); }
function timestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function safeId(value: unknown): value is string { return isNonEmptyString(value) && !/[\\/]/u.test(value); }
function codePoints(value: unknown, min: number, max: number): value is string { return typeof value === "string" && [...value].length >= min && [...value].length <= max; }
function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] { return typeof value === "string" && (values as readonly string[]).includes(value); }
function decisionId(value: unknown): value is string { return typeof value === "string" && /^dec_[A-Za-z0-9_-]+$/u.test(value); }
function optionId(value: unknown, prefix: "CH" | "RJ"): value is string { return typeof value === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`, "u").test(value); }
function claimId(value: unknown): value is string { return typeof value === "string" && /^C[A-Za-z0-9_-]+$/u.test(value); }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length; }
function proposal(value: Readonly<Record<string, unknown>>): boolean { if (!hasOnlyFields(value, ["title", "question", "riskTier", "urgency", "vertical", "preset", "appliesTo", "decisionClass", "chosen", "rejected"]) || !isNonEmptyString(value.title) || !codePoints(value.question, 1, 499) || !includes(["low", "medium", "high"] as const, value.riskTier) || !includes(["low", "medium", "high"] as const, value.urgency) || !isNonEmptyString(value.vertical) || !isNonEmptyString(value.preset) || !includes(["ordinary", "standing_policy"] as const, value.decisionClass) || !isRecord(value.appliesTo) || !hasOnlyFields(value.appliesTo, ["modules", "productLines"]) || !strings(value.appliesTo.modules) || !strings(value.appliesTo.productLines) || !Array.isArray(value.chosen) || !value.chosen.length || !Array.isArray(value.rejected) || !value.rejected.length) return false;
  const chosen = value.chosen.every((entry) => isRecord(entry) && requiredWithOptional(entry, ["id", "text"], ["rationale"]) && optionId(entry.id, "CH") && isNonEmptyString(entry.text) && (entry.rationale === undefined || codePoints(entry.rationale, 1, 199))), rejected = value.rejected.every((entry) => isRecord(entry) && hasOnlyFields(entry, ["id", "text", "whyNot"]) && optionId(entry.id, "RJ") && isNonEmptyString(entry.text) && codePoints(entry.whyNot, 1, 199));
  const ids = [...value.chosen, ...value.rejected].map((entry) => isRecord(entry) ? entry.id : null); return chosen && rejected && new Set(ids).size === ids.length;
}
function relation(value: unknown): value is EntityRelationRecord { return isRecord(value) && hasOnlyFields(value, ["relation_id", "source", "target", "type", "strength", "direction", "origin", "rationale", "state"]) && typeof value.relation_id === "string" && /^rel_[0-9a-f]{16}$/u.test(value.relation_id) && isNonEmptyString(value.source) && isNonEmptyString(value.target) && includes(relationTypes, value.type) && includes(relationStrengths, value.strength) && includes(relationDirections, value.direction) && includes(relationOrigins, value.origin) && codePoints(value.rationale, 1, 199) && includes(relationStates, value.state) && value.state === "active"; }
function requiredWithOptional(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[]): boolean { return required.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => required.includes(field) || optional.includes(field)); }
