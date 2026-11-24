// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan, realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import {
  livingDeliverableProtocol,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "@harness-anything/daemon/internal/runtime-spawn-mission";
import {
  assertTaskMissionPrompt,
  createRuntimeFixture,
  installIdentities,
  published,
  readPublishedDispatch,
  recoverLatest,
  renderedRulingContract,
  run,
  runMaybe,
  seedTask,
  workerWorktreeBoundary,
} from "./runtime-cli.fixtures.ts";

// The old sequence needed a manual copy: artifact add refused an outside source, and the mission
// file could then only be updated by hand. This is the one path the errors now point at.
test("a scratchpad mission is published, edited, and dispatched by name without a manual copy", async (context) => {
  const fixture = await createRuntimeFixture(context),
    { parent, root, env } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath } = seedTask(root, env, "mission-write"),
    publishedMission = path.join(root, packagePath, "artifacts", "missions", "w1.md");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);

  const scratchpad = path.join(parent, "scratch-w1.md");
  writeFileSync(scratchpad, "mission v1\n");
  const added = run(root, env, [
    "task",
    "artifact",
    "add",
    taskId,
    "--source",
    scratchpad,
    "--destination",
    `${packagePath}/artifacts/missions/w1.md`,
  ]);
  assert.equal(added.outcome, "applied", JSON.stringify(added));
  published(root, env, added);
  assert.equal(readFileSync(publishedMission, "utf8"), "mission v1\n");

  writeFileSync(publishedMission, "mission v2\n");
  const synced = runMaybe(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/artifacts/missions/w1.md`]);
  assert.equal(synced.status, 0, synced.stderr);
  assert.ok(["applied", "no_changes"].includes(String(synced.receipt.outcome)), JSON.stringify(synced.receipt));

  const preview = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--task",
    taskId,
    "--mission",
    "w1",
    "--dry-run",
    "--no-stream",
  ]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${JSON.stringify(preview.receipt)}`);
  assert.equal(preview.receipt.schema, "agent-dispatch-preview/v1", JSON.stringify(preview.receipt));
  assert.match(String(preview.receipt.prompt), /mission v2/u);
  assert.doesNotMatch(String(preview.receipt.prompt), /mission v1/u);
});

test("task start returns non-blocking structured risk-tier advice for a low lightweight task", async (context) => {
  const { root, env } = await createRuntimeFixture(context),
    taskId = "task-start-risk-advice",
    created = run(root, env, [
      "task",
      "create",
      "--id",
      taskId,
      "--admin",
      "--title",
      "Task start risk advice",
      "--risk-tier",
      "low",
    ]),
    packagePath = String(created.workspacePackagePath);
  published(root, env, created);
  writeFileSync(path.join(root, packagePath, "task_plan.md"), realizedTaskPlan("Task start risk advice"));
  run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);

  const started = run(root, env, ["task", "start", taskId, "--execution-id", "exec-start-risk-advice"]),
    advice = started.riskTierAdvice as Record<string, unknown>;
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  assert.deepEqual(Object.keys(advice).sort(), ["declaredTier", "profileId", "reasons", "schema", "suggestedTier"]);
  assert.equal(advice.schema, "task-risk-tier-advice/v1");
  assert.equal(advice.declaredTier, "low");
  assert.equal(advice.suggestedTier, "low");
  assert.equal(advice.profileId, "lightweight");
  assert.ok(Array.isArray(advice.reasons) && advice.reasons.length > 0);
  assert.match(renderCliReceipt(started).text, /risk tier suggestion: low \(profile: lightweight\)/u);

  const rejoined = run(root, env, ["task", "start", taskId]);
  assert.equal(rejoined.outcome, "no_changes", JSON.stringify(rejoined));
  assert.deepEqual(rejoined.riskTierAdvice, advice, "joining the active execution also returns its advice");
});

