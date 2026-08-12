import { hasOnlyFields, isNonEmptyString, isRecord, serializeEventEnvelope, type ActorIdentity, type EventEnvelope } from "./write-chain.contract.ts";

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

export function isFactId(value: string): boolean { return /^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value); }
export function factRef(taskId: string, factId: string): string { return `fact/${taskId}/${factId}`; }
export function isFactEvent(event: { readonly schema: string }): event is FactEventV1 { return event.schema === "fact-event/v1"; }
export function serializeFactEvent(event: FactEventV1): string { const errors = validateFactEvent(event); if (errors.length) throw new Error(errors.join("; ")); return serializeEventEnvelope(event); }

export function validateFactEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["schema", "eventId", "workspaceRevision", "opId", "taskId", "factId", "type", "actor", "source", "occurredAt", "payload"])
    || value.schema !== "fact-event/v1" || value.type !== "fact_recorded" || !safeId(value.taskId) || typeof value.factId !== "string" || !isFactId(value.factId)
    || !isRecord(value.payload) || !payloadFields(value.payload)) return ["fact event envelope or payload is invalid"];
  try { serializeEventEnvelope(value as unknown as FactEventV1); } catch { return ["fact event envelope identity is invalid"]; }
  const payload = value.payload;
  if (!isNonEmptyString(payload.statement) || !isNonEmptyString(payload.evidenceSource) || !timestamp(payload.observedAt)
    || !includes(factConfidenceLevels, payload.confidence) || !includes(factMemoryClasses, payload.memoryClass)
    || !Array.isArray(payload.memoryTags) || new Set(payload.memoryTags).size !== payload.memoryTags.length || payload.memoryTags.some((tag) => !includes(factMemoryTags, tag))
    || !Array.isArray(payload.provenance) || payload.provenance.length === 0 || payload.provenance.some((entry) => !provenance(entry))
    || payload.supersedes !== undefined && !supersedes(payload.supersedes)) return ["fact event payload is invalid"];
  return [];
}

function payloadFields(value: Readonly<Record<string, unknown>>): boolean {
  const required = ["statement", "evidenceSource", "observedAt", "confidence", "memoryClass", "memoryTags", "provenance"];
  return required.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => required.includes(field) || field === "supersedes");
}
function provenance(value: unknown): boolean { return isRecord(value) && hasOnlyFields(value, ["runtime", "sessionId", "boundAt"])
  && includes(factProvenanceRuntimes, value.runtime) && isNonEmptyString(value.sessionId) && timestamp(value.boundAt); }
function supersedes(value: unknown): boolean { return isRecord(value) && hasOnlyFields(value, ["factRef", "rationale"])
  && typeof value.factRef === "string" && /^fact\/[^/]+\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value.factRef) && codePoints(value.rationale, 1, 199); }
function timestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function safeId(value: unknown): value is string { return isNonEmptyString(value) && !/[\\/]/u.test(value); }
function codePoints(value: unknown, min: number, max: number): value is string { return typeof value === "string" && [...value].length >= min && [...value].length <= max; }
function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] { return typeof value === "string" && (values as readonly string[]).includes(value); }
