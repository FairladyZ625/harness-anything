import {
  serializeCanonicalEvent,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type DecisionEventV1,
  type DecisionListFilters,
  type DecisionProjectionListRead,
  type DecisionProjectionRow,
  type FrozenWritePlan,
  type TaskProjection,
} from "@harness-anything/kernel";
import { decisionDocumentProse } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { DecisionListSummaryRow } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import { FactServiceError } from "./fact-service.ts";

export type DecisionWriteBundle = CanonicalWriteBundle & {
  readonly event: DecisionEventV1;
  readonly plan: FrozenWritePlan<"DecisionWrite">;
};
export interface DecisionService {
  readonly record: (bundle: DecisionWriteBundle) => {
    readonly status: "ready";
    readonly decision: DecisionProjectionRow;
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly documentSha256: string;
  };
  readonly show: (selector: string) => ReturnType<TaskProjection["readDecision"]> & {
    readonly decision: DecisionProjectionRow;
  };
  readonly list: TaskProjection["listDecisions"];
  readonly coverage: (decisionId: string) => ReturnType<TaskProjection["readDecisionCoverage"]>;
}
export function makeDecisionService(options: {
  readonly eventStore: Pick<CanonicalEventStore, "append" | "readEvent">;
  readonly projection: Pick<
    TaskProjection,
    "admitDecision" | "apply" | "readDecision" | "listDecisions" | "readDecisionCoverage"
  >;
}): DecisionService {
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
    const claim = event.payload.decisionDocumentClaim;
    const writtenBlob = existing === null ? bundle.blobs.find((blob) => blob.sha256 === claim.sha256) : undefined;
    const read = options.projection.readDecision(event.decisionId, writtenBlob === undefined);
    if (read.status !== "ready" || !read.decision)
      throw new FactServiceError(
        "content_not_ready",
        `Decision ${event.decisionId} is not projected at revision ${appended.revision}.`,
      );
    const decision: DecisionProjectionRow =
      writtenBlob === undefined
        ? read.decision
        : {
            ...read.decision,
            body: {
              path: claim.path,
              blobSha256: claim.sha256,
              size: claim.size,
              mediaType: claim.mediaType,
              body: decisionDocumentProse(
                typeof writtenBlob.body === "string"
                  ? writtenBlob.body
                  : new TextDecoder("utf-8", { fatal: true }).decode(writtenBlob.body),
              ),
              workspaceRevision: event.workspaceRevision,
            },
          };
    return {
      status: "ready",
      decision,
      revision: appended.revision,
      watermark: read.watermark,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
      path: claim.path,
      documentSha256: claim.sha256,
    };
  };
  function list(filters: DecisionListFilters, selection: "summary"): DecisionProjectionListRead<DecisionListSummaryRow>;
  function list(filters: DecisionListFilters, selection?: "review"): DecisionProjectionListRead;
  function list(
    filters: DecisionListFilters,
    selection?: "summary" | "review",
  ): DecisionProjectionListRead<DecisionListSummaryRow> {
    return selection === "summary"
      ? options.projection.listDecisions(filters, selection)
      : options.projection.listDecisions(filters, selection);
  }
  const show = (selector: string) => {
      const legacy = /^E[1-9][0-9]*$/u.test(selector),
        matches = legacy ? list({ legacyId: selector }, "summary") : null;
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
    coverage = (decisionId: string) => {
      const read = options.projection.readDecisionCoverage([decisionId]);
      if (read.status !== "ready")
        throw new FactServiceError(
          "content_not_ready",
          `Decision coverage is pending at revision ${read.watermark}/${read.sourceRevision}.`,
        );
      return read;
    };
  return Object.freeze({ record, show, list, coverage });
}
