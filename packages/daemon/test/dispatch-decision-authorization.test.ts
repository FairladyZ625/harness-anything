// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { assembleTaskCausalContext, CAUSAL_CONTEXT_MAX_BYTES } from "../src/dispatch-causal-context.ts";
import { explicitPromptMission } from "../src/runtime-spawn-mission.ts";

const cut = { status: "ready", watermark: 7, sourceRevision: 7 } as const;
const heading = "# 本任务授权范围 / Decision-Derived Execution Surface";
function fixture(states: string[] = ["in_effect"], relationState = "active", anchor = "CH1"): TaskProjection {
  return {
    readCut: () => cut,
    readTaskIndex: () => ({ ...cut, rows: [] }),
    readTaskRelationsByTargets: () => ({
      ...cut,
      rows: states.map((_, index) => ({
        sourceRef: `decision/dec_${index}/${anchor}`,
        targetRef: "task/task_leaf",
        state: relationState,
        direction: "directed",
      })),
    }),
    readDecisions: () => ({
      ...cut,
      decisions: states.map((state, index) => ({
        decisionId: `dec_${index}`,
        state,
        title: `Current contract ${index}`,
        question: "",
        chosen: [{ id: "CH1", text: "Replace the owner-person binding", rationale: "Independent machine identity" }],
        claims: [{ id: "C1", text: "Preserve authenticated provenance", loadBearing: true }],
      })),
    }),
    readRelationQuery: () => ({ ...cut, rows: [] }),
    searchFacts: () => ({ ...cut, facts: [] }),
  } as unknown as TaskProjection;
}

test("an in-effect deriving chosen decision grants a bounded surface in the actual mission", () => {
  const context = assembleTaskCausalContext({ projection: fixture(), taskId: "task_leaf" });
  assert.ok(context);
  const mission = explicitPromptMission("task_leaf", context, "Implement the contract.");
  assert.ok(mission.includes(heading));
  assert.match(mission, /decision\/dec_0\/CH1.*state=in_effect/u);
  assert.match(mission, /Current contract 0/u);
  assert.match(mission, /Replace the owner-person binding/u);
  assert.match(mission, /C1 Preserve authenticated provenance/u);
  assert.match(mission, /closeout 和 PR 治理声明.*引用决策 id.*保留并补齐负例/su);
  assert.doesNotMatch(mission, /硬红线|Hard prohibitions|remain prohibited/u);
  assert.match(mission, /没有决策依据的写明‘需要业主授权’/u);
  assert.match(mission, /凭据、宿主服务、对外发布.*未经明确授权就停手/u);
  assert.match(mission, /grants no additional daemon command or ledger permissions/u);
  assert.match(mission, /决策条款写到的面按条款做/u);
  assert.ok(mission.endsWith("Implement the contract."));
  const xml = context.slice(0, context.indexOf("</task-context>") + "</task-context>".length);
  assert.ok(Buffer.byteLength(xml) <= CAUSAL_CONTEXT_MAX_BYTES);
});

test("no deriving decision leaves the mission without an authorization section", () => {
  const context = assembleTaskCausalContext({ projection: fixture([]), taskId: "task_leaf" });
  assert.equal(context, null);
  assert.ok(!explicitPromptMission("task_leaf", context, "Go.").includes(heading));
});

for (const state of ["proposed", "superseded", "outcome_retired", "deferred", "rejected"])
  test(`${state} decisions retain background but grant no execution surface`, () => {
    const context = assembleTaskCausalContext({ projection: fixture([state]), taskId: "task_leaf" });
    assert.ok(context?.includes("decision/dec_0"));
    assert.ok(!context.includes(heading));
  });

for (const [state, anchor] of [
  ["retired", "CH1"],
  ["active", "C1"],
  ["active", "CH-missing"],
])
  test(`relation ${state}/${anchor} cannot grant authorization`, () => {
    const context = assembleTaskCausalContext({
      projection: fixture(["in_effect"], state, anchor),
      taskId: "task_leaf",
    });
    assert.ok(!context?.includes(heading));
  });

test("next dispatch removes a superseded decision's grant at the new center cut", () => {
  const states = ["in_effect"],
    projection = fixture(states);
  assert.ok(assembleTaskCausalContext({ projection, taskId: "task_leaf" })?.includes(heading));
  states[0] = "superseded";
  assert.ok(!assembleTaskCausalContext({ projection, taskId: "task_leaf" })?.includes(heading));
});

test("authorization does not inherit the background's two-decision truncation", () => {
  const context = assembleTaskCausalContext({
    projection: fixture(["superseded", "proposed", "in_effect"]),
    taskId: "task_leaf",
  });
  assert.ok(context?.includes(heading));
  assert.match(context.slice(context.indexOf(heading)), /decision\/dec_2\/CH1.*state=in_effect/u);
  assert.doesNotMatch(context.slice(context.indexOf(heading)), /decision\/dec_[01]\/CH1/u);
});
