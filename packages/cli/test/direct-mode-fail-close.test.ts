// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { defaultDaemonUserRoot, runDaemonCommand, runRawJson, runRawJsonMaybeFail, withTempRoot, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

test("initialized ledgers fail closed when an ordinary caller requests a direct canonical write", () => {
  withTempRoot((rootDir) => {
    execFileSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "--json", "init"], {
      encoding: "utf8",
      env: cliTestEnv({
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DAEMON_USER_ROOT: `${rootDir}/.daemon-user`,
        HARNESS_BOOTSTRAP_MACHINE_IDENTITY: "1",
        HARNESS_ACTOR: "agent:direct-mode-contract",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
      })
    });
    const initialHead = canonicalHead(rootDir);
    const failed = runRawJsonMaybeFail(rootDir, ["task", "create", "--title", "Must Use Daemon"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "",
      NODE_TEST_CONTEXT: ""
    });

    assert.equal(failed.status, 1);
    assert.equal(failed.receipt.ok, false);
    assert.match(JSON.stringify(failed.receipt), /reserved for operator recovery/iu);
    assert.match(JSON.stringify(failed.receipt), /HARNESS_DAEMON_MODE=direct HARNESS_DIRECT_WRITE_REASON=recovery ha --root .* --json task create --title 'Must Use Daemon'/u);
    assert.equal(canonicalHead(rootDir), initialHead, "rejected direct write must not move the canonical ref");

    const recovery = runRawJson(rootDir, ["task", "create", "--title", "Explicit Recovery"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      NODE_TEST_CONTEXT: ""
    });
    assert.equal(recovery.ok, true);
    const taskId = ((recovery.details as Record<string, unknown>).data as Record<string, unknown>).taskId;
    const listed = runRawJson(rootDir, ["task", "list"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      NODE_TEST_CONTEXT: ""
    });
    const items = listed.items as Array<Record<string, unknown>>;
    assert.equal(items.some((item) => item.taskId === taskId && item.title === "Explicit Recovery"), true);
    assert.notEqual(canonicalHead(rootDir), initialHead, "explicit recovery retains the deliberate direct capability");
  });
});

test("direct recovery is rejected by the global write lock while the daemon is live", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const created = runRawJson(rootDir, ["task", "create", "--title", "Daemon Lock Target"], {
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    const taskId = ((created.details as Record<string, unknown>).data as Record<string, unknown>).taskId as string;
    runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
    const initialHead = canonicalHead(rootDir);

    const failed = runRawJsonMaybeFail(rootDir, ["task", "progress", "append", taskId, "--text", "Must not race daemon"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      NODE_TEST_CONTEXT: ""
    });

    assert.equal(failed.status, 1);
    assert.equal(failed.receipt.ok, false);
    assert.equal((failed.receipt.error as Record<string, unknown>).code, "write_conflict");
    assert.match(JSON.stringify(failed.receipt), /Global write lock is held/iu);
    assert.match(JSON.stringify(failed.receipt), /mutually exclusive with a live daemon/iu);
    assert.equal(canonicalHead(rootDir), initialHead, "conflicting direct recovery must not move the canonical ref");
  });
});

test("architecture help parse failure does not create a direct operational writer", () => {
  withTempRoot((rootDir) => {
    const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "architecture", "--help"], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: `${rootDir}/.daemon-user` })
    });

    assert.equal(result.status, 2);
    assert.match(result.stdout, /unknown_help_topic/u);
    assert.equal(existsSync(`${rootDir}/.harness`), false);
  });
});

function canonicalHead(rootDir: string): string {
  return execFileSync("git", ["-C", `${rootDir}/harness`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
