import { createHash } from "node:crypto";
import { makeFactService } from "../../application/src/index.ts";
import { factMemoryTags, type ActorIdentity, type CanonicalEventStore, type EventPublicationKillpoint, type FactConfidence, type FactEventV1, type FactMemoryClass, type TaskProjection, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts";

interface Binding { readonly actor: ActorIdentity; readonly source: WriteSource }
export function makeFactActions(input: { readonly store: CanonicalEventStore; readonly projection: TaskProjection; readonly now: () => string; readonly killpoint?: (point: EventPublicationKillpoint) => void }) {
  const service = makeFactService({ eventStore: input.store, projection: input.projection });
  const run = (action: Readonly<Record<string, unknown>> & { readonly kind: string }, binding: Binding, opId: string): WriteReceipt => {
    if (action.kind === "fact-search") return readReceipt("fact-search", service.search(filters(action)));
    if (action.kind === "fact-show") return readReceipt("fact-show", service.show(required(action.taskId, "taskId"), required(action.factId, "factId")));
    if (action.kind !== "fact-record") throw coded("unsupported_command", "Use fact record, search, or show.");
    const existing = input.store.readEvent(opId), occurredAt = existing?.occurredAt ?? input.now();
    const event = existing?.schema === "fact-event/v1" ? existing : factEvent(action, binding, opId, occurredAt, (input.store.readHead()?.revision ?? 0) + 1);
    const result = service.record(event); input.killpoint?.("after_sqlite_commit"); input.killpoint?.("before_response_write"); input.killpoint?.("after_response_write");
    return { outcome: "applied", opId, revision: result.revision, evidence: JSON.stringify(result.fact), visibility: "center", proof: { committedRevision: result.revision, appliedCut: result.watermark, durable: true, canonicalVisible: true, worktreeVisible: null } };
  };
  return Object.freeze({ run });
}
function factEvent(action: Readonly<Record<string, unknown>>, binding: Binding, opId: string, occurredAt: string, workspaceRevision: number): FactEventV1 {
  const confidence = action.confidence as FactConfidence, memoryClass = action.memoryClass as FactMemoryClass, memoryTags = strings(action.memoryTags);
  if (!(["low", "medium", "high"] as const).includes(confidence) || !(["semantic", "episodic", "procedural"] as const).includes(memoryClass)
    || memoryTags.some((tag) => !factMemoryTags.includes(tag as never))) throw coded("invalid_command", "Fact classification is invalid.");
  const runtime = binding.actor.executor && (["claude-code", "codex", "zcode", "antigravity"] as const).includes(binding.actor.executor.id as never) ? binding.actor.executor.id as "claude-code" | "codex" | "zcode" | "antigravity" : "human";
  return { schema: "fact-event/v1", eventId: `event-${createHash("sha256").update(opId).digest("hex")}`, workspaceRevision, opId, taskId: required(action.taskId, "taskId"),
    factId: `F-${createHash("sha256").update(opId).digest("hex").slice(0, 8).toUpperCase()}`, type: "fact_recorded", actor: binding.actor, source: binding.source, occurredAt,
    payload: { statement: required(action.statement, "statement"), evidenceSource: required(action.evidenceSource, "evidenceSource"), observedAt: typeof action.observedAt === "string" ? action.observedAt : occurredAt,
      confidence, memoryClass, memoryTags: memoryTags as FactEventV1["payload"]["memoryTags"], provenance: [{ runtime, sessionId: typeof binding.source === "object" ? binding.source.assignmentId : `transport:${binding.actor.principal.personId}`, boundAt: occurredAt }],
      ...(action.supersedes && typeof action.supersedes === "object" ? { supersedes: action.supersedes as { readonly factRef: string; readonly rationale: string } } : {}) } };
}
function filters(action: Readonly<Record<string, unknown>>) { return { ...(typeof action.query === "string" ? { query: action.query } : {}), ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}), ...(typeof action.confidence === "string" ? { confidence: action.confidence as FactConfidence } : {}), ...(typeof action.memoryClass === "string" ? { memoryClass: action.memoryClass as FactMemoryClass } : {}) }; }
function readReceipt(command: string, read: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number }): WriteReceipt { const base = { opId: `read:${command}`, revision: read.sourceRevision, evidence: JSON.stringify(read), visibility: "center" as const, proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark, durable: true, canonicalVisible: read.status === "ready", worktreeVisible: null } }; return read.status === "ready" ? { outcome: "applied", ...base } : { outcome: "pending", ...base, nextAction: `Retry ${command} after projection catch-up.` }; }
function required(value: unknown, field: string): string { if (typeof value === "string" && value.trim()) return value; throw coded("invalid_command", `${field} is required.`); }
function strings(value: unknown): readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
function coded(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
