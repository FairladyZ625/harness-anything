// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { readPublishedDispatch, assertTaskMissionPrompt } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask, installIdentities } from "./runtime-cli.setup.fixture.ts";

test("Named missions reject invalid inputs and task-derived missions carry dispatch preconditions", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { parent, root, env, userRoot, daemonId } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "mission");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const existingMissionPath = `${packagePath}/artifacts/missions/existing-mission.md`;
  const pathLikeMission = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--mission",
    existingMissionPath,
    "--task",
    taskId,
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
      "Expected a bare mission id; the daemon resolves harness/<task-package>/artifacts/missions/<name>.md " +
      "and did not look up this file. Retry ha agent run <agent-id> --task <task-id> --mission <name>",
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
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(unsyncedMission.status, 1);
  assert.equal(unsyncedMission.receipt.code, "runtime_mission_unavailable");
  mkdirSync(path.join(artifactRoot, "missions"), { recursive: true });
  writeFileSync(path.join(root, "harness", existingMissionPath), "existing mission");
  // Manual sync stays the tested path; a concurrent authored-candidate settlement may have won
  // the write, which the receipt reports as no_changes — both outcomes leave the doc clean.
  const missionSync = run(root, env, ["doc", "sync", "--submit", "--path", existingMissionPath]);
  assert.match(String(run(root, env, ["doc", "status", "--path", existingMissionPath]).evidence), /"state":"clean"/u);
  const promptFile = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt-file",
    path.join("harness", packagePath, "artifacts", "missions", "existing-mission.md"),
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(promptFile.status, 0, JSON.stringify(promptFile));
  assert.match(
    String((promptFile.receipt.result as Record<string, unknown>).text),
    /# Assigned Mission\nexisting mission$/u,
  );
  const promptFileDispatchId = String((promptFile.receipt.spawn as Record<string, unknown>).dispatchId);
  const reused = run(root, env, [
      "agent",
      "run",
      "terra",
      "--mission",
      "existing-mission",
      "--task",
      taskId,
      "--no-stream",
    ]),
    reusedDispatchId = String((reused.spawn as Record<string, unknown>).dispatchId),
    reusedDispatch = JSON.parse(
      await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${reusedDispatchId}.json`)),
    ) as Record<string, unknown>;
  const reusedMission = readFileSync(path.join(artifactRoot, "missions", `${reusedDispatchId}.md`), "utf8"),
    reusedReport = readFileSync(path.join(artifactRoot, "reports", `${reusedDispatchId}.md`), "utf8");
  context.diagnostic(
    `hand-written mission route: ${JSON.stringify({
      before: {
        outcome: unsyncedMission.receipt.outcome,
        code: unsyncedMission.receipt.code,
        diagnostic: unsyncedMission.receipt.diagnostic,
      },
      sync: { outcome: missionSync.outcome, summary: missionSync.summary },
      after: { outcome: reused.outcome, dispatchId: reusedDispatchId },
    })}`,
  );
  assert.equal(reusedDispatch.missionRef, `${packagePath}/artifacts/missions/${reusedDispatchId}.md`);
  assert.deepEqual(
    readdirSync(path.join(artifactRoot, "missions")).sort(),
    ["existing-mission.md", `${promptFileDispatchId}.md`, `${reusedDispatchId}.md`].sort(),
  );
  assert.equal(reusedReport, `final:${reusedMission}`);
  assertTaskMissionPrompt(reusedMission, {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(reused.runtimeSessionId),
    mission:
      `Your task package is ${path.join(realpathSync(root), "harness", packagePath)}.\n` +
      "Read task_plan.md in that package and complete the task.\n\n" +
      "# Mission: existing-mission\n\nexisting mission",
  });
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const taskPackage = path.join(realpathSync(root), "harness", packagePath),
    derivedMission = `Your task package is ${taskPackage}.\nRead task_plan.md in that package and complete the task.`,
    derived = run(root, env, ["agent", "run", "terra", "--task", taskId, "--cwd", ".", "--no-stream"]),
    derivedText = String((derived.result as Record<string, unknown>).text);
  assert.match(
    derivedText,
    /^final:# Agent Identity: Terra \(terra\).*# Harness Execution Discipline.*# Worker Role/su,
  );
  assertTaskMissionPrompt(derivedText.slice("final:".length), {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: taskPackage,
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(derived.runtimeSessionId),
    mission: derivedMission,
  });
  assert.equal(derivedText.includes("Review precisely."), true);
});
