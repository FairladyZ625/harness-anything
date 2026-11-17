import type { AgentRuntimeEventV1, CanonicalEventStore } from "@harness-anything/kernel";

/** The durable receipt for a published dispatch, also used when an idempotent request is replayed. */
export function runtimeSpawnReceipt(
  event: AgentRuntimeEventV1,
  publication: ReturnType<CanonicalEventStore["publication"]>,
  runtimeSessionId: string,
  dispatchId: string,
) {
  const revision = event.workspaceRevision,
    canonicalVisible = publication.cut.opId === event.opId && publication.cut.revision === revision,
    webSearch = event.type === "runtime_dispatch_requested" ? event.payload.definitionSnapshot.webSearch : undefined,
    mcpPolicy = event.type === "runtime_dispatch_requested" ? event.payload.definitionSnapshot.mcpPolicy : undefined,
    base = {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-spawn",
      opId: event.opId,
      runtimeSessionId,
      dispatchId,
      revision,
      ...(webSearch === undefined ? {} : { webSearch }),
      ...(mcpPolicy === undefined ? {} : { mcpPolicy }),
      evidence: `event-object:${event.opId}`,
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: publication.cut.revision,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: null,
      },
    };
  return canonicalVisible
    ? { ...base, outcome: "applied" as const }
    : {
        ...base,
        outcome: "pending" as const,
        guidance: [{ kind: "retry-receipt", args: { opId: event.opId } }],
      };
}
