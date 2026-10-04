// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  agentIndexOfSessionGroups,
  applyCollaborationFilters,
  assignmentStateOf,
  collaborationFilterOptions,
  EMPTY_SESSION_AGENT_INDEX,
  hasCollaborationFilters,
  isExecutingLeasePhase,
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
const PERSON_LEASE_X = { principal: { personId: "person_x" }, executor: null };
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

  it("Agent 维度只在索引映射上执行会话时出现(空索引=维度缺席)", () => {
    const { agents } = collaborationFilterOptions(tasks);
    expect(agents).toEqual([]);
    expect(collaborationFilterOptions(tasks, EMPTY_SESSION_AGENT_INDEX).agents).toEqual([]);
  });

  it("节点汇总:count 是筛选命中数(lease 节点或指派节点),executing 只计 held/reserving,assigned 来自指派 nodeId", () => {
    const { nodes } = collaborationFilterOptions(tasks);
    expect(nodes).toContainEqual({ nodeId: "edge-b", count: 2, executing: 1, assigned: 0 });
    expect(nodes).toContainEqual({ nodeId: "edge-a", count: 1, executing: 0, assigned: 1 });
  });

  it("无 lease 无指派的任务不产生任何筛选维度条目", () => {
    expect(collaborationFilterOptions([task("bare")])).toEqual({ persons: [], agents: [], nodes: [] });
  });
});

