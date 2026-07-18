// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runRawJson, runRawJsonMaybeFail, withTempRoot } from "./helpers/daemon-cli.ts";

test("initialized ledgers fail closed when an ordinary caller requests a direct canonical write", () => {
  withTempRoot((rootDir) => {
    execFileSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "--json", "init"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DAEMON_USER_ROOT: `${rootDir}/.daemon-user`,
        HARNESS_BOOTSTRAP_MACHINE_IDENTITY: "1",
        HARNESS_ACTOR: "agent:direct-mode-contract",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
      }
    });
    const initialHead = canonicalHead(rootDir);
    const failed = runRawJsonMaybeFail(rootDir, ["new-task", "--title", "Must Use Daemon"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "",
      NODE_TEST_CONTEXT: ""
    });

    assert.equal(failed.status, 1);
    assert.equal(failed.receipt.ok, false);
    assert.match(JSON.stringify(failed.receipt), /Direct CLI execution is retired/iu);
    assert.match(JSON.stringify(failed.receipt), /Remove HARNESS_DAEMON_MODE=direct/iu);
    assert.equal(canonicalHead(rootDir), initialHead, "rejected direct write must not move the canonical ref");

    const recovery = runRawJson(rootDir, ["new-task", "--title", "Explicit Recovery"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      NODE_TEST_CONTEXT: ""
    });
    assert.equal(recovery.ok, true);
    assert.notEqual(canonicalHead(rootDir), initialHead, "explicit recovery retains the deliberate direct capability");
  });
});

test("architecture help parse failure does not create a direct operational writer", () => {
  withTempRoot((rootDir) => {
    const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "architecture", "--help"], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: `${rootDir}/.daemon-user` }
    });

    assert.equal(result.status, 2);
    assert.match(result.stdout, /unknown_help_topic/u);
    assert.equal(existsSync(`${rootDir}/.harness`), false);
  });
});

function canonicalHead(rootDir: string): string {
  return execFileSync("git", ["-C", `${rootDir}/harness`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
