// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DispatchStreamHeader } from "../src/dispatch-stream.ts";
import { runtimeDispatchEdges } from "../src/task-query-read.ts";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import { validateDaemonRelationGraph } from "../src/protocol/daemon-protocol-validate-projections.ts";

/**
 * `repo.triadic.relationGraph {facet:"runtimeEdges"}`(task_5ba031c2)。
 * 台账没有 runtime↔task 的关系事件,唯一同记录携带 agent 与 task 的是 dispatch 流头;
 * 这里锁三件事:派生纯函数、切面经协议校验、payload 只收 `facet` 一个选择器。
 */

const header = (overrides: Partial<DispatchStreamHeader>): DispatchStreamHeader =>
  ({
    schema: "runtime-dispatch-stream/v1",
    kind: "dispatch",
    dispatchId: "dispatch_000000000000000000000001",
    taskId: "task_a",
    executionId: "exe_a",
    runtimeSessionId: "runtime_a",
    instanceId: "inst",
    startedAt: "2026-08-29T00:00:00.000Z",
    eventStreamRef: "file:.harness/runtime/dispatches/x.jsonl",
    ...overrides,
  }) as DispatchStreamHeader;

test("runtimeDispatchEdges:同一 (agent, task) 只出一条边,agent/task 缺一不可", () => {
  const edges = runtimeDispatchEdges([
    header({ dispatchId: "dispatch_000000000000000000000001", agentId: "luna", taskId: "task_a" }),
    header({ dispatchId: "dispatch_000000000000000000000002", agentId: "luna", taskId: "task_a" }),
    header({ dispatchId: "dispatch_000000000000000000000003", agentId: "luna", taskId: "task_b" }),
    header({ dispatchId: "dispatch_000000000000000000000004", agentId: "sol", taskId: "task_a" }),
    // 无 agent(人工/实例直派)与无 task(schedule 的 agent 派发)都不产 task 边。
    header({ dispatchId: "dispatch_000000000000000000000005", taskId: "task_a" }),
    header({ dispatchId: "dispatch_000000000000000000000006", agentId: "e2e-probe", taskId: null }),
  ]);
  assert.deepEqual(edges.map(({ sourceRef, targetRef }) => `${sourceRef} -> ${targetRef}`).sort(), [
    "agent/luna -> task/task_a",
    "agent/luna -> task/task_b",
    "agent/sol -> task/task_a",
  ]);
  for (const edge of edges) {
    assert.equal(edge.relationType, "dispatches");
    assert.equal(edge.direction, "directed");
    assert.equal(edge.state, "active");
    assert.equal(edge.origin, "generated");
    assert.match(edge.sourcePath, /^\.harness\/runtime\/dispatches\/dispatch_[a-f0-9]{24}\.jsonl$/u);
  }
  // relationId 由端点派生:同一对端点稳定同一 id(幂等,不随 dispatch 条数膨胀)。
  assert.equal(new Set(edges.map(({ relationId }) => relationId)).size, edges.length);
});

test("runtimeEdges 切面结果经协议校验(与既有 facet 同形)", () => {
  const edges = runtimeDispatchEdges([header({ agentId: "luna", taskId: "task_a" })]);
  assert.deepEqual(
    validateDaemonRelationGraph({
      ok: true,
      facet: "runtimeEdges",
      edges,
      coverageRows: [],
      factAnchors: [],
      facts: [],
      warnings: [],
    }),
    [],
  );
  // 非法 relation 行依旧被拒(fail-closed)。
  assert.notDeepEqual(
    validateDaemonRelationGraph({
      ok: true,
      facet: "runtimeEdges",
      edges: [{ ...edges[0]!, sourceRef: "" }],
      coverageRows: [],
      factAnchors: [],
      facts: [],
      warnings: [],
    }),
    [],
  );
});

test("runtimeEdges payload 只收 facet,选择器(edges 专属)被拒", () => {
  const params = (payload: Record<string, unknown>) =>
    parseDaemonRpcParams("repo.triadic.relationGraph", { repo: { repoId: "alpha" }, payload });
  assert.equal(params({ facet: "runtimeEdges" }).ok, true);
  assert.equal(params({ facet: "runtimeEdges", state: "active" }).ok, false);
  assert.equal(params({ facet: "runtimeEdges", relationType: "dispatches" }).ok, false);
});