test(
  "Named missions reject invalid inputs and task-derived missions carry dispatch preconditions",
  { timeout: 300_000 },
  async (context) => {
    const fixture = await createRuntimeFixture(context);
    const { parent, root, env, userRoot, daemonId } = fixture;
    installIdentities(parent, root, env);
    const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "mission");
    const stopGuidance = (dispatchId: string) =>
      `\n\nTask ${taskId} is not submitted: the worker exited without a submitted delivery. ` +
      `Recover the stopped worker with: ha agent run terra --task ${taskId} --recover-dispatch ${dispatchId} ` +
      `--execution-id ${executionId} --expected-version <revision> --idempotency-key <key>`;
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const existingMissionPath = `${packagePath}/artifacts/missions/existing-mission.md`;
    const pathLikeMission = runMaybe(root, env, [
      "agent",
      "run",
      "terra",
      "--mission",
      existingMissionPath,
      "--cwd",
      ".",
      "--task",
      taskId,
      ...recoverLatest(root, env, taskId),
      "--no-stream",
    ]);
    assert.equal(pathLikeMission.status, 1);
    assert.equal(pathLikeMission.receipt.code, "invalid_runtime_mission");
    assert.deepEqual(pathLikeMission.receipt.diagnostic, {
      kind: "validation",
      entity: "runtime mission",
      field: "mission",
      actual: "path-like value",
      expectation:
        "Expected a bare mission id. Publish the text as a mission document with " +
        "ha task artifact add <task-id> --source <file> --destination <workspace-relative-task-package>/artifacts/missions/<name>.md, " +
        "then retry ha agent run <agent-id> --task <task-id> --mission <name>; " +
        "update a published mission at its package path with ha doc sync --submit --path <task-package>/artifacts/missions/<name>.md.",
    });
    context.diagnostic(`invalid_runtime_mission receipt=${JSON.stringify(pathLikeMission.receipt)}`);
    // The unavailable rejection is only deterministic while the file is absent: once it exists on
    // disk, the WAL materializer's authored-candidate settlement may auto-submit it after any
    // flush, racing both this rejection and a doc status that expects "eligible".
    const unsyncedMission = runMaybe(root, env, [
      "agent",
      "run",
      "terra",
      "--mission",
      "existing-mission",
      "--cwd",
      ".",
      "--task",
      taskId,
      ...recoverLatest(root, env, taskId),
      "--no-stream",
    ]);
    assert.equal(unsyncedMission.status, 1);
    assert.equal(unsyncedMission.receipt.code, "runtime_mission_unavailable");
    mkdirSync(path.join(artifactRoot, "missions"), { recursive: true });
    writeFileSync(path.join(root, existingMissionPath), "existing mission");
    // Manual sync stays the tested path; a concurrent authored-candidate settlement may have won
    // the write, which the receipt reports as no_changes — both outcomes leave the doc clean.
    const missionSync = run(root, env, ["doc", "sync", "--submit", "--path", existingMissionPath]);
    assert.match(String(run(root, env, ["doc", "status", "--path", existingMissionPath]).evidence), /"state":"clean"/u);
    const promptFile = runMaybe(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt-file",
      path.join(packagePath, "artifacts", "missions", "existing-mission.md"),
      "--cwd",
      ".",
      "--task",
      taskId,
      ...recoverLatest(root, env, taskId),
      "--no-stream",
    ]);
    assert.equal(promptFile.status, 1, JSON.stringify(promptFile));
    assert.ok(promptFile.receipt.spawn, JSON.stringify(promptFile.receipt));
    const promptFileDispatchId = String((promptFile.receipt.spawn as Record<string, unknown>).dispatchId);
    assert.ok(
      String((promptFile.receipt.result as Record<string, unknown>).text).endsWith(
        `# Assigned Mission\n${taskPlanSection(realizedPlan("mission"))}\n\n${taskQueryGuidance(taskId)}\n\n` +
          `${renderedRulingContract(promptFileDispatchId)}\n\n` +
          `${workerWorktreeBoundary}\n\n` +
          // dec_E369B861 CH3: explicit prompts and derived missions both name the reviewer.
          `本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。` +
          `\n\n${livingDeliverableProtocol("baseline")!}\n\n${taskPrPublicationNote}\n\nexisting mission` +
          stopGuidance(promptFileDispatchId),
      ),
    );
    const reused = runMaybe(root, env, [
        "agent",
        "run",
        "terra",
        "--mission",
        "existing-mission",
        "--cwd",
        ".",
        "--task",
        taskId,
        ...recoverLatest(root, env, taskId),
        "--no-stream",
      ]),
      reusedDispatchId = String((reused.receipt.spawn as Record<string, unknown>).dispatchId),
      reusedDispatch = JSON.parse(
        await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${reusedDispatchId}.json`)),
      ) as Record<string, unknown>;
    // The mission and report publish after the dispatch record, so they are awaited the same way.
    const reusedMission = await readPublishedDispatch(path.join(artifactRoot, "missions", `${reusedDispatchId}.md`)),
      reusedReport = await readPublishedDispatch(path.join(artifactRoot, "reports", `${reusedDispatchId}.md`));
    context.diagnostic(
      `hand-written mission route: ${JSON.stringify({
        before: {
          outcome: unsyncedMission.receipt.outcome,
          code: unsyncedMission.receipt.code,
          diagnostic: unsyncedMission.receipt.diagnostic,
        },
        sync: { outcome: missionSync.outcome, summary: missionSync.summary },
        after: { outcome: reused.receipt.outcome, dispatchId: reusedDispatchId },
      })}`,
    );
    assert.equal(
      reusedDispatch.missionRef,
      `${packagePath.replace(/^harness\//u, "")}/artifacts/missions/${reusedDispatchId}.md`,
    );
    assert.deepEqual(
      readdirSync(path.join(artifactRoot, "missions")).sort(),
      ["existing-mission.md", `${promptFileDispatchId}.md`, `${reusedDispatchId}.md`].sort(),
    );
    assert.equal(reusedReport, `final:${reusedMission}${stopGuidance(reusedDispatchId)}`);
    assertTaskMissionPrompt(reusedMission, {
      repoId: "runtime-cli",
      taskId,
      workerRoot: realpathSync(root),
      taskPackageRoot: path.join(realpathSync(root), packagePath),
      daemonUserRoot: userRoot,
      daemonId,
      runtimeSessionId: String(reused.receipt.runtimeSessionId),
      mission:
        `${taskPlanSection(realizedPlan("mission"), path.join(realpathSync(root), packagePath))}\n\n` +
        `${taskQueryGuidance(taskId)}\n\n${renderedRulingContract(reusedDispatchId)}\n\n` +
        `${workerWorktreeBoundary}\n\n` +
        // dec_E369B861 CH3: the worker mission names who reviews the next submitted cut.
        `本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。` +
        `\n\n${livingDeliverableProtocol("baseline")!}\n\n` +
        `${taskPrPublicationNote}\n\n# Mission: existing-mission\n\nexisting mission`,
      continuationContext: true,
    });
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const taskPackage = path.join(realpathSync(root), packagePath);
    // The task-derived mission run also settles stopped (no delivery), so it exits 1 with its result.
    const derived = runMaybe(root, env, [
        "agent",
        "run",
        "terra",
        "--task",
        taskId,
        ...recoverLatest(root, env, taskId),
        "--cwd",
        ".",
        "--no-stream",
      ]),
      derivedText = String((derived.receipt.result as Record<string, unknown>).text),
      derivedMission =
        `${taskPlanSection(realizedPlan("mission"), taskPackage)}\n\n` +
        taskQueryGuidance(taskId) +
        "\n\n" +
        renderedRulingContract(String((derived.receipt.spawn as Record<string, unknown>).dispatchId)) +
        "\n\n" +
        workerWorktreeBoundary +
        "\n\n" +
        // dec_E369B861 CH3: the derived worker mission names who reviews the next submitted cut.
        "本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。" +
        "\n\n" +
        livingDeliverableProtocol("baseline")! +
        "\n\n" +
        taskPrPublicationNote;
    assert.match(
      derivedText,
      /^final:# Agent Identity: Terra \(terra\).*# Harness Execution Discipline.*# Worker Role/su,
    );
    const derivedStop = stopGuidance(String((derived.receipt.spawn as Record<string, unknown>).dispatchId));
    assert.ok(derivedText.endsWith(derivedStop), "an unsubmitted exit must carry its continuation entry");
    assertTaskMissionPrompt(derivedText.slice("final:".length, -derivedStop.length), {
      repoId: "runtime-cli",
      taskId,
      workerRoot: realpathSync(root),
      taskPackageRoot: taskPackage,
      daemonUserRoot: userRoot,
      daemonId,
      runtimeSessionId: String(derived.receipt.runtimeSessionId),
      mission: derivedMission,
      continuationContext: true,
    });
    assert.equal(derivedText.includes("Review precisely."), true);
  },
);
