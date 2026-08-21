import { createHash } from "node:crypto";
import { makeFactService } from "../../application/src/index.ts";
import { compileFactWrite, factMemoryTags, factWritePlan, type ActorIdentity, type CanonicalEventCut, type CanonicalEventStore, type EventPublicationKillpoint, type FactConfidence, type FactEventDraftV1, type FactEventV1, type FactMemoryClass, type FactSearchFilters, type TaskProjection, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts"; import { unknownFieldViolation } from "./protocol/json-rpc-types.ts";

interface Binding { readonly actor: ActorIdentity; readonly source: WriteSource }
export function makeFactActions(input: { readonly store: CanonicalEventStore; readonly projection: TaskProjection; readonly now: () => string; readonly killpoint?: (point: EventPublicationKillpoint) => void }) {
  const service = makeFactService({ eventStore: input.store, projection: input.projection });
  const run = (action: Readonly<Record<string, unknown>> & { readonly kind: string }, binding: Binding, opId: string): WriteReceipt => {
    if (action.kind === "fact-search") return readReceipt("fact-search", service.search(filters(action)));
    if (action.kind === "fact-show") return readReceipt("fact-show", service.show(requiredFactText(action.taskId, "taskId"), requiredFactText(action.factId, "factId")));
    if (action.kind !== "fact-record") throw factActionError("unsupported_command", "Use fact record, search, or show.");
    const existing = input.store.readEvent(opId), occurredAt = existing?.occurredAt ?? input.now(), bundle = existing?.schema === "fact-event/v1" ? replayBundle(input, existing) : compileFact(input, factEvent(action, binding, opId, occurredAt, (input.store.readHead()?.revision ?? 0) + 1));
    const result = service.record(bundle); input.killpoint?.("after_sqlite_commit"); input.killpoint?.("before_response_write"); input.killpoint?.("after_response_write");
    return factReceipt(result, bundle.event);
  };
  return Object.freeze({ run });
}

function factEvent(action: Readonly<Record<string, unknown>>, binding: Binding, opId: string, occurredAt: string, workspaceRevision: number): FactEventDraftV1 {
  const confidence = action.confidence as FactConfidence, memoryClass = action.memoryClass as FactMemoryClass, memoryTags = factStringList(action.memoryTags);
  if (!(["low", "medium", "high"] as const).includes(confidence) || !(["semantic", "episodic", "procedural"] as const).includes(memoryClass)
    || memoryTags.some((tag) => !factMemoryTags.includes(tag as never))) throw factActionError("invalid_command", "Fact classification is invalid.");
  if (action.supersedes !== undefined && (!action.supersedes || typeof action.supersedes !== "object" || !/^fact\/[^/]+\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(String((action.supersedes as Record<string, unknown>).factRef)) || typeof (action.supersedes as Record<string, unknown>).rationale !== "string" || [...String((action.supersedes as Record<string, unknown>).rationale)].length < 1 || [...String((action.supersedes as Record<string, unknown>).rationale)].length > 199)) throw factActionError("invalid_command", "Fact supersedes requires a canonical ref and rationale of at most 199 characters.");
  const runtime = binding.actor.executor && (["claude-code", "codex", "zcode", "antigravity"] as const).includes(binding.actor.executor.id as never) ? binding.actor.executor.id as "claude-code" | "codex" | "zcode" | "antigravity" : "human";
  return { schema: "fact-event/v1", eventId: `event-${createHash("sha256").update(opId).digest("hex")}`, workspaceRevision, opId, taskId: requiredFactText(action.taskId, "taskId"),
    factId: typeof action.factId === "string" ? requiredFactText(action.factId, "factId") : `F-${createHash("sha256").update(opId).digest("hex").slice(0, 8).toUpperCase()}`, type: "fact_recorded", actor: binding.actor, source: binding.source, occurredAt,
    payload: { statement: requiredFactText(action.statement, "statement"), evidenceSource: requiredFactText(action.evidenceSource, "evidenceSource"), observedAt: typeof action.observedAt === "string" ? action.observedAt : occurredAt,
      confidence, memoryClass, memoryTags: memoryTags as FactEventV1["payload"]["memoryTags"], provenance: [{ runtime, sessionId: typeof binding.source === "object" ? binding.source.kind === "assignment" ? binding.source.assignmentId : binding.source.sessionId : `transport:${binding.actor.principal.personId}`, boundAt: occurredAt }],
      ...(action.supersedes && typeof action.supersedes === "object" ? { supersedes: action.supersedes as { readonly factRef: string; readonly rationale: string } } : {}) } };
}
export function compileFact(input: { readonly store: CanonicalEventStore; readonly projection: TaskProjection }, draft: FactEventDraftV1) { const task = input.projection.read(draft.taskId); if (task.watermark !== task.sourceRevision || !task.packagePath || !task.snapshot.task) throw factActionError("content_not_ready", `Task ${draft.taskId} is not ready for fact record.`); const current = input.projection.searchFacts({ taskId: draft.taskId }); if (current.watermark !== current.sourceRevision) throw factActionError("content_not_ready", `Facts for ${draft.taskId} are pending.`); return compileFactWrite({ event: draft, packagePath: task.packagePath, currentFacts: current.facts }); }
function replayBundle(input: { readonly store: CanonicalEventStore }, event: FactEventV1) { const bytes = input.store.readContentBlob(event.payload.factsDocumentClaim.sha256); if (!bytes) throw factActionError("content_not_ready", `Facts content for ${event.taskId} is unavailable.`); return { event, plan: factWritePlan(event), blobs: [{ sha256: event.payload.factsDocumentClaim.sha256, size: event.payload.factsDocumentClaim.size, mediaType: event.payload.factsDocumentClaim.mediaType, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }] } as const; }
export function factReceipt(result: { readonly revision: number; readonly watermark: number; readonly commitSha: string | null; readonly cut: CanonicalEventCut; readonly path: string; readonly fact: { readonly factId: string; readonly evidenceSource: string } }, event: FactEventV1): WriteReceipt & { readonly path: string; readonly commitSha: string | null; readonly cut: CanonicalEventCut; readonly worktreeVisible: true; readonly factId: string } { return { outcome: "applied", opId: event.opId, revision: result.revision, evidence: JSON.stringify({ ...result.fact, path: result.path, eventId: event.eventId, commitSha: result.commitSha }), visibility: "center", proof: { committedRevision: result.revision, appliedCut: result.watermark, durable: true, canonicalVisible: true, worktreeVisible: true }, path: result.path, commitSha: result.commitSha, cut: result.cut, worktreeVisible: true, factId: result.fact.factId }; }
function filters(action: Readonly<Record<string, unknown>>): FactSearchFilters {
  const allowed = ["kind", "query", "taskId", "confidence", "memoryClass", "observedAfter", "observedBefore", "limit", "cursor"], unknownField = unknownFieldViolation(action, allowed);
  if (unknownField) throw factActionError("invalid_command", `Fact search filters contain an ${unknownField}`);
  const query = action.query, taskId = action.taskId, confidence = action.confidence, memoryClass = action.memoryClass, observedAfter = action.observedAfter, observedBefore = action.observedBefore, limit = action.limit, cursor = action.cursor;
  if (query !== undefined && (typeof query !== "string" || !query.trim())) throw factActionError("invalid_command", "Fact search query must be a non-empty string.");
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim())) throw factActionError("invalid_command", "Fact search taskId must be a non-empty string.");
  if (confidence !== undefined && (typeof confidence !== "string" || !( ["low", "medium", "high"] as const).includes(confidence as FactConfidence))) throw factActionError("invalid_command", "Fact search confidence is invalid.");
  if (memoryClass !== undefined && (typeof memoryClass !== "string" || !( ["semantic", "episodic", "procedural"] as const).includes(memoryClass as FactMemoryClass))) throw factActionError("invalid_command", "Fact search memory class is invalid.");
  if (observedAfter !== undefined && !validIsoTimestamp(observedAfter)) throw factActionError("invalid_command", "observedAfter must be an ISO-8601 UTC timestamp.");
  if (observedBefore !== undefined && !validIsoTimestamp(observedBefore)) throw factActionError("invalid_command", "observedBefore must be an ISO-8601 UTC timestamp.");
  if (typeof observedAfter === "string" && typeof observedBefore === "string" && Date.parse(observedAfter) > Date.parse(observedBefore)) throw factActionError("invalid_command", "observedAfter must not be later than observedBefore.");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw factActionError("invalid_command", "Fact search limit must be an integer between 1 and 500.");
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim())) throw factActionError("invalid_command", "Fact search cursor is invalid.");
  return {
    ...(typeof query === "string" ? { query } : {}),
    ...(typeof taskId === "string" ? { taskId } : {}),
    ...(typeof confidence === "string" ? { confidence: confidence as FactConfidence } : {}),
    ...(typeof memoryClass === "string" ? { memoryClass: memoryClass as FactMemoryClass } : {}),
    ...(typeof observedAfter === "string" ? { observedAfter } : {}),
    ...(typeof observedBefore === "string" ? { observedBefore } : {}),
    ...(limit !== undefined ? { limit: limit as number } : {}),
    ...(typeof cursor === "string" ? { cursor } : {})
  };
}
function validIsoTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
export function readReceipt<T extends { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number }>(command: string, read: T): WriteReceipt { const base = { opId: `read:${command}`, revision: read.sourceRevision, evidence: JSON.stringify(read), visibility: "center" as const, proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark, durable: true, canonicalVisible: read.status === "ready", worktreeVisible: null } }; return read.status === "ready" ? { outcome: "applied", ...base } : { outcome: "pending", ...base, nextAction: `Retry ${command} after projection catch-up.` }; }
export function requiredFactText(value: unknown, field: string): string { if (typeof value === "string" && value.trim()) return value; throw factActionError("invalid_command", `${field} is required.`); }
export function factStringList(value: unknown): readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
export function factActionError(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