describe("review be577 四个反例的修后行为", () => {
  it("同一 task 的指派人与 lease principal 是同一人:计数只计一次,跨 task 才累加", () => {
    const samePersonTwiceInOneTask = collaborationFilterOptions([
      task("both", {
        assignment: { assignee: { kind: "person", personId: "person_x" }, expiresAt: "2026-10-02T00:00:00Z" },
        leaseActor: PERSON_LEASE_X,
        leasePhase: "held",
      }),
    ]);
    expect(samePersonTwiceInOneTask.persons).toEqual([{ id: "person_x", count: 1 }]);

    const acrossTasks = collaborationFilterOptions([
      task("assigned", {
        assignment: { assignee: { kind: "person", personId: "person_x" }, expiresAt: "2026-10-02T00:00:00Z" },
      }),
      task("executing", { leaseActor: PERSON_LEASE_X, leasePhase: "held" }),
    ]);
    expect(acrossTasks.persons).toEqual([{ id: "person_x", count: 2 }]);
  });

  it("仅有指派的节点:count 照常计数,executing 为 0,不再出现 0 却筛出任务", () => {
    const { nodes } = collaborationFilterOptions([
      task("assigned-1", {
        assignment: {
          assignee: { kind: "person", personId: "person_ana", nodeId: "edge-x" },
          expiresAt: "2026-10-02T00:00:00Z",
        },
      }),
      task("assigned-2", {
        assignment: {
          assignee: { kind: "person", personId: "person_bob", nodeId: "edge-x" },
          expiresAt: "2026-10-02T00:00:00Z",
        },
      }),
    ]);
    expect(nodes).toEqual([{ nodeId: "edge-x", count: 2, executing: 0, assigned: 2 }]);
    expect(
      applyCollaborationFilters(
        [
          task("assigned-1", {
            assignment: {
              assignee: { kind: "person", personId: "person_ana", nodeId: "edge-x" },
              expiresAt: "2026-10-02T00:00:00Z",
            },
          }),
          task("assigned-2", {
            assignment: {
              assignee: { kind: "person", personId: "person_bob", nodeId: "edge-x" },
              expiresAt: "2026-10-02T00:00:00Z",
            },
          }),
        ],
        { ...NO_COLLABORATION_FILTERS, node: "edge-x" },
      ),
    ).toHaveLength(2);
  });

  it("orphaned/held/reserving 区别:执行中只认 phase,orphaned/released 的持有人不计执行中", () => {
    expect(isExecutingLeasePhase("held")).toBe(true);
    expect(isExecutingLeasePhase("reserving")).toBe(true);
    expect(isExecutingLeasePhase("orphaned")).toBe(false);
    expect(isExecutingLeasePhase("released")).toBe(false);
    expect(isExecutingLeasePhase(undefined)).toBe(false);

    const { nodes } = collaborationFilterOptions([
      task("orphaned-node", {
        leaseActor: AGENT_LEASE,
        leaseSource: { kind: "node", nodeId: "edge-orphan" },
        leasePhase: "orphaned",
      }),
      task("held-node", {
        leaseActor: AGENT_LEASE,
        leaseSource: { kind: "node", nodeId: "edge-live" },
        leasePhase: "held",
      }),
    ]);
    expect(nodes).toContainEqual({ nodeId: "edge-orphan", count: 1, executing: 0, assigned: 0 });
    expect(nodes).toContainEqual({ nodeId: "edge-live", count: 1, executing: 1, assigned: 0 });
  });

  it("同 Agent 多会话聚合:两个 task 各持不同会话但索引同指一个 agentId,收进同一筛选值", () => {
    const index = agentIndexOfSessionGroups({
      sessionAgents: [
        { runtimeSessionId: "runtime_aaa", agentId: "glm", label: "GLM-5.3" },
        { runtimeSessionId: "runtime_bbb", agentId: "glm", label: "GLM-5.3" },
      ],
    });
    expect([...index.agentOfSession]).toEqual([
      ["runtime_aaa", { agentId: "glm", label: "GLM-5.3" }],
      ["runtime_bbb", { agentId: "glm", label: "GLM-5.3" }],
    ]);

    const tasks = [
      task("session-a", {
        leaseActor: {
          principal: { personId: "person_zeyu" },
          executor: { kind: "agent", id: "runtime-session:runtime_aaa" },
        },
        leasePhase: "held",
      }),
      task("session-aaa-same-agent", {
        leaseActor: {
          principal: { personId: "person_zeyu" },
          executor: { kind: "agent", id: "runtime-session:runtime_bbb" },
        },
        leasePhase: "held",
      }),
    ];
    const { agents, persons } = collaborationFilterOptions(tasks, index);
    // 两个不同在飞会话属于同一 Agent,两个 task 分别计一票。
    expect(agents).toEqual([{ id: "glm", label: "GLM-5.3", count: 2 }]);
    expect(persons).toEqual([{ id: "person_zeyu", count: 2 }]);
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, agent: "glm" }, index).map((t) => t.taskId),
    ).toEqual(["session-a", "session-aaa-same-agent"]);
  });

  it("无声明的 bare runtime 不产生 Agent 条目,不从会话或实例名猜", () => {
    const index = agentIndexOfSessionGroups({
      sessionAgents: [{ runtimeSessionId: "runtime_glm", agentId: "glm", label: "GLM-5.3" }],
    });
    // 只有事件里带 agentId 的在飞会话进映射。
    expect([...index.agentOfSession.keys()]).toEqual(["runtime_glm"]);

    const tasks = [
      task("unmapped", {
        leaseActor: {
          principal: { personId: "person_zeyu" },
          executor: { kind: "agent", id: "runtime-session:runtime_direct" },
        },
        leasePhase: "held",
      }),
      task("mapped", {
        leaseActor: {
          principal: { personId: "person_zeyu" },
          executor: { kind: "agent", id: "runtime-session:runtime_glm" },
        },
        leasePhase: "held",
      }),
    ];
    const { agents } = collaborationFilterOptions(tasks, index);
    expect(agents).toEqual([{ id: "glm", label: "GLM-5.3", count: 1 }]);
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, agent: "glm" }, index).map((t) => t.taskId),
    ).toEqual(["mapped"]);
  });

  it("计数不变量:每个维度值的 count 严格等于该维度单独筛选命中的 task 数", () => {
    const index = agentIndexOfSessionGroups({
      sessionAgents: [
        { runtimeSessionId: "runtime_aaa", agentId: "glm", label: "GLM-5.3" },
        { runtimeSessionId: "runtime_bbb", agentId: "astra", label: "Astra" },
      ],
    });
    const mixed = [
      task("t1", {
        assignment: {
          assignee: { kind: "person", personId: "person_x", nodeId: "edge-x" },
          expiresAt: "2026-10-02T00:00:00Z",
        },
        leaseActor: {
          principal: { personId: "person_x" },
          executor: { kind: "agent", id: "runtime-session:runtime_aaa" },
        },
        leaseSource: { kind: "node", nodeId: "edge-x" },
        leasePhase: "held",
      }),
      task("t2", {
        assignment: { assignee: { kind: "person", personId: "person_x" }, expiresAt: "2026-10-02T00:00:00Z" },
        leaseActor: {
          principal: { personId: "person_y" },
          executor: { kind: "agent", id: "runtime-session:runtime_bbb" },
        },
        leaseSource: { kind: "node", nodeId: "edge-y" },
        leasePhase: "orphaned",
      }),
      task("t3", {
        leaseActor: { principal: { personId: "person_y" }, executor: null },
        leaseSource: { kind: "node", nodeId: "edge-x" },
        leasePhase: "released",
      }),
      task("t4", {
        assignment: { assignee: { kind: "team", teamId: "team-1" }, expiresAt: "2026-10-02T00:00:00Z" },
      }),
    ];
    const options = collaborationFilterOptions(mixed, index);
    for (const { id, count } of options.persons) {
      expect(applyCollaborationFilters(mixed, { ...NO_COLLABORATION_FILTERS, person: id }, index)).toHaveLength(count);
    }
    for (const { id, count } of options.agents) {
      expect(applyCollaborationFilters(mixed, { ...NO_COLLABORATION_FILTERS, agent: id }, index)).toHaveLength(count);
    }
    for (const { nodeId, count } of options.nodes) {
      expect(applyCollaborationFilters(mixed, { ...NO_COLLABORATION_FILTERS, node: nodeId }, index)).toHaveLength(
        count,
      );
    }
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

  it("会话与节点筛选只认结构字段(lease executor / 来源节点或指派节点)", () => {
    expect(
      applyCollaborationFilters(tasks, { ...NO_COLLABORATION_FILTERS, node: "edge-b" }).map((t) => t.taskId),
    ).toEqual(["held"]);
  });

  it("维度叠加为交集", () => {
    expect(
      applyCollaborationFilters(tasks, {
        person: "person_zeyu",
        node: "edge-b",
      }).map((t) => t.taskId),
    ).toEqual(["held"]);
    expect(applyCollaborationFilters(tasks, { person: "person_ana", node: "edge-b" })).toEqual([]);
  });
});
