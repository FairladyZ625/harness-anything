// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { endpointToNodeId, parseEndpoint } from "../src/renderer/graph/endpoint.ts";
import {
  agentNodeRowOf,
  scheduleNodeRowOf,
  scheduleTargetEdges,
  withAgentTaskCounts,
  type ScheduleNodeRow,
} from "../src/renderer/graph/runtimeEntities.ts";
import { buildEgoGraph, bfsShownFromFocus } from "../src/renderer/graph/egoCanvas.ts";
// 修复:EGO_DEFAULT_HOPS 一直住在 useEgoCanvas,此前从 egoCanvas import 得到 undefined,
// 这些用例靠「undefined = 无上限」在小夹具上碰巧全量可达而通过。
import { EGO_DEFAULT_HOPS } from "../src/renderer/graph/useEgoCanvas.ts";
import { partitionAll, partitionAgents, partitionSchedules } from "../src/renderer/graph/territory.ts";
import type { AgentEntityGuiRow } from "../../../../daemon/src/agent-entities.ts";
import type { ScheduleGuiRowDto } from "../../../../daemon/src/protocol/schedules-gui-contract.ts";
import { taskProjectionFields } from "./task-projection-fields.ts";

/**
 * 多实体扩展(task_5ba031c2):EntityKind 扩到五种,agent/schedule 在领地各占一块,
 * 聚光灯能以 agent/schedule 为焦点展开邻域(schedule→target agent→被派 task)。
 */

function task(taskId: string): TaskRow {
  return {
    taskId,
    title: `任务 ${taskId}`,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "gui",
    lastKnownAt: "2026-08-29T00:00:00.000Z",
    gates: [],
    docs: [],
    ...taskProjectionFields("active"),
  } as TaskRow;
}

const agentRow = (id: string): AgentEntityGuiRow => ({
  id,
  name: `Agent ${id}`,
  runtimeType: "codex",
  role: "worker",
  layer: "identity",
  validity: "valid",
  issues: [],
});

const scheduleRow = (scheduleId: string, agentId: string | null): ScheduleGuiRowDto =>
  ({
    scheduleId,
    name: `Schedule ${scheduleId}`,
    state: "armed",
    mode: "detect",
    definitionResidency: "ledger",
    definitionRevision: 1,
    trigger: { kind: "interval", everyMs: 3_600_000, expression: null, timezone: null, summary: "every 1h" },
    target:
      agentId === null
        ? { kind: "squad", squadId: "squad-x" }
        : { kind: "agent", agentId, runtimeInstanceId: "inst", model: null, reasoningEffort: null, cwd: null },
    mission: "m",
    executionAvailability: "local",
    claim: { nodeId: "local", assignmentId: null },
    nextRunAt: null,
    actions: {},
    activeRun: null,
    lastRun: null,
    missed: { count: 0, lastMissedAt: null, lastMissedReason: null },
    automaticEvaluatedThrough: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
  }) as unknown as ScheduleGuiRowDto;

describe("parseEndpoint / endpointToNodeId 认五种实体", () => {
  it("五种前缀各自归一", () => {
    expect(parseEndpoint("decision/dec_abc/CH1")).toEqual({ id: "decision/dec_abc", entity: "decision" });
    expect(parseEndpoint("fact/F-abc")).toEqual({ id: "fact/F-abc", entity: "fact" });
    expect(parseEndpoint("task/task_abc/x")).toEqual({ id: "task_abc", entity: "task" });
    expect(parseEndpoint("agent/luna")).toEqual({ id: "agent/luna", entity: "agent" });
    expect(parseEndpoint("schedule/antientropy-sweep")).toEqual({
      id: "schedule/antientropy-sweep",
      entity: "schedule",
    });
    expect(parseEndpoint("runtime/runtime_abc")).toBeNull();
  });

  it("endpointToNodeId 与 parseEndpoint 的键空间一致(ego 节点 id 对齐)", () => {
    for (const ref of ["decision/dec_abc/CH1", "fact/F-abc", "task/task_abc", "agent/luna", "schedule/sweep"]) {
      expect(endpointToNodeId(ref)).toBe(parseEndpoint(ref)!.id);
    }
  });
});

describe("runtime 行适配(复用 Agent/Schedule 入口的 DTO,不新造读)", () => {
  it("agent 行 → 图节点行,taskCount 由派发边补齐", () => {
    const agents = [agentNodeRowOf(agentRow("luna")), agentNodeRowOf(agentRow("sol"))];
    const relations = [
      { from: "agent/luna", to: "task/t1", kind: "dispatches", provenance: "local-document" },
      { from: "agent/luna", to: "task/t2", kind: "dispatches", provenance: "local-document" },
      { from: "agent/sol", to: "task/t1", kind: "dispatches", provenance: "local-document" },
    ] as RelationEdge[];
    const counted = withAgentTaskCounts(agents, relations);
    expect(counted.map((agent) => [agent.id, agent.taskCount])).toEqual([
      ["agent/luna", 2],
      ["agent/sol", 1],
    ]);
  });

  it("schedule 行带 target agent;squad target 为 null", () => {
    const agent = scheduleNodeRowOf(scheduleRow("sweep", "luna"));
    const squad = scheduleNodeRowOf(scheduleRow("swarm", null));
    expect(agent.id).toBe("schedule/sweep");
    expect(agent.targetAgentId).toBe("luna");
    expect(squad.targetAgentId).toBeNull();
    // 派生边只给声明了 agent target 的 schedule。
    expect(scheduleTargetEdges([agent, squad])).toEqual([
      {
        from: "schedule/sweep",
        to: "agent/luna",
        kind: "dispatches",
        provenance: "local-document",
        rationale: "Schedule 声明的 target",
      },
    ]);
  });
});

