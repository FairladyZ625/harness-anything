// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRuntimeFixture, installIdentities, published, run, runMaybe, seedTask } from "./runtime-cli.fixtures.ts";

// The old sequence needed a manual copy: artifact add refused an outside source, and the mission
// file could then only be updated by hand. This is the one path the errors now point at.
test("a scratchpad mission is published, edited, and dispatched by name without a manual copy", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath } = seedTask(root, env, "mission-write"),
    publishedMission = path.join(root, "harness", packagePath, "artifacts", "missions", "w1.md");
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
    "artifacts/missions/w1.md",
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
