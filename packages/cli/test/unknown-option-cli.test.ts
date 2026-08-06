// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withTestHarnessRoot } from "./helpers/git-fixtures.ts";
import {
  runRawJson as runDaemonJson,
  runRawJsonMaybeFail,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";
import { writePeopleRoster } from "./helpers/forced-command-daemon.ts";
import {
  runJson,
  writeIndex
} from "./helpers/local-lifecycle-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

test("unknown dry-run spelling is rejected before any task-package write", async () => {
  await withTempRootAsync(async (rootDir) => {
    runDaemonJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
    writePeopleRoster(rootDir, {
      personId: "person_unknown_option",
      displayName: "Unknown Option Test",
      email: "unknown-option@example.test",
      role: "owner"
    });
    const env = { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" } as const;
    const created = unwrapCommandReceipt(runDaemonJson(rootDir, ["task", "create", "--title", "Fail Closed"], env));
    assert.equal(typeof created.taskId, "string");
    const taskId = String(created.taskId);
    const taskRoot = path.join(rootDir, String(created.packagePath));
    const progressPath = path.join(taskRoot, "progress.md");
    const before = directorySnapshot(taskRoot);

    const typoResult = runRawJsonMaybeFail(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "must not persist",
      "--dryrun"
    ], env);
    const typo = unwrapCommandReceipt(typoResult.receipt);
    assert.notEqual(typoResult.status, 0);
    assert.equal(typo.ok, false);
    assert.equal(typo.error?.code, "unknown_option");
    assert.match(typo.error?.hint ?? "", /Did you mean '--dry-run'\?/u);
    assert.deepEqual(directorySnapshot(taskRoot), before);
    assert.equal(existsSync(progressPath), false);

    const dryRun = unwrapCommandReceipt(runDaemonJson(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "still must not persist",
      "--dry-run"
    ], env));
    assert.equal(dryRun.ok, true);
    assert.deepEqual(directorySnapshot(taskRoot), before);
    assert.equal(existsSync(progressPath), false);

    const written = unwrapCommandReceipt(runDaemonJson(rootDir, [
      "task", "progress", "append", taskId,
      "--text", "must persist"
    ], env));
    assert.equal(written.ok, true);
    assert.equal(
      readFileSync(progressPath, "utf8"),
      "# Progress\n\n## Entries\n\nmust persist\n"
    );
  });
});

test("misspelled read filter fails closed while the declared filter still narrows", () => {
  withTestHarnessRoot((rootDir) => {
    const env = { HARNESS_DAEMON_MODE: "fixture" } as const;
    writeIndex(rootDir, "task-active", "Active", "active");
    writeIndex(rootDir, "task-planned", "Planned", "planned");

    const typo = runJson(rootDir, ["task", "list", "--status", "active"], false, env);
    assert.equal(typo.ok, false);
    assert.equal(typo.error?.code, "unknown_option");
    assert.match(typo.error?.hint ?? "", /Did you mean '--state'\?/u);

    const filtered = runJson(rootDir, ["task", "list", "--state", "active"], true, env);
    assert.equal(filtered.ok, true);
    assert.deepEqual(filtered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-active"]);
  });
});

function directorySnapshot(directory: string): Readonly<Record<string, string>> {
  return Object.fromEntries(snapshotEntries(directory, directory));
}

function snapshotEntries(root: string, directory: string): ReadonlyArray<readonly [string, string]> {
  return readdirSync(directory).flatMap((name) => {
    const entry = path.join(directory, name);
    return statSync(entry).isDirectory()
      ? snapshotEntries(root, entry)
      : [[path.relative(root, entry), readFileSync(entry).toString("base64")] as const];
  });
}
