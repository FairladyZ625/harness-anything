// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import { signInAt } from "../../daemon/test/keycloak.fixtures.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

async function taskList(rootDir: string, env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "task", "list", "--json"],
    { env },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.ok(stdout.trim(), stderr);
  return { exit, receipt: JSON.parse(stdout) };
}

test("CLI query-only task list and GUI reads reject an unavailable canonical repository", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task_read_failure", title: "Read failure", presetId: "docs-task" },
    beforeRestart: async (rootDir: string) => {
      const db = new DatabaseSync(path.join(rootDir, ".harness/store/generations/2/ledger.sqlite"));
      try {
        const row = db
          .prepare(
            "SELECT revision, event_json FROM event WHERE json_extract(event_json, '$.schema') = 'task-bootstrap-event/v1'",
          )
          .get() as { revision: number; event_json: string };
        assert.ok(row, "fixture must corrupt a real task bootstrap event");
        const event = JSON.parse(row.event_json);
        event.eventId = "";
        db.prepare("UPDATE event SET event_json = ? WHERE revision = ?").run(JSON.stringify(event), row.revision);
      } finally {
        db.close();
      }
      rmSync(path.join(rootDir, ".harness/cache"), { recursive: true, force: true });
    },
  });
  const previous = { ...process.env };
  try {
    Object.assign(process.env, fixture.env);
    const cli = await taskList(fixture.rootDir, { ...process.env });
    const status = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.status", {});
    assert.equal((status.repos as { state: string }[])[0]!.state, "unavailable");
    assert.equal((status.repos as { projectionReadable: boolean }[])[0]!.projectionReadable, false);
    assert.notEqual(cli.exit, 0, JSON.stringify(cli.receipt));
    assert.equal(cli.receipt.ok, false);
    assert.equal(cli.receipt.code, "repo_unavailable");
    assert.match(JSON.stringify(cli.receipt), /task bootstrap event identity is invalid/);
    assert.equal(cli.receipt.rows, undefined);
    const gui = await createLocalGuiServiceBridge(fixture.rootDir).invoke("getTasks", { repoId: fixture.repoId });
    assert.equal(gui.ok, false);
    assert.equal(gui.code, "repo_unavailable");
    assert.match(JSON.stringify(gui), /task bootstrap event identity is invalid/);
  } finally {
    for (const key of Object.keys(fixture.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fixture.stop();
  }
});

test("a genuinely empty canonical repository succeeds through CLI and GUI", async () => {
  const fixture = await startGuiResidentDaemonFixture();
  const previous = { ...process.env };
  try {
    Object.assign(process.env, fixture.env);
    const cli = await taskList(fixture.rootDir, { ...process.env });
    assert.equal(cli.exit, 0);
    assert.equal(cli.receipt.ok, true);
    assert.deepEqual(cli.receipt.rows, []);
    const gui = await createLocalGuiServiceBridge(fixture.rootDir).invoke("getTasks", { repoId: fixture.repoId });
    assert.equal(gui.ok, true);
    assert.deepEqual(gui.rows, []);
    assert.deepEqual(gui.invalidRows, []);
  } finally {
    for (const key of Object.keys(fixture.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fixture.stop();
  }
});

test("CLI and GUI preserve authorization refusal for an attached repository", async () => {
  const fixture = await startGuiResidentDaemonFixture();
  const previous = { ...process.env };
  try {
    fixture.keycloak.account("person-denied");
    signInAt(fixture.userRoot, "person-denied", []);
    Object.assign(process.env, fixture.env);
    const cli = await taskList(fixture.rootDir, { ...process.env });
    assert.notEqual(cli.exit, 0);
    assert.equal(cli.receipt.ok, false);
    assert.equal(cli.receipt.code, "authorization_denied");
    assert.equal(cli.receipt.rows, undefined);
    const gui = await createLocalGuiServiceBridge(fixture.rootDir).invoke("getTasks", { repoId: fixture.repoId });
    assert.equal(gui.ok, false);
    assert.equal(gui.code, "authorization_denied");
    assert.equal(gui.rows, undefined);
  } finally {
    for (const key of Object.keys(fixture.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fixture.stop();
  }
});
