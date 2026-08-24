import {
  serializeCanonicalEvent,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type DecisionEventV1,
  type DecisionListFilters,
  type DecisionProjectionRow,
  type FrozenWritePlan,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { FactServiceError } from "./fact-service.ts";

export type DecisionWriteBundle = CanonicalWriteBundle & {
  readonly event: DecisionEventV1;
  readonly plan: FrozenWritePlan<"DecisionWrite">;
};
export function makeDecisionService(options: {
  readonly eventStore: Pick<CanonicalEventStore, "append" | "readEvent">;
  readonly projection: Pick<
    TaskProjection,
    "admitDecision" | "apply" | "readDecision" | "listDecisions" | "readDecisionGraph"
  >;
}) {
  const record = (
    bundle: DecisionWriteBundle,
  ): {
    readonly status: "ready";
    readonly decision: DecisionProjectionRow;
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly documentSha256: string;
  } => {
    const { event } = bundle;
    try {
      serializeCanonicalEvent(event);
    } catch (error) {
      throw new FactServiceError("invalid_command", error instanceof Error ? error.message : String(error));
    }
    const existing = options.eventStore.readEvent(event.opId);
    if (existing === null) options.projection.admitDecision(event);
    const appended = options.eventStore.append(bundle);
    if (existing === null) options.projection.apply(event, bundle.plan);
    const read = options.projection.readDecision(event.decisionId);
    if (read.status !== "ready" || !read.decision)
      throw new FactServiceError(
        "content_not_ready",
        `Decision ${event.decisionId} is not projected at revision ${appended.revision}.`,
      );
    return {
      status: "ready",
      decision: read.decision,
      revision: appended.revision,
      watermark: read.watermark,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
      path: event.payload.decisionDocumentClaim.path,
      documentSha256: event.payload.decisionDocumentClaim.sha256,
    };
  };
  const list = (filters: DecisionListFilters) => options.projection.listDecisions(filters),
    show = (selector: string) => {
      const legacy = /^E[1-9][0-9]*$/u.test(selector),
        matches = legacy ? options.projection.listDecisions({ legacyId: selector }) : null;
      if (matches?.status === "pending")
        throw new FactServiceError("content_not_ready", `Decision selector ${selector} is pending.`);
      if (matches && matches.decisions.length > 1)
        throw new FactServiceError(
          "ambiguous_selector",
          `Decision selector ${selector} matches ${matches.decisions.map(({ decisionId }) => decisionId).join(", ")}.`,
        );
      const decisionId = matches?.decisions[0]?.decisionId ?? selector,
        read = options.projection.readDecision(decisionId);
      if (!read.decision) throw new FactServiceError("entity_not_found", `Decision ${selector} does not exist.`);
      return { ...read, decision: read.decision };
    },
    graph = () => {
      const read = options.projection.readDecisionGraph();
      if (read.status !== "ready")
        throw new FactServiceError(
          "content_not_ready",
          `Decision coverage is pending at revision ${read.watermark}/${read.sourceRevision}.`,
        );
      return read;
    };
  return Object.freeze({ record, show, list, graph });
}
