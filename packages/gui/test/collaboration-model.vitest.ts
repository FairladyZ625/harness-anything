// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { isExecutingLeasePhase, leaseNodeIdOf, leaseRuntimeSessionIdOf } from "../src/renderer/model/collaboration.ts";

const PERSON_LEASE = { principal: { personId: "person_zeyu" }, executor: null };
const AGENT_LEASE = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "runtime-session:runtime_a520047968e6" },
};

describe("lease 结构字段消费(不从显示串反解析)", () => {
  it("executor id 是 daemon 写侧 runtime-session:<id> 时剥出会话 id,其余格式与人工执行都无链接", () => {
    expect(leaseRuntimeSessionIdOf(AGENT_LEASE)).toBe("runtime_a520047968e6");
    expect(
      leaseRuntimeSessionIdOf({ principal: { personId: "p" }, executor: { kind: "agent", id: "codex-sol" } }),
    ).toBeNull();
    expect(leaseRuntimeSessionIdOf(PERSON_LEASE)).toBeNull();
    expect(leaseRuntimeSessionIdOf(undefined)).toBeNull();
  });

  it("节点只来自 node 来源;local/remote_direct 是通道词,不给节点", () => {
    expect(leaseNodeIdOf({ kind: "node", nodeId: "edge-mac" })).toBe("edge-mac");
    expect(leaseNodeIdOf("local")).toBeNull();
    expect(leaseNodeIdOf("remote_direct")).toBeNull();
    expect(leaseNodeIdOf(undefined)).toBeNull();
  });

  it("执行中只认 held/reserving;orphaned/released/缺失都不算", () => {
    expect(isExecutingLeasePhase("held")).toBe(true);
    expect(isExecutingLeasePhase("reserving")).toBe(true);
    expect(isExecutingLeasePhase("orphaned")).toBe(false);
    expect(isExecutingLeasePhase("released")).toBe(false);
    expect(isExecutingLeasePhase(undefined)).toBe(false);
  });
});
