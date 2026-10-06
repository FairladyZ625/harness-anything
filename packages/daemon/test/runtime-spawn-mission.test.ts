// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleScheduledMission,
  assembleTaskMission,
  explicitPromptMission,
  livingDeliverableProtocol,
  taskQueryGuidance,
} from "../src/runtime-spawn-mission.ts";

const daemonRoute = { userRoot: "/tmp/ha/user", daemonId: "default", endpoint: "/tmp/ha/user/daemon.sock" };

test("task-bound explicit prompts carry the lookup guidance and the Living Deliverable Protocol", () => {
  const mission = explicitPromptMission("task_x", null, "Finish the leaf task.", "baseline"),
    guidanceAt = mission.indexOf(taskQueryGuidance("task_x")),
    protocolAt = mission.indexOf(livingDeliverableProtocol("baseline")!),
    promptAt = mission.indexOf("Finish the leaf task.");
  assert.ok(guidanceAt >= 0, "lookup guidance rides the task-bound mission");
  assert.ok(protocolAt > guidanceAt, "the living deliverable protocol follows the guidance");
  assert.ok(promptAt > protocolAt, "the caller text stays last");
  assert.ok(mission.endsWith("Finish the leaf task."), "explicit caller text stays intact");
});

test("an injected causal block sits between the protocol and the caller text", () => {
  const xml = "<task-context>\n<refs>task/task_x</refs>\n</task-context>",
    mission = explicitPromptMission("task_x", xml, "Go.", "baseline");
  assert.ok(
    mission.indexOf(xml) > mission.indexOf(livingDeliverableProtocol("baseline")!),
    "protocol precedes the XML block",
  );
  assert.ok(mission.indexOf("Go.") > mission.indexOf(xml), "the XML block precedes the caller text");
});

test("lightweight tasks carry the guidance but never the Living Deliverable Protocol", () => {
  const mission = explicitPromptMission("task_x", null, "Finish the small change.", "lightweight");
  assert.match(mission, /# 台账查询引导/u, "the lookup guidance still rides a lightweight mission");
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(mission, /explainer\.html/u);
  assert.ok(mission.endsWith("Finish the small change."), "explicit caller text stays intact");
  assert.equal(livingDeliverableProtocol("lightweight"), null, "lightweight owes no explainer page");
});

test("a task with no profile metadata still gets the protocol", () => {
  // Legacy tasks frozen before profiles carried metadata: absence is not a lightweight opt-out.
  assert.notEqual(livingDeliverableProtocol(null), null);
  assert.notEqual(livingDeliverableProtocol(undefined), null);
  assert.match(explicitPromptMission("task_x", null, "Go."), /# Living Deliverable Protocol/u);
});

test("unbound prompts pass through without guidance or Living Deliverable Protocol", () => {
  const mission = explicitPromptMission(null, null, "Free-form prompt.", "baseline");
  assert.equal(mission, "Free-form prompt.");
  assert.doesNotMatch(mission, /# 台账查询引导/u);
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(mission, /explainer\.html/u);
});

test("scheduled missions never carry the task-bound protocol", () => {
  const mission = assembleScheduledMission({
    mission: "Detect drift in the fleet view.",
    repoId: "repo",
    workerRoot: "/tmp/ha/repo",
    scheduleId: "sched_1",
    mode: "detect",
    claimFence: "fence-1",
    daemonRoute,
    runtimeActor: "agent:schedule:sched_1",
  });
  assert.match(mission, /# Assigned Mission\nDetect drift in the fleet view\./u);
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(mission, /explainer\.html/u);
});

test("the task mission wrapper still seals preconditions around the mission", () => {
  const mission = assembleTaskMission({
    mission: "Do the work.",
    repoId: "repo",
    workerRoot: "/tmp/ha/repo",
    taskId: "task_x",
    taskPackageRoot: "/tmp/ha/repo/harness/tasks/task_x-pkg",
    daemonRoute,
    runtimeActor: "agent:runtime-session:runtime_1",
  });
  assert.match(mission, /# Dispatch Preconditions\nRepository id: repo/u);
  assert.match(mission, /# Assigned Mission\nDo the work\./u);
});

test("the guidance points at the injected <task-context> block and the protocol delegates to template comments", () => {
  assert.match(taskQueryGuidance("task_x"), /已注入的 <task-context>/u);
  const protocol = livingDeliverableProtocol("baseline")!;
  assert.match(protocol, /# Living Deliverable Protocol/u);
  assert.match(protocol, /artifacts\/explainer\.html/u);
  assert.match(protocol, /实时说明页/u, "the protocol names the owner-facing live page");
  assert.match(protocol, /唯一窗口/u);
  assert.match(protocol, /#now/u);
  assert.match(protocol, /#timeline/u);
  assert.match(protocol, /不要攒到收尾一次写/u);
  assert.match(protocol, /顶部注释/u, "the authoring how-to stays in the template comment");
  assert.doesNotMatch(protocol, /#faf7f0|零外网依赖/u);
  assert.match(protocol, /closeout 时冻结/u);
});