describe("ego 图:agent/schedule 为焦点", () => {
  const tasks = [task("t1"), task("t2")];
  const decisions: DecisionRow[] = [];
  const facts: FactRef[] = [];
  const schedules = [scheduleNodeRowOf(scheduleRow("sweep", "luna"))];
  const agents = [agentNodeRowOf(agentRow("luna"))];
  // agent→task 边来自 daemon runtimeEdges 切面;schedule→agent 是派生边。
  const runtimeEdges = [
    { from: "agent/luna", to: "task/t1", kind: "dispatches", provenance: "local-document" },
    { from: "agent/luna", to: "task/t2", kind: "dispatches", provenance: "local-document" },
  ] as RelationEdge[];
  const axes = { authority: true, evidence: true, execution: true, assoc: false };

  it("以 agent 为焦点:被派的 task 都在一跳内", () => {
    const graph = buildEgoGraph(tasks, decisions, facts, runtimeEdges, [], { agents, schedules });
    expect(graph.byId.get("agent/luna")?.entity).toBe("agent");
    const shown = bfsShownFromFocus(graph, "agent/luna", EGO_DEFAULT_HOPS, axes);
    // 派它的 schedule 经合成边(schedule→agent)也在两跳内 —— 同一条邻域真相。
    expect([...shown.keys()].sort()).toEqual(["agent/luna", "schedule/sweep", "t1", "t2"]);
  });

  it("以 schedule 为焦点:target agent 一跳、被派 task 两跳(±2 跳内可见)", () => {
    const graph = buildEgoGraph(tasks, decisions, facts, runtimeEdges, [], { agents, schedules });
    const shown = bfsShownFromFocus(graph, "schedule/sweep", EGO_DEFAULT_HOPS, axes);
    expect(shown.get("agent/luna")).toBe(1);
    expect(shown.get("t1")).toBe(2);
    expect(shown.get("t2")).toBe(2);
  });

  it("schedule→agent 派生边登记为合成边,不进 relations", () => {
    const graph = buildEgoGraph(tasks, decisions, facts, runtimeEdges, [], { agents, schedules });
    expect(graph.synthEdges.map(({ key }) => key)).toEqual(["sched_schedule/sweep"]);
  });

  it("agent 行缺席时指向它的派发边被跳过,不造节点", () => {
    const graph = buildEgoGraph(tasks, decisions, facts, runtimeEdges, [], { agents: [], schedules });
    expect(graph.byId.has("agent/luna")).toBe(false);
    const shown = bfsShownFromFocus(graph, "t1", EGO_DEFAULT_HOPS, axes);
    expect([...shown.keys()]).toEqual(["t1"]);
  });
});

describe("领地:agent/schedule 各一块", () => {
  it("partitionAgents / partitionSchedules 只在非空时产块,chip 可点进聚光灯", () => {
    const agents = [agentNodeRowOf(agentRow("luna"))];
    const schedules = [scheduleNodeRowOf(scheduleRow("sweep", "luna"))];
    expect(partitionAgents([])).toEqual([]);
    expect(partitionSchedules([])).toEqual([]);
    expect(partitionAgents(agents)[0]!.chips[0]).toMatchObject({ navRef: "agent/luna", entity: "agent" });
    expect(partitionSchedules(schedules)[0]!.chips[0]).toMatchObject({
      navRef: "schedule/sweep",
      entity: "schedule",
    });
  });

  it("partitionAll(unified)包含运行时两块", () => {
    const partition = partitionAll(
      [task("t1")],
      [],
      [],
      [],
      [],
      [agentNodeRowOf(agentRow("luna"))],
      [scheduleNodeRowOf(scheduleRow("sweep", "luna"))],
    );
    expect(partition.zones.map((zone) => zone.entity)).toContain("agent");
    expect(partition.zones.map((zone) => zone.entity)).toContain("schedule");
  });

  it("squad target 的 schedule 仍成块(它只是没有 agent 邻居)", () => {
    const schedules: ScheduleNodeRow[] = [scheduleNodeRowOf(scheduleRow("swarm", null))];
    expect(partitionSchedules(schedules)[0]!.chips[0]!.navRef).toBe("schedule/swarm");
  });
});
