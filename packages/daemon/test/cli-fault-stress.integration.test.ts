// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
test(
  "real CLI stays responsive after an injected canonical scan failure; uncached control fails the same oracle",
  { timeout: 180_000 },
  async () => {
    const reports = [];
    for (const arm of ["uncached", "cached"]) {
      const { stdout } = await run(
        process.execPath,
        [
          "--import",
          path.join(import.meta.dirname, "fixtures/cli-fault-hook.mjs"),
          path.join(import.meta.dirname, "fixtures/cli-fault-command-runner.mjs"),
          arm,
        ],
        { timeout: 80_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const frame = stdout.split("\n").find((line) => line.startsWith("CLI_FAULT_REPORT\t"));
      assert.ok(frame, stdout);
      const report = JSON.parse(frame.slice("CLI_FAULT_REPORT\t".length));
      assert.equal(report.requests.length, 14);
      assert.ok(report.p95Ms < 15_000, `CLI response budget exceeded: ${report.p95Ms}ms`);
      assert.equal(report.boundedScanOracle, arm === "cached" ? "PASS" : "FAIL");
      if (arm === "cached") assert.equal(report.scans, 1);
      else assert.ok(report.scans >= 4, "negative control must expose repeated real canonical scans");
      reports.push(report);
      console.log(frame);
    }
    assert.equal(
      reports[0].requests.length,
      reports[1].requests.length,
      "both arms must use the same request schedule",
    );
  },
);
