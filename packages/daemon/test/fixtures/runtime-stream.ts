export function runtimeCursor(repoId: string, seq: number, streamEpoch = "fixture-epoch") {
  return { repoId, streamKind: "agent-runtime", streamEpoch, seq };
}

export const emptyRuntimeSnapshot = { activity: null, heartbeatAt: null, outcome: null, error: null };
export { makeAgentRuntimeStreamHub } from "../../src/daemon-host/agent-runtime-stream.ts";
