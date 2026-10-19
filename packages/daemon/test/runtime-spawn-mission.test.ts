// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import {
  assembleScheduledMission,
  assembleTaskMission,
  assembleUnboundPrompt,
  dispatchMissionForWorkerPermissions,
  explicitPromptMission,
  livingDeliverableProtocol,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "../src/runtime-spawn-mission.ts";

const daemonRoute = { userRoot: "/tmp/ha/user", daemonId: "default", endpoint: "/tmp/ha/user/daemon.sock" };

test("task-bound explicit prompts carry the lookup guidance, living protocol and PR note", () => {
  const mission = explicitPromptMission("task_x", null, "Finish the leaf task.", "baseline"),
    guidanceAt = mission.indexOf(taskQueryGuidance("task_x")),
    protocolAt = mission.indexOf(livingDeliverableProtocol("baseline")!),
    noteAt = mission.indexOf(taskPrPublicationNote),
    promptAt = mission.indexOf("Finish the leaf task.");
  assert.ok(guidanceAt >= 0, "lookup guidance rides the task-bound mission");
  assert.ok(protocolAt > guidanceAt, "the living deliverable protocol follows the guidance");
  assert.ok(noteAt > protocolAt, "the PR publication note follows the living protocol");
  assert.ok(promptAt > noteAt, "the caller text stays last");
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

test("the guidance says the inlined plan and task-context need no lookup until they run short", () => {
  const guidance = taskQueryGuidance("task_x");
  assert.match(guidance, /task_plan\.md 全文与 <task-context> 已注入上面的 mission，不必再读文件/u);
  assert.match(guidance, /ha task read-set task_x/u, "the read-set escape hatch stays named");
  assert.match(guidance, /ha task show task_x/u);
  assert.match(guidance, /资料不足[\s\S]*owner/u);
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

test("the task plan rides the mission verbatim ahead of the guidance and the caller text", () => {
  const plan = "# Plan title\n\n## Brief\n\nShip the fixture lifecycle.\n",
    mission = explicitPromptMission("task_x", null, "Go.", "baseline", undefined, null, false, plan),
    planAt = mission.indexOf("Ship the fixture lifecycle."),
    guidanceAt = mission.indexOf(taskQueryGuidance("task_x"));
  assert.ok(mission.startsWith("本任务的 task_plan.md 全文如下"), "the plan opens the mission");
  assert.ok(mission.includes(plan.trim()), "the plan body rides verbatim, not summarized");
  assert.ok(planAt >= 0 && guidanceAt > planAt, "the inlined plan precedes the lookup guidance");
  assert.ok(mission.endsWith("Go."), "explicit caller text stays last");
  assert.doesNotMatch(
    explicitPromptMission("task_x", null, "Go.", "baseline"),
    /task_plan\.md 全文如下/u,
    "a dispatch with no plan body inlines no plan section",
  );
});

test("taskPlanSection names the package root once and carries the body trimmed and verbatim", () => {
  const body = "# Title\n\n## Goal\n\nDo it.\n\n\n";
  const opening = taskPlanSection(body, "/repo/harness/tasks/task_x-pkg");
  assert.ok(opening.startsWith("Your task package is /repo/harness/tasks/task_x-pkg.\n"));
  assert.match(opening, /本任务的 task_plan\.md 全文如下（已内嵌，不必再读文件），按其完成本任务：\n\n# Title/u);
  assert.ok(opening.endsWith("Do it."), "trailing whitespace is trimmed, content is not");
  assert.doesNotMatch(opening, /Read task_plan\.md/u, "the file-read instruction is gone");
  assert.match(taskPlanSection(body), /^本任务的 task_plan\.md 全文如下/u, "package root is optional");
});

test("PR publication rides one sentence and no repository-specific body protocol", () => {
  for (const profileId of ["baseline", "lightweight"] as const) {
    const mission = explicitPromptMission("task_x", null, "Go.", profileId);
    assert.match(mission, /推送后用 `ha task pr` 开 PR，正文遵循本仓库的 PR 规范。/u);
    assert.doesNotMatch(mission, /# PR Body Delivery Protocol/u);
    assert.doesNotMatch(mission, /pull_request_template\.md|Production-Delta|check-pr-body|task\.pr-body/u);
  }
  assert.doesNotMatch(
    explicitPromptMission(null, null, "Go.", "baseline"),
    /ha task pr/u,
    "unbound prompts carry no publication note",
  );
});

test("reviewer task-bound missions keep the guidance and Reviewer Role but omit both worker delivery contracts", () => {
  const reviewerMission = explicitPromptMission(
      "task_x",
      null,
      "Review the submitted cut.",
      "baseline",
      undefined,
      "Fix the implementation first.",
      true,
    ),
    reviewerPrompt = assembleUnboundPrompt(reviewerMission, "reviewer");
  assert.match(reviewerPrompt, /# Reviewer Role/u, "the reviewer role contract still rides the dispatch");
  assert.match(reviewerMission, /# 台账查询引导/u, "the lookup guidance is not reviewer-specific");
  assert.doesNotMatch(reviewerMission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(reviewerMission, /explainer\.html/u);
  assert.doesNotMatch(reviewerMission, /ha task pr/u);
  assert.doesNotMatch(reviewerMission, /# Owner rework instruction|Fix the implementation first./u);
  assert.doesNotMatch(reviewerMission, /ha task push/u, "reviewers never publish the task branch");
  assert.ok(reviewerMission.endsWith("Review the submitted cut."), "explicit caller text stays intact");

  const workerPrompt = assembleUnboundPrompt(explicitPromptMission("task_x", null, "Do the work.", "baseline"));
  assert.match(workerPrompt, /# Living Deliverable Protocol/u, "worker dispatches keep the living protocol");
  assert.match(workerPrompt, /ha task pr/u, "worker dispatches keep the PR publication note");
});

test("work missions omit the task maintenance protocol because work explainers are derived", () => {
  const mission = explicitPromptMission("task_work", null, "Inspect work.", "baseline", "work");
  assert.doesNotMatch(mission, /# Work Page Maintenance Protocol/u);
  assert.doesNotMatch(mission, /ha task progress append task_work/u);
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(explicitPromptMission("task_leaf", null, "Go."), /Work Page Maintenance Protocol/u);
});

test("a re-dispatched explicit mission carries the owner return verbatim before the caller text", () => {
  const returnBody = "# Owner return for iteration 0\n\n## Rework instruction\n\nFix the frozen-gate short circuit.",
    mission = explicitPromptMission("task_x", null, "Continue task task_x.", "baseline", undefined, returnBody),
    returnAt = mission.indexOf("# Owner rework instruction");
  assert.ok(returnAt >= 0, "the managed return body rides the mission");
  assert.ok(
    mission.indexOf(returnBody) > returnAt,
    "the rendered return document follows its section header untouched",
  );
  assert.ok(mission.indexOf("Continue task task_x.") > returnAt, "the caller text stays last");
  assert.ok(mission.endsWith("Continue task task_x."), "explicit caller text stays intact");
  assert.doesNotMatch(explicitPromptMission("task_x", null, "Go.", "baseline"), /# Owner rework instruction/u);
  assert.doesNotMatch(
    explicitPromptMission(null, null, "Go.", "baseline", undefined, returnBody),
    /# Owner rework instruction/u,
    "unbound prompts carry no rework record",
  );
});

test("full worker permissions leave the mission untouched; restricted appends the selected policy", () => {
  const mission = "Ship the leaf task.";
  assert.equal(dispatchMissionForWorkerPermissions(mission, undefined), mission, "no settings means full inheritance");
  assert.equal(
    dispatchMissionForWorkerPermissions(mission, INITIAL_SETTINGS_V1),
    mission,
    "the full default policy stays invisible",
  );

  const restricted = dispatchMissionForWorkerPermissions(mission, {
    ...INITIAL_SETTINGS_V1,
    workerPermissions: { ...INITIAL_SETTINGS_V1.workerPermissions, mode: "restricted", merge: false },
  });
  assert.ok(restricted.startsWith(mission), "the policy block is appended, never rewriting the mission");
  assert.match(restricted, /# Worker Permissions Policy\n\nThis dispatch uses the restricted worker permissions/u);
  assert.match(restricted, /- merge pull requests: not allowed/u, "a switch turned off reads not allowed");
  assert.match(restricted, /- push branches: allowed/u, "a switch left on reads allowed");
  for (const label of [
    "read CI results and logs",
    "read hosted artifacts",
    "open pull requests",
    "change repository settings",
    "use equivalent GitLab operations",
  ]) {
    assert.match(restricted, new RegExp(`- ${label}: allowed`, "u"), `every selected switch is spelled out`);
  }
  assert.equal(
    Object.keys(INITIAL_SETTINGS_V1.workerPermissions).length - 1,
    7,
    "the policy block lists every declared switch",
  );
});
