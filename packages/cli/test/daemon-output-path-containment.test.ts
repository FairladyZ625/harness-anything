// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runRawJsonMaybeFail, withTempRoot } from "./helpers/daemon-cli.ts";

test("daemon install-templates rejects canonical authored output directories", () => {
  withTempRoot((rootDir) => {
    const outDir = path.join(rootDir, "harness/decisions/template-output");
    const result = runRawJsonMaybeFail(rootDir, ["daemon", "install-templates", "--out", outDir], {
      HARNESS_DAEMON_MODE: "fixture"
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.receipt.ok, false);
    assert.equal(existsSync(path.join(outDir, "harness-anything-daemon.service")), false);
  });
});

test("daemon bootstrap-server rejects a report path beneath canonical authored paths", () => {
  withTempRoot((rootDir) => {
    const canonicalRoot = path.join(rootDir, "canonical");
    const reportPath = path.join(canonicalRoot, "harness/decisions/bootstrap-report.json");
    const result = runRawJsonMaybeFail(rootDir, [
      "daemon",
      "bootstrap-server",
      "--canonical-root",
      canonicalRoot,
      "--ssh-host",
      "team-host",
      "--report",
      reportPath,
      "--skip-ssh-check",
      "--no-start"
    ], { HARNESS_DAEMON_MODE: "fixture" });

    assert.notEqual(result.status, 0);
    assert.equal(result.receipt.ok, false);
    assert.equal(existsSync(reportPath), false);
  });
});
