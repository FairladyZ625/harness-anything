// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeContentAddressedBlobWithDisposition } from "../../kernel/src/index.ts";
import { runRawJson, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

test("production daemon executes CAS GC preview and apply", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
    const tracked = writeContentAddressedBlobWithDisposition(rootDir, "tracked evidence body", "text/plain");
    const harnessRoot = path.join(rootDir, "harness");
    const trackedPath = path.relative(harnessRoot, path.join(rootDir, tracked.ref)).split(path.sep).join("/");
    execFileSync("git", ["-C", harnessRoot, "add", "--", trackedPath], { stdio: "ignore" });
    execFileSync("git", [
      "-C", harnessRoot,
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "commit", "-m", "seed tracked evidence"
    ], { stdio: "ignore" });
    const orphan = writeContentAddressedBlobWithDisposition(rootDir, "daemon orphan body", "text/plain");
    const daemonEnv = { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" } as const;

    const preview = unwrapCommandReceipt(runRawJson(rootDir, ["cas", "gc"], daemonEnv));
    assert.equal(preview.ok, true);
    assert.equal(preview.report.mode, "dry-run");
    assert.deepEqual(preview.report.orphans.map((entry: { readonly ref: string }) => entry.ref), [orphan.ref]);
    assert.equal(preview.report.referenced.find((entry: { readonly ref: string }) => entry.ref === tracked.ref)?.reason, "git-tracked");

    const applied = unwrapCommandReceipt(runRawJson(rootDir, ["cas", "gc", "--apply"], daemonEnv));
    assert.equal(applied.ok, true);
    assert.equal(applied.report.mode, "apply");
    assert.deepEqual(applied.report.reclaimed.map((entry: { readonly ref: string }) => entry.ref), [orphan.ref]);
    assert.equal(existsSync(path.join(rootDir, orphan.ref)), false);
    assert.equal(existsSync(path.join(rootDir, tracked.ref)), true);
  });
});
