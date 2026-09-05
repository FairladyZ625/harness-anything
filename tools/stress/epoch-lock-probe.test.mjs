// harness-test-tier: integration
// Evidence probe: records the existing defect, not a passing recovery regression.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test(
  "probe observes whether a writer killed before PID publication poisons epoch recovery",
  {
    skip: process.platform === "win32" ? "requires POSIX SIGKILL semantics" : false,
  },
  (context) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-epoch-lock-probe-"));
    const child = path.join(import.meta.dirname, "epoch-lock-child.mjs");
    const run = (root, arm) =>
      spawnSync(process.execPath, [child, root, arm], {
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      });
    try {
      const control = run(path.join(scratch, "control"), "acquire");
      assert.equal(control.status, 0, control.stderr);
      assert.match(control.stdout, /"acquired":1/u);
      const stateRoot = path.join(scratch, "fault");
      const killed = run(stateRoot, "kill-after-create");
      assert.equal(killed.error, undefined);
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      assert.match(killed.stdout, /lock-created-before-pid/u);
      assert.equal(readFileSync(path.join(stateRoot, "writer-epochs.lock"), "utf8"), "");
      const recovery = run(stateRoot, "acquire");
      assert.match(recovery.stdout, /acquire-entered/u);
      const blocked = recovery.error?.code === "ETIMEDOUT" && !recovery.stdout.includes('"acquired"');
      const recovered =
        recovery.status === 0 &&
        recovery.stdout.includes('"acquired":1') &&
        !existsSync(path.join(stateRoot, "writer-epochs.lock"));
      context.diagnostic(
        JSON.stringify({
          schema: "epoch-lock-boundary-probe/v1",
          controlExit: control.status,
          injectedSignal: killed.signal,
          lockBytes: 0,
          recoveryExit: recovery.status,
          recoverySignal: recovery.signal,
          recoveryError: recovery.error?.code ?? null,
          recoveryStdout: recovery.stdout,
          campaignVerdict: blocked ? "BLOCKED" : recovered ? "RECOVERED" : "FAIL",
          scope: "real writer-epoch API; no daemon or production state",
        }),
      );
      // The probe passes only if the observation is one of the two explicit outcomes.
      // BLOCKED is a mission checkpoint, never a campaign success.
      assert.ok(blocked || recovered, recovery.stderr);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
