import {
  serializeCanonicalEvent,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type FactEventV1,
  type FactProjectionRow,
  type FactSearchFilters,
  type FrozenWritePlan,
  type TaskProjection,
} from "../../kernel/src/index.ts";

export class FactServiceError extends Error {
  readonly code: "content_not_ready" | "entity_not_found" | "ambiguous_selector" | "invalid_command";
  constructor(code: FactServiceError["code"], message: string) {
    super(message);
    this.name = "FactServiceError";
    this.code = code;
  }
}
export interface FactRecordResult {
  readonly status: "ready";
  readonly fact: FactProjectionRow;
  readonly revision: number;
  readonly watermark: number;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly path: string;
}
export type FactWriteBundle = CanonicalWriteBundle & {
  readonly event: FactEventV1;
  readonly plan: FrozenWritePlan<"FactRecord">;
};

export function makeFactService(options: {
  readonly eventStore: Pick<CanonicalEventStore, "append" | "readEvent">;
  readonly projection: Pick<TaskProjection, "admitFact" | "apply" | "readFact" | "searchFacts">;
}) {
  const record = (bundle: FactWriteBundle): FactRecordResult => {
    const { event } = bundle;
    try {
      serializeCanonicalEvent(event);
    } catch (error) {
      throw new FactServiceError("invalid_command", error instanceof Error ? error.message : String(error));
    }
    const existing = options.eventStore.readEvent(event.opId);
    if (existing === null) options.projection.admitFact(event);
    const appended = options.eventStore.append(bundle);
    if (existing === null) options.projection.apply(event, bundle.plan);
    const read = options.projection.readFact(event.taskId, event.factId);
    if (read.status !== "ready" || read.fact === null)
      throw new FactServiceError(
        "content_not_ready",
        `Fact ${event.taskId}/${event.factId} is not projected at revision ${appended.revision}.`,
      );
    return {
      status: "ready",
      fact: read.fact,
      revision: appended.revision,
      watermark: read.watermark,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
      path: event.payload.factsDocumentClaim.path,
    };
  };
  const show = (taskId: string, factId: string) => {
    const read = options.projection.readFact(taskId, factId);
    if (read.fact === null)
      throw new FactServiceError("entity_not_found", `Fact fact/${taskId}/${factId} does not exist.`);
    return { ...read, fact: read.fact };
  };
  const search = (filters: FactSearchFilters) => options.projection.searchFacts(filters);
  return Object.freeze({ record, search, show });
}
