// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runRawJson, runRawJsonMaybeFail, withTempRoot } from "./helpers/daemon-cli.ts";

test("initialized ledgers fail closed when an ordinary caller requests a direct canonical write", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    const initialHead = canonicalHead(rootDir);
    const failed = runRawJsonMaybeFail(rootDir, ["new-task", "--title", "Must Use Daemon"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "",
      NODE_TEST_CONTEXT: ""
    });

    assert.equal(failed.status, 1);
    assert.equal(failed.receipt.ok, false);
    assert.match(JSON.stringify(failed.receipt), /Direct canonical writes are disabled/iu);
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

function canonicalHead(rootDir: string): string {
  return execFileSync("git", ["-C", `${rootDir}/harness`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
