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
  prBodyDeliveryProtocol,
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

test("PR body protocol follows the document slot, including lightweight explicit dispatch", () => {
  const mission = explicitPromptMission("task_x", null, "Go.", "lightweight", "artifacts/pr-body.md");
  assert.match(mission, /# PR Body Delivery Protocol/u);
  assert.match(mission, /pull_request_template.md/u);
  assert.match(mission, /Production-Delta 用 node tools\/gates\/production-delta\.mjs/u);
  assert.match(mission, /确认没有遗漏、占位内容或未填写骨架/u);
  assert.match(mission, /check-pr-body-bilingual/u);
  assert.match(mission, /从冻结的 submission 记录派生/u);
  assert.doesNotMatch(mission, /Artifact-Anchor/u);
  assert.doesNotMatch(explicitPromptMission("task_x", null, "Go.", "baseline"), /# PR Body Delivery Protocol/u);
  assert.doesNotMatch(
    explicitPromptMission(null, null, "Go.", "baseline", "artifacts/pr-body.md"),
    /PR Body Delivery/u,
  );
});

test("the PR body protocol orders the delivery loop push before pr before submit", () => {
  const protocol = prBodyDeliveryProtocol("artifacts/pr-body.md")!,
    pushAt = protocol.indexOf("ha task push"),
    prAt = protocol.indexOf("ha task pr"),
    submitAt = protocol.indexOf("ha task submit");
  assert.ok(pushAt >= 0, "the protocol tells the worker to publish the task branch");
  assert.ok(prAt > pushAt, "the PR is created after the branch is published, from the doc-synced body");
  assert.ok(submitAt > prAt, "submit comes last: the frozen post-submit cut rejects worker writes");
  assert.doesNotMatch(protocol, /submit 回执/u, "PR creation no longer waits for the submit receipt");
});

test("reviewer task-bound missions keep the guidance and Reviewer Role but omit both worker delivery protocols", () => {
  const reviewerMission = explicitPromptMission(
      "task_x",
      null,
      "Review the submitted cut.",
      "baseline",
      "artifacts/pr-body.md",
      undefined,
      "Fix the implementation first.",
      true,
    ),
    reviewerPrompt = assembleUnboundPrompt(reviewerMission, "reviewer");
  assert.match(reviewerPrompt, /# Reviewer Role/u, "the reviewer role contract still rides the dispatch");
  assert.match(reviewerMission, /# 台账查询引导/u, "the lookup guidance is not reviewer-specific");
  assert.doesNotMatch(reviewerMission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(reviewerMission, /explainer\.html/u);
  assert.doesNotMatch(reviewerMission, /# PR Body Delivery Protocol/u);
  assert.doesNotMatch(reviewerMission, /# Owner rework instruction|Fix the implementation first./u);
  assert.doesNotMatch(reviewerMission, /ha task push/u, "reviewers never publish the task branch");
  assert.ok(reviewerMission.endsWith("Review the submitted cut."), "explicit caller text stays intact");

  const workerPrompt = assembleUnboundPrompt(
    explicitPromptMission("task_x", null, "Do the work.", "baseline", "artifacts/pr-body.md"),
  );
  assert.match(workerPrompt, /# Living Deliverable Protocol/u, "worker dispatches keep the living protocol");
  assert.match(workerPrompt, /# PR Body Delivery Protocol/u, "worker dispatches keep the PR body protocol");
});

test("work missions omit the task maintenance protocol because work explainers are derived", () => {
  const mission = explicitPromptMission("task_work", null, "Inspect work.", "baseline", null, "work");
  assert.doesNotMatch(mission, /# Work Page Maintenance Protocol/u);
  assert.doesNotMatch(mission, /ha task progress append task_work/u);
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(explicitPromptMission("task_leaf", null, "Go."), /Work Page Maintenance Protocol/u);
});

test("a re-dispatched explicit mission carries the owner return verbatim before the caller text", () => {
  const returnBody = "# Owner return for iteration 0\n\n## Rework instruction\n\nFix the frozen-gate short circuit.",
    mission = explicitPromptMission("task_x", null, "Continue task task_x.", "baseline", null, undefined, returnBody),
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
    explicitPromptMission(null, null, "Go.", "baseline", null, undefined, returnBody),
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
