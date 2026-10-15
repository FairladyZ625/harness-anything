import {
  canonicalEventWritePlan,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type RuntimeSessionActionDraft,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";

export type RuntimeSessionEvent = RuntimeSessionActionDraft["event"];
export type RuntimeSessionBundle = CanonicalWriteBundle & { readonly event: RuntimeSessionEvent };
export interface RuntimeSessionNoChanges {
  readonly noChanges: true;
  readonly runtimeSessionId: string;
}

export function isRuntimeSessionBundle(bundle: CanonicalWriteBundle): bundle is RuntimeSessionBundle {
  return "event" in bundle && bundle.event.schema === "agent-runtime-event/v1";
}

export function compileRuntimeSessionDraft(
  draft: RuntimeSessionActionDraft,
): RuntimeSessionBundle | RuntimeSessionNoChanges {
  if (draft.noChanges) return { noChanges: true, runtimeSessionId: draft.event.payload.runtimeSessionId };
  const claim = draft.event.type === "runtime_session_outcome_observed" ? draft.event.payload.result : null;
  if (draft.event.type === "runtime_session_outcome_observed" && (!claim || draft.resultBody === undefined))
    rejectRuntimeSessionAction(
      "content_claim_required",
      "New runtime outcomes require a result content claim and bytes.",
    );
  return {
    event: draft.event,
    plan: canonicalEventWritePlan(draft.event, "agent-runtime/v1", draft.event.opId),
    blobs:
      claim && draft.resultBody !== undefined
        ? [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: draft.resultBody }]
        : [],
  };
}

export function commitRuntimeSessionBundle(
  store: CanonicalEventStore,
  projection: TaskProjection,
  bundle: RuntimeSessionBundle,
  authorizationDecision: AuthorizationDecision,
  afterAppend: () => void,
): WriteReceipt {
  const appended = store.append(bundle);
  projection.apply(bundle.event);
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
