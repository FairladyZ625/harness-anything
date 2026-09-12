// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cli, run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("CLI discovers instances, runs direct prompts, resumes and streams with status retrieval", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env, version } = fixture;
  const { artifactRoot } = seedTask(root, env, "direct");
  const inventory = run(root, env, ["runtime", "instance", "list"]),
    installation = (inventory.installations as Array<Record<string, unknown>>).find(
      (row) => row.kindId === "codex" && row.version === `codex ${version}`,
    );
  assert.ok(installation, JSON.stringify(inventory));
  const missingInstance = runMaybe(root, env, [
    "runtime",
    "run",
    "missing-instance",
    "--prompt",
    "must reject",
    "--detach",
  ]);
  assert.equal(missingInstance.status, 1);
  assert.equal(missingInstance.receipt.code, "runtime_instance_not_found");
  assert.equal(missingInstance.receipt.dispatchId, undefined);
  const directPrompt = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "file prompt", "--no-stream"]);
  assert.equal((directPrompt.result as Record<string, unknown>).text, "final:file prompt");
  for (const directory of ["missions", "dispatches", "reports"])
    assert.equal(existsSync(path.join(artifactRoot, directory)), false, `${directory} must not exist without --task`);
  const resumed = run(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "second turn",
    "--resume",
    "provider-cli-session",
    "--no-stream",
  ]);
  assert.equal((resumed.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
  assert.equal((resumed.session as Record<string, unknown>).providerSessionId, "provider-cli-session");
  const streamed = spawnSync(
    process.execPath,
    [cli, "--root", root, "runtime", "run", "cli-worker", "--prompt", "stream prompt"],
    { encoding: "utf8", env },
  );
  assert.equal(streamed.status, 0, streamed.stderr);
  assert.equal(streamed.stdout.trim(), "final:stream prompt");
  const listed = run(root, env, ["runtime", "status"]),
    sessions = listed.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 3);
  assert.match(streamed.stderr, /\[message\] live:stream prompt/u, JSON.stringify(sessions));
  const detail = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId)]);
  assert.equal((detail.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
  const waited = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId), "--wait", "--no-stream"]);
  assert.equal(waited.command, "runtime-status");
  assert.equal(waited.summary, "resumed:provider-cli-session:second turn");
});
