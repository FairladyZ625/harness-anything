import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import {
  carrierSessionsForScope,
  liveSessionCountsByScope,
  runtimeInstanceScopeKey,
} from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";

const session = (runtimeSessionId: string, nodeId: string, instanceId = "codex-api"): AgentRuntimeSessionDto =>
  ({
    runtimeSessionId,
    nodeId,
    instanceId,
    lifecycle: { displayStatus: "running" },
  }) as unknown as AgentRuntimeSessionDto;

describe("Provider runtime node scope", () => {
  it("keeps same-named instances on different nodes in separate live buckets", () => {
    const counts = liveSessionCountsByScope(
      [session("session-a", "node-a"), session("session-b", "node-b"), session("session-a-2", "node-a")],
      "node-a",
    );

    expect(counts.get(runtimeInstanceScopeKey("node-a", "codex-api"))).toBe(2);
    expect(counts.get(runtimeInstanceScopeKey("node-b", "codex-api"))).toBeUndefined();
  });

  it("filters carrier sessions by both node and instance", () => {
    const sessions = [
      session("session-a", "node-a"),
      session("session-b", "node-b"),
      session("session-c", "node-a", "other"),
    ];

    const visible = carrierSessionsForScope(sessions, "node-a", "codex-api");
    expect(visible.map(({ runtimeSessionId }) => runtimeSessionId)).toEqual(["session-a"]);
  });
});
