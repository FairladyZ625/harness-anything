// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  applyCollaborationFilters,
  assignmentStateOf,
  collaborationFilterOptions,
  hasCollaborationFilters,
  leaseNodeIdOf,
  leaseRuntimeSessionIdOf,
  NO_COLLABORATION_FILTERS,
  type CollaborationTask,
} from "../src/renderer/model/collaboration.ts";

/** 协作视图的行输入:只带模型消费的字段,board.rank 手工给定(排序断言要可控)。 */
function task(
  taskId: string,
  fields: Partial<
    Pick<
      CollaborationTask,
      "assignment" | "leaseActor" | "leaseSource" | "leasePhase" | "leaseExpiresAt" | "board" | "lastKnownAt"
    >
  > = {},
): CollaborationTask {
  return {
    taskId,
    title: taskId,
    lastKnownAt: "2026-10-01T00:00:00.000Z",
    coordinationStatus: "active",
    board: { columnId: "open", rank: 3 },
    ...fields,
  };
}

const PERSON_LEASE = { principal: { personId: "person_zeyu" }, executor: null };
const AGENT_LEASE = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "runtime-session:runtime_a520047968e6" },
};

describe("assignmentStateOf(资格侧,不判执行)", () => {
  it("无指派 / 在期 / 期限已过三态只看 assignment.expiresAt", () => {
    expect(assignmentStateOf(task("a"), "2026-10-01T00:00:00Z")).toBe("none");
    expect(
      assignmentStateOf(
        task("b", {
          assignment: { assignee: { kind: "person", personId: "person_x" }, expiresAt: "2026-10-02T00:00:00Z" },
        }),
        "2026-10-01T00:00:00Z",
      ),
    ).toBe("assigned");
    expect(
      assignmentStateOf(
        task("c", { assignment: { assignee: { kind: "team", teamId: "team-1" }, expiresAt: "2026-09-30T00:00:00Z" } }),
        "2026-10-01T00:00:00Z",
      ),
    ).toBe("expired");
  });

  it("指派过期与 lease 并存时两侧独立:资格=expired,lease 字段原样在", () => {
    const leased = task("d", {
      assignment: { assignee: { kind: "person", personId: "person_x" }, expiresAt: "2026-09-30T00:00:00Z" },
      leaseActor: PERSON_LEASE,
      leasePhase: "held",
      leaseExpiresAt: "2026-10-05T00:00:00Z",
    });
    expect(assignmentStateOf(leased, "2026-10-01T00:00:00Z")).toBe("expired");
    expect(leased.leasePhase).toBe("held");
  });
});

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
});

describe("collaborationFilterOptions(按实际数据提供筛选)", () => {
  const tasks = [
    task("assigned-and-held", {
      assignment: {
        assignee: { kind: "person", personId: "person_ana", nodeId: "edge-a" },
        expiresAt: "2026-10-02T00:00:00Z",
      },
      leaseActor: AGENT_LEASE,
      leaseSource: { kind: "node", nodeId: "edge-b" },
      leasePhase: "held",
    }),
    task("team-assigned", {
      assignment: { assignee: { kind: "team", teamId: "team-1" }, expiresAt: "2026-10-02T00:00:00Z" },
    }),
    task("released-lease-node", {
      leaseActor: PERSON_LEASE,
      leaseSource: { kind: "node", nodeId: "edge-b" },
      leasePhase: "released",
    }),
  ];

  it("人维度合并指派人与 lease principal;工作组不进人维度", () => {
    const { persons } = collaborationFilterOptions(tasks);
    expect(persons.map(({ id }) => id)).toEqual(["person_zeyu", "person_ana"]);
    expect(persons[0]?.count).toBe(2); // held + released 两条 lease 的 principal
  });

  it("Agent 维度只在有 executor 时出现", () => {
    const { agents } = collaborationFilterOptions(tasks);
    expect(agents).toEqual([{ id: "runtime-session:runtime_a520047968e6", count: 1 }]);
  });

  it("节点汇总:executing 只计 held/reserving,assigned 来自指派 nodeId", () => {
    const { nodes } = collaborationFilterOptions(tasks);
    expect(nodes).toContainEqual({ nodeId: "edge-b", executing: 1, assigned: 0 });
    expect(nodes).toContainEqual({ nodeId: "edge-a", executing: 0, assigned: 1 });
  });

  it("无 lease 无指派的任务不产生任何筛选维度条目", () => {
    expect(collaborationFilterOptions([task("bare")])).toEqual({ persons: [], agents: [], nodes: [] });
  });
});

describe("applyCollaborationFilters", () => {
  const tasks = [
    task("held", {
      leaseActor: AGENT_LEASE,
      leaseSource: { kind: "node", nodeId: "edge-b" },
      leasePhase: "held",
      board: { columnId: "open", rank: 2 },
    }),
    task("assigned-only", {
      assignment: { assignee: { kind: "person", personId: "person_ana" }, expiresAt: "2026-10-02T00:00:00Z" },
      board: { columnId: "open", rank: 3 },
    }),
    task("plain", { board: { columnId: "open", rank: 3 }, lastKnownAt: "2026-09-01T00:00:00.000Z" }),
  ];

  it("无筛选:按 board.rank 升序,同 rank 内 lastKnownAt 倒序", () => {
    expect(applyCollaborationFilters(tasks, NO_COLLABORATION_FILTERS).map(({ taskId }) => taskId)).toEqual([
      "held",
      "assigned-only",
      "plain",
    ]);
    expect(hasCollaborationFilters(NO_COLLABORATION_FILTERS)).toBe(false);
  });

  it("人筛选取指派人或 lease principal 任一命中", () => {
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, person: "person_ana" }).map((t) => t.taskId),
    ).toEqual(["assigned-only"]);
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, person: "person_zeyu" }).map((t) => t.taskId),
    ).toEqual(["held"]);
  });

  it("Agent 与节点筛选只认结构字段(lease executor / 来源节点或指派节点)", () => {
    expect(
      applyCollaborationFilters(tasks, {
        ...NO_COLLABORATION_FILTERS,
        agent: "runtime-session:runtime_a520047968e6",
      }).map((t) => t.taskId),
    ).toEqual(["held"]);
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, node: "edge-b" }).map((t) => t.taskId),
    ).toEqual(["held"]);
  });

  it("维度叠加为交集", () => {
    expect(
      applyCollaborationFilters(tasks, {
        person: "person_zeyu",
        agent: "runtime-session:runtime_a520047968e6",
        node: "edge-b",
      }).map((t) => t.taskId),
    ).toEqual(["held"]);
    expect(applyCollaborationFilters(tasks, { person: "person_ana", node: "edge-b" })).toEqual([]);
  });
});
