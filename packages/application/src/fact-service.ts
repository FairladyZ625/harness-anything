import { canonicalEventWritePlan, serializeCanonicalEvent, type CanonicalEventStore, type CanonicalWriteBundle, type DecisionEventV1, type DecisionProjectionRow, type DecisionSearchFilters, type FactEventV1, type FactProjectionRow, type FactSearchFilters, type FrozenWritePlan, type TaskProjection } from "../../kernel/src/index.ts";

export class FactServiceError extends Error { readonly code: "content_not_ready" | "entity_not_found" | "invalid_command";
  constructor(code: FactServiceError["code"], message: string) { super(message); this.name = "FactServiceError"; this.code = code; } }
export interface FactRecordResult { readonly status: "ready"; readonly fact: FactProjectionRow; readonly revision: number; readonly watermark: number; readonly commitSha: string; readonly path: string }
export type FactWriteBundle = CanonicalWriteBundle & { readonly event: FactEventV1; readonly plan: FrozenWritePlan<"FactRecord"> };

export function makeFactService(options: { readonly eventStore: Pick<CanonicalEventStore, "append" | "readEvent">; readonly projection: Pick<TaskProjection, "admitFact" | "apply" | "readFact" | "searchFacts"> }) {
  const record = (bundle: FactWriteBundle): FactRecordResult => { const { event } = bundle;
    try { serializeCanonicalEvent(event); } catch (error) { throw new FactServiceError("invalid_command", error instanceof Error ? error.message : String(error)); }
    const existing = options.eventStore.readEvent(event.opId);
    if (existing === null) options.projection.admitFact(event);
    const appended = options.eventStore.append(bundle);
    if (existing === null) options.projection.apply(event, bundle.plan);
    const read = options.projection.readFact(event.taskId, event.factId);
    if (read.status !== "ready" || read.fact === null) throw new FactServiceError("content_not_ready", `Fact ${event.taskId}/${event.factId} is not projected at revision ${appended.revision}.`);
    return { status: "ready", fact: read.fact, revision: appended.revision, watermark: read.watermark, commitSha: appended.commitSha.sha, path: event.payload.factsDocumentClaim.path };
  };
  const show = (taskId: string, factId: string) => { const read = options.projection.readFact(taskId, factId);
    if (read.fact === null) throw new FactServiceError("entity_not_found", `Fact fact/${taskId}/${factId} does not exist.`); return { ...read, fact: read.fact }; };
  const search = (filters: FactSearchFilters) => options.projection.searchFacts(filters);
  return Object.freeze({ record, search, show });
}

export function makeDecisionService(options: { readonly eventStore: Pick<CanonicalEventStore, "append" | "readEvent">; readonly projection: Pick<TaskProjection, "admitDecision" | "apply" | "readDecision" | "searchDecisions" | "readDecisionGraph"> }) { const record = (event: DecisionEventV1): { readonly status: "ready"; readonly decision: DecisionProjectionRow; readonly revision: number; readonly watermark: number } => { try { serializeCanonicalEvent(event); } catch (error) { throw new FactServiceError("invalid_command", error instanceof Error ? error.message : String(error)); } const existing = options.eventStore.readEvent(event.opId); if (existing === null) options.projection.admitDecision(event); const appended = options.eventStore.append({ event, plan: canonicalEventWritePlan(event, "decision/v1", event.decisionId), blobs: [] }); if (existing === null) options.projection.apply(event); const read = options.projection.readDecision(event.decisionId); if (read.status !== "ready" || !read.decision) throw new FactServiceError("content_not_ready", `Decision ${event.decisionId} is not projected at revision ${appended.revision}.`); return { status: "ready", decision: read.decision, revision: appended.revision, watermark: read.watermark }; };
  const show = (decisionId: string) => { const read = options.projection.readDecision(decisionId); if (!read.decision) throw new FactServiceError("entity_not_found", `Decision ${decisionId} does not exist.`); return { ...read, decision: read.decision }; }; const search = (filters: DecisionSearchFilters) => options.projection.searchDecisions(filters), graph = () => { const read = options.projection.readDecisionGraph(); if (read.status !== "ready") throw new FactServiceError("content_not_ready", `Decision coverage is pending at revision ${read.watermark}/${read.sourceRevision}.`); return read; }; return Object.freeze({ record, show, search, graph }); }
