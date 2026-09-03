import {
  canonicalEventWritePlan,
  runtimeSessionActionPayload,
  stableStringify,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type EntityActionContract,
  type RuntimeSessionActionDraft,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export type RuntimeSessionEvent = RuntimeSessionActionDraft["event"];
export type RuntimeSessionBundle = CanonicalWriteBundle & { readonly event: RuntimeSessionEvent };

export function isRuntimeSessionBundle(bundle: CanonicalWriteBundle): bundle is RuntimeSessionBundle {
  return bundle.event.schema === "agent-runtime-event/v1";
}

export function compileRuntimeSessionDraft(draft: RuntimeSessionActionDraft): RuntimeSessionBundle {
  const claim = draft.event.type === "runtime_session_outcome_observed" ? draft.event.payload.result : null;
  return {
    event: draft.event,
    plan: canonicalEventWritePlan(draft.event, "agent-runtime/v1", draft.event.opId),
    blobs:
      claim && draft.resultBody !== undefined
        ? [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: draft.resultBody }]
        : [],
  };
}

export function matchingRuntimeSessionReplayBundle(
  store: CanonicalEventStore,
  contract: EntityActionContract,
  action: RepoTaskAction,
  existing: NonNullable<ReturnType<CanonicalEventStore["readEvent"]>>,
): RuntimeSessionBundle {
  if (
    existing.schema !== "agent-runtime-event/v1" ||
    existing.type !== contract.id ||
    stableStringify(existing.payload) !==
      stableStringify(runtimeSessionActionPayload(contract.id as RuntimeSessionEvent["type"], action))
  )
    rejectRuntimeSessionAction(
      "op_conflict",
      `RuntimeSession opId ${existing.opId} belongs to another canonical event.`,
    );
  const event = existing as RuntimeSessionEvent,
    claim = event.type === "runtime_session_outcome_observed" ? event.payload.result : null,
    bytes = claim ? store.readContentBlob(claim.sha256) : null;
  if (claim && !bytes)
    rejectRuntimeSessionAction("content_not_ready", `Runtime result content ${claim.sha256} is unavailable.`);
  return {
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs:
      claim && bytes
        ? [
            {
              sha256: claim.sha256,
              size: claim.size,
              mediaType: claim.mediaType,
              body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            },
          ]
        : [],
  };
}

export function commitRuntimeSessionBundle(
  store: CanonicalEventStore,
  projection: TaskProjection,
  bundle: RuntimeSessionBundle,
  replay: boolean,
  authorizationDecision: AuthorizationDecision,
  afterAppend: () => void,
): WriteReceipt {
  const appended = store.append(bundle);
  if (!replay) projection.apply(bundle.event);
  afterAppend();
  const publication = store.publication(bundle.event),
    projected = projection.readRuntimeSession(bundle.event.payload.runtimeSessionId),
    visible =
      publication.cut.opId === bundle.event.opId &&
      publication.cut.revision === bundle.event.workspaceRevision &&
      projected !== null;
  return {
    outcome: visible ? "applied" : "pending",
    opId: bundle.event.opId,
    revision: appended.revision,
    evidence: JSON.stringify({
      schema: bundle.event.schema,
      eventId: bundle.event.eventId,
      eventType: bundle.event.type,
      runtimeSessionId: bundle.event.payload.runtimeSessionId,
      cut: appended.cut,
    }),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: publication.cut.revision,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: null,
    },
    authorizationDecision,
    event: bundle.event,
    runtimeSessionId: bundle.event.payload.runtimeSessionId,
  } as WriteReceipt;
}

function rejectRuntimeSessionAction(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
