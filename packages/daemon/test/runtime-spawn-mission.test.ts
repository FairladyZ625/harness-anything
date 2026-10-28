// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  continuationContext,
  continuationContextPrompt,
  currentWorktreeHead,
  latestRuntimeContinuationSeed,
} from "../src/runtime-continuation-context.ts";
import {
  assembleScheduledMission,
  assembleTaskMission,
  assembleUnboundPrompt,
  explicitPromptMission,
  livingDeliverableProtocol,
  resolveRuntimeMission,
  selfIterationCloseoutSection,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "../src/runtime-spawn-mission.ts";

const daemonRoute = { userRoot: "/tmp/ha/user", daemonId: "default", endpoint: "/tmp/ha/user/daemon.sock" };

test("continuation context compares the settled HEAD and includes only the bounded conclusion", () => {
  const context = continuationContext(
    {
      dispatchId: "dispatch_0123456789abcdef01234567",
      lastConclusion: "Tests passed; change is ready for review.",
      exitHead: "a".repeat(40),
    },
    "b".repeat(40),
  );
  assert.deepEqual(context, {
    previousDispatchId: "dispatch_0123456789abcdef01234567",
    lastConclusion: "Tests passed; change is ready for review.",
    exitHead: "a".repeat(40),
    currentHead: "b".repeat(40),
    headStatus: "changed",
  });
  assert.match(continuationContextPrompt(context)!, /Last conclusion: Tests passed; change is ready for review\./u);
  assert.match(continuationContextPrompt(context)!, /HEAD comparison: changed/u);
  assert.doesNotMatch(continuationContextPrompt(context)!, /terminal result|full transcript/iu);
});

test("continuation seed selects the newest archived dispatch across task executions", () => {
  const dispatch = (executionId: string, dispatchId: string, occurredAt: string) => ({
      event: { payload: { taskId: "task_x", executionId, dispatchId }, occurredAt },
    }),
    rows = new Map([
      ["execution_old", [dispatch("execution_old", "dispatch_0123456789abcdef01234567", "2026-10-20T00:00:00Z")]],
      [
        "execution_current",
        [dispatch("execution_current", "dispatch_fedcba987654321001234567", "2026-10-22T00:00:00Z")],
      ],
    ]),
    projection = {
      read: () => ({ packagePath: "tasks/task_x" }),
      readRuntimeDispatchesByTaskExecution: (_taskId: string, executionId: string) => rows.get(executionId) ?? [],
      readDocument: (documentPath: string) => ({
        document: {
          body: JSON.stringify({
            schema: "runtime-dispatch/v1",
            lastConclusion: documentPath.includes("fedcba") ? "latest conclusion" : "old conclusion",
            exitHead: documentPath.includes("fedcba") ? "new-head" : "old-head",
          }),
        },
      }),
    } as never;
  assert.deepEqual(latestRuntimeContinuationSeed(projection, "task_x", ["execution_old", "execution_current"]), {
    dispatchId: "dispatch_fedcba987654321001234567",
    lastConclusion: "latest conclusion",
    exitHead: "new-head",
  });
});

test("a malformed latest dispatch archive surfaces its parse error instead of falling back to older context", () => {
  const projection = {
    read: () => ({ packagePath: "tasks/task_x" }),
    readRuntimeDispatchesByTaskExecution: () => [
      {
        event: {
          payload: { taskId: "task_x", executionId: "execution_x", dispatchId: "dispatch_0123456789abcdef01234567" },
          occurredAt: "2026-10-22T00:00:00Z",
        },
      },
    ],
    readDocument: () => ({ document: { body: "{" } }),
  } as never;
  assert.throws(() => latestRuntimeContinuationSeed(projection, "task_x", ["execution_x"]), SyntaxError);
});

test("a Git worktree without a HEAD returns unavailable", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ha-runtime-continuation-no-head-"));
  try {
    assert.equal(await currentWorktreeHead(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("task mission includes the previous conclusion and compares it with current HEAD", async () => {
  const resolved = await resolveRuntimeMission({
    rootDir: process.cwd(),
    cwd: process.cwd(),
    taskId: "task_x",
    projection: null,
    remoteTask: {
      packageRoot: "tasks/task_x",
      mission: () => "Continue the task.",
      continuationContext: {
        dispatchId: "dispatch_0123456789abcdef01234567",
        lastConclusion: "Focused tests passed.",
        exitHead: "prior-head",
      },
      causalContext: null,
      profileId: null,
      taskClass: "standard",
      planBody: null,
      ownerReturnBody: null,
    } as never,
    taskSnapshot: null,
    missionName: undefined,
    explicitMission: undefined,
    reviewerBinding: false,
  });
  assert.match(resolved.mission, /Last conclusion: Focused tests passed\./u);
  assert.match(resolved.mission, /Exit worktree HEAD: prior-head/u);
  assert.match(resolved.mission, /Current worktree HEAD: [a-f0-9]{40}/u);
  assert.match(resolved.mission, /HEAD comparison: changed/u);
  assert.doesNotMatch(resolved.mission, /full terminal result/iu);
});

test("task-bound explicit prompts carry the lookup guidance, living protocol and PR note", () => {
  const mission = explicitPromptMission("task_x", null, "Finish the leaf task.", "medium"),
    guidanceAt = mission.indexOf(taskQueryGuidance("task_x")),
    protocolAt = mission.indexOf(livingDeliverableProtocol("medium")!),
    noteAt = mission.indexOf(taskPrPublicationNote),
    promptAt = mission.indexOf("Finish the leaf task.");
  assert.ok(guidanceAt >= 0, "lookup guidance rides the task-bound mission");
  assert.ok(protocolAt > guidanceAt, "the living deliverable protocol follows the guidance");
  assert.ok(noteAt > protocolAt, "the PR publication note follows the living protocol");
  assert.match(taskPrPublicationNote, /先运行 `ha task submit <task-id>` 冻结交付事实/u);
  assert.match(taskPrPublicationNote, /机器派生交付事实从 submission 读取/u);
  assert.ok(promptAt > noteAt, "the caller text stays last");
  assert.ok(mission.endsWith("Finish the leaf task."), "explicit caller text stays intact");
});

test("an injected causal block sits between the protocol and the caller text", () => {
  const xml = "<task-context>\n<refs>task/task_x</refs>\n</task-context>",
    mission = explicitPromptMission("task_x", xml, "Go.", "medium");
  assert.ok(
    mission.indexOf(xml) > mission.indexOf(livingDeliverableProtocol("medium")!),
    "protocol precedes the XML block",
  );
  assert.ok(mission.indexOf("Go.") > mission.indexOf(xml), "the XML block precedes the caller text");
});

test("low-risk tasks carry the guidance but never the Living Deliverable Protocol", () => {
  const mission = explicitPromptMission(
    "task_x",
    null,
    "Finish the small change.",
    "low",
    "standard",
    null,
    false,
    null,
    "baseline",
    1,
  );
  assert.match(mission, /# 台账查询引导/u, "the lookup guidance still rides a lightweight mission");
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(mission, /explainer\.html/u);
  assert.ok(mission.endsWith("Finish the small change."), "explicit caller text stays intact");
  assert.equal(livingDeliverableProtocol("low", undefined, "baseline", 1), null, "low risk owes no explainer page");
});

test("the mission protocol follows risk tier when a low task keeps a full preset profile", () => {
  const low = explicitPromptMission(
      "task_x",
      null,
      "Do the docs change.",
      "low",
      "standard",
      null,
      false,
      null,
      "baseline",
      1,
    ),
    medium = explicitPromptMission(
      "task_y",
      null,
      "Implement the feature.",
      "medium",
      "standard",
      null,
      false,
      null,
      "baseline",
      1,
    );
  assert.doesNotMatch(low, /# Living Deliverable Protocol/u);
  assert.match(medium, /# Living Deliverable Protocol/u);
});

test("an explicit task prompt names the reviewer unless the binding is a reviewer", () => {
  const note =
      "本任务的提交将由评审员 reviewer-a 审查（任务指定）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。",
    worker = explicitPromptMission("task_x", null, "Go.", "medium", "standard", null, false, null, null, null, note),
    reviewer = explicitPromptMission("task_x", null, "Go.", "medium", "standard", null, true, null, null, null, note);
  assert.match(worker, /reviewer-a/u);
  assert.doesNotMatch(reviewer, /reviewer-a/u, "a reviewer binding must not carry the worker reviewer note");
});

test("a task with no profile metadata still gets the protocol", () => {
  // Legacy tasks frozen before profiles carried metadata: absence is not a lightweight opt-out.
  assert.notEqual(livingDeliverableProtocol(null), null);
  assert.notEqual(livingDeliverableProtocol(undefined), null);
  assert.match(explicitPromptMission("task_x", null, "Go."), /# Living Deliverable Protocol/u);
});

test("a real pre-tier lightweight task keeps its frozen mission behavior", () => {
  // task_f1f0d5e6fd1ea3009373964a69 was bootstrapped at revision 103330 with profileId=lightweight,
  // riskTier absent, and no explainer.html claim. Reconstruct those persisted fields through the
  // worker mission path so a later daemon build cannot add a document obligation to that task.
  const mission = explicitPromptMission(
    "task_f1f0d5e6fd1ea3009373964a69",
    null,
    "Continue the task.",
    null,
    "standard",
    null,
    false,
    null,
    "lightweight",
    null,
  );
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(mission, /explainer\.html/u);
});

test("a real historical low-tier baseline task keeps its profile-based mission behavior", () => {
  // The live task projection for task_628011248271aabd80eff26b06 records profileId=baseline and
  // riskTier=low. It predates the risk-tier mission switch, so its frozen profile contract still
  // requires the living deliverable protocol.
  const mission = explicitPromptMission(
    "task_628011248271aabd80eff26b06",
    null,
    "Continue the task.",
    "low",
    "standard",
    null,
    false,
    null,
    "baseline",
    null,
  );
  assert.match(mission, /# Living Deliverable Protocol/u);
});

test("unbound prompts pass through without guidance or Living Deliverable Protocol", () => {
  const mission = explicitPromptMission(null, null, "Free-form prompt.", "medium");
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
  const protocol = livingDeliverableProtocol("medium")!;
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
    mission = explicitPromptMission("task_x", null, "Go.", "medium", undefined, null, false, plan),
    planAt = mission.indexOf("Ship the fixture lifecycle."),
    guidanceAt = mission.indexOf(taskQueryGuidance("task_x"));
  assert.ok(mission.startsWith("本任务的 task_plan.md 全文如下"), "the plan opens the mission");
  assert.ok(mission.includes(plan.trim()), "the plan body rides verbatim, not summarized");
  assert.ok(planAt >= 0 && guidanceAt > planAt, "the inlined plan precedes the lookup guidance");
  assert.ok(mission.endsWith("Go."), "explicit caller text stays last");
  assert.doesNotMatch(
    explicitPromptMission("task_x", null, "Go.", "medium"),
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

test("PR publication freezes machine facts before the repository opens the PR", () => {
  for (const riskTier of ["low", "medium", "high"] as const) {
    const mission = explicitPromptMission("task_x", null, "Go.", riskTier);
    assert.match(mission, /最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u);
    assert.match(mission, /再推送并用 `gh pr create --head <task-id>` 开 PR/u);
    assert.match(mission, /正文遵循本仓库的 PR 规范/u);
    assert.match(mission, /机器派生交付事实从 submission 读取，不要手填或重新计算/u);
    assert.ok(
      mission.indexOf("ha task submit <task-id>") < mission.indexOf("gh pr create --head <task-id>"),
      "the submission cut is frozen before publication",
    );
    assert.doesNotMatch(mission, /# PR Body Delivery Protocol/u);
    assert.doesNotMatch(mission, /pull_request_template\.md|Production-Delta|check-pr-body|task\.pr-body/u);
  }
  assert.doesNotMatch(
    explicitPromptMission(null, null, "Go.", "medium"),
    /gh pr create/u,
    "unbound prompts carry no publication note",
  );
});

test("reviewer task-bound missions keep the guidance and Reviewer Role but omit both worker delivery contracts", () => {
  const reviewerMission = explicitPromptMission(
      "task_x",
      null,
      "Review the submitted cut.",
      "medium",
      undefined,
      "Fix the implementation first.",
      true,
    ),
    reviewerPrompt = assembleUnboundPrompt(reviewerMission, "reviewer");
  assert.match(reviewerPrompt, /# Reviewer Role/u, "the reviewer role contract still rides the dispatch");
  assert.match(reviewerMission, /# 台账查询引导/u, "the lookup guidance is not reviewer-specific");
  assert.doesNotMatch(reviewerMission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(reviewerMission, /explainer\.html/u);
  assert.doesNotMatch(reviewerMission, /gh pr create/u);
  assert.doesNotMatch(reviewerMission, /# Owner rework instruction|Fix the implementation first./u);
  assert.doesNotMatch(reviewerMission, /ha task push/u, "reviewers never publish the task branch");
  assert.ok(reviewerMission.endsWith("Review the submitted cut."), "explicit caller text stays intact");

  const workerPrompt = assembleUnboundPrompt(explicitPromptMission("task_x", null, "Do the work.", "medium"));
  assert.match(workerPrompt, /# Living Deliverable Protocol/u, "worker dispatches keep the living protocol");
  assert.match(workerPrompt, /gh pr create/u, "worker dispatches keep the PR publication note");
});

test("work missions omit the task maintenance protocol because work explainers are derived", () => {
  const mission = explicitPromptMission("task_work", null, "Inspect work.", "medium", "work");
  assert.doesNotMatch(mission, /# Work Page Maintenance Protocol/u);
  assert.doesNotMatch(mission, /ha task progress append task_work/u);
  assert.doesNotMatch(mission, /# Living Deliverable Protocol/u);
  assert.doesNotMatch(explicitPromptMission("task_leaf", null, "Go."), /Work Page Maintenance Protocol/u);
});

test("a re-dispatched explicit mission carries the owner return verbatim before the caller text", () => {
  const returnBody = "# Owner return for iteration 0\n\n## Rework instruction\n\nFix the frozen-gate short circuit.",
    mission = explicitPromptMission("task_x", null, "Continue task task_x.", "medium", undefined, returnBody),
    returnAt = mission.indexOf("# Owner rework instruction");
  assert.ok(returnAt >= 0, "the managed return body rides the mission");
  assert.ok(
    mission.indexOf(returnBody) > returnAt,
    "the rendered return document follows its section header untouched",
  );
  assert.ok(mission.indexOf("Continue task task_x.") > returnAt, "the caller text stays last");
  assert.ok(mission.endsWith("Continue task task_x."), "explicit caller text stays intact");
  assert.doesNotMatch(explicitPromptMission("task_x", null, "Go.", "medium"), /# Owner rework instruction/u);
  assert.doesNotMatch(
    explicitPromptMission(null, null, "Go.", "medium", undefined, returnBody),
    /# Owner rework instruction/u,
    "unbound prompts carry no rework record",
  );
});

test("every task-bound mission tells the worker this session cannot ask, with one ruling channel", () => {
  // Measured 2026-10-21 (task_936005e1): a dispatched Codex worker called the provider's question
  // tool; the turn failed and the dispatch settled failed, with the question visible only in the
  // raw stream. The mission must name the constraint and where a ruling request actually lands.
  for (const riskTier of ["low", "medium", "high", undefined] as const) {
    const mission = explicitPromptMission("task_x", null, "Go.", riskTier);
    assert.match(mission, /# 无人值守会话：不能提问/u, `riskTier=${String(riskTier)} carries the constraint`);
    assert.match(mission, /不要调用任何提问\/等待用户输入的 provider 工具/u);
    assert.match(mission, /artifacts\/rulings\/__HARNESS_DISPATCH_ID__\.md/u, "the artifact path is per dispatch");
  }
  // Reviewers are unattended too: same constraint, same single channel.
  assert.match(
    explicitPromptMission("task_x", null, "Review.", "medium", undefined, null, true),
    /# 无人值守会话：不能提问/u,
  );
  // Unbound prompts have no task package, so there is nowhere to write the ruling artifact.
  assert.doesNotMatch(explicitPromptMission(null, null, "Free-form prompt.", "medium"), /无人值守会话/u);
});

test("every task-bound mission sends progress to a file and keeps the rule model-neutral", () => {
  // Measured 2026-10-28 (task_d7c95971): 138 of 223 stopped Codex dispatches ran no settle action;
  // the prompt never said progress belongs in a file rather than in a chat message. The rule is
  // model-neutral here; the Codex-specific turn boundary rides a skill mounted by Codex Agents.
  for (const riskTier of ["low", "medium", "high", undefined] as const) {
    const mission = explicitPromptMission("task_x", null, "Go.", riskTier);
    assert.match(mission, /进度写进文件/u, `riskTier=${String(riskTier)} routes progress to a file`);
    assert.match(mission, /ha task progress append/u, "the progress log is a concrete file channel");
    assert.doesNotMatch(
      mission,
      /不带工具调用|不会被唤醒|结束会话/u,
      "the universal layer carries no provider-specific turn semantics",
    );
    assert.equal(mission.match(/进度写进文件/gu)?.length, 1, "one injection point");
  }
  // Reviewers write reports, not progress messages: the same section reaches them.
  assert.match(explicitPromptMission("task_x", null, "Review.", "medium", undefined, null, true), /进度写进文件/u);
  // The assembled prompt (role baseline + mission) still carries the rule exactly once.
  const assembled = assembleUnboundPrompt(explicitPromptMission("task_x", null, "Go.", "medium"), "worker");
  assert.equal(assembled.match(/进度写进文件/gu)?.length, 1);
  // Unbound prompts have no task package and no progress surface.
  assert.doesNotMatch(explicitPromptMission(null, null, "Free-form prompt.", "medium"), /进度写进文件/u);
});

test("the self-iteration closeout rides only a dispatch whose declaration mounts the skill", () => {
  const taskId = "task_x",
    mounted = selfIterationCloseoutSection(taskId, ["harness-anything-worker", "self-iteration"]),
    absent = selfIterationCloseoutSection(taskId, ["harness-anything-worker"]);
  assert.ok(mounted !== null, "a declaration that mounts self-iteration carries the closeout step");
  assert.match(mounted, /# Self-iteration closeout/u);
  assert.match(mounted, /artifacts\/reflections\/__HARNESS_DISPATCH_ID__\.md/u, "the proposal path is per dispatch");
  assert.match(mounted, /必须同时列出删除项/u, "the proposal owes a deletion");
  assert.match(mounted, /在 `ha task submit` 之前/u, "the step runs before the cut freezes");
  assert.match(mounted, /ha agent install --source <declaration> --expected-version <n>/u);
  assert.equal(absent, null, "an Agent that never opted in carries no extra prompt text");
});

test("a reviewer's self-iteration proposal lands in the report it may already write", () => {
  // The reviewer's ledger surface is exactly one report per dispatch
  // (runtime-execution-scope.ts:101,251-261); a proposal path in the task package would name a
  // write it cannot make, so the review audience must name the report instead.
  const review = selfIterationCloseoutSection("task_x", ["self-iteration"], "review");
  assert.ok(review !== null, "the skill mount opts a reviewer in the same way it opts a worker in");
  assert.match(review, /## Self-iteration proposal/u);
  assert.match(review, /review report/u, "the write point is the review report");
  assert.match(review, /不要新建第二个文件/u);
  assert.match(review, /不要写 `artifacts\/reflections\/`/u, "the reviewer has no write access there");
  assert.match(review, /在 `ha task review-execution` 之前/u, "the proposal precedes the registering write");
  assert.match(review, /不是 finding/u, "the proposal never changes the verdict");
  assert.match(review, /必须同时列出删除项/u, "the review audience owes the same deletion");
  assert.equal(selfIterationCloseoutSection("task_x", [], "review"), null, "no mount, no section");
  // The audiences are distinct: a reviewer must never be told to write the worker's path.
  assert.doesNotMatch(review, /artifacts\/reflections\/__HARNESS_DISPATCH_ID__\.md/u);
  assert.match(
    selfIterationCloseoutSection("task_x", ["self-iteration"], "delivery")!,
    /artifacts\/reflections\/__HARNESS_DISPATCH_ID__\.md/u,
  );
});
