// harness-test-tier: fast
// PLT-Honest: the hint text is the layer that killed the user's daemon today.
// These tests assert the three honest lifecycle states produce distinct codes
// and that the "starting" hint never sends an agent to restart or use direct
// mode — the two actions that, when followed verbatim during cold start,
// killed the recovering system.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DaemonAutostartCircuitOpenError,
  DaemonAutostartProcessExitedError,
  DaemonAutostartTimeoutError
} from "@harness-anything/daemon";
import { classifyLocalDaemonLifecycle } from "../src/daemon/client.ts";

const selfPid = process.pid;
const deadPid = 999_999;
const livePidRegex = new RegExp(`pid ${selfPid}`, "u");

test("autostart timeout with a LIVE pid classifies as daemon_starting and forbids restart/direct guidance", () => {
  const error = new DaemonAutostartTimeoutError(30_000, new Error("probe timeout"), selfPid);
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_starting");
  assert.match(classification.hint, /still starting/iu);
  assert.match(classification.hint, livePidRegex);
  assert.match(classification.hint, /60-90s/iu, "hint must set the honest cold-start expectation");
  // The two lethal actions must appear ONLY as explicit prohibitions, never as
  // recommendations. An agent following the hint verbatim must not be sent to
  // kill the recovering daemon.
  assert.match(classification.hint, /Do NOT run 'ha daemon restart'/u, "restart must be explicitly prohibited");
  assert.match(classification.hint, /Do NOT use HARNESS_DAEMON_MODE=direct/u, "direct mode must be explicitly prohibited");
  // The honest corrective action is to wait + poll:
  assert.match(classification.hint, /ha daemon status --json/iu);
  assert.match(classification.hint, /Wait/iu);
});

test("autostart timeout with a DEAD pid classifies as daemon_not_present (not starting)", () => {
  const error = new DaemonAutostartTimeoutError(30_000, new Error("probe timeout"), deadPid);
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_not_present");
  assert.match(classification.hint, /ha daemon start --service/u, "must offer a safe start");
  // A genuinely absent daemon may surface the direct recovery hatch — that is
  // the documented escape hatch for a confirmed-down daemon, not for a starting one.
  assert.match(classification.hint, /HARNESS_DAEMON_MODE=direct/u);
});

test("autostart process-exited classifies as daemon_not_present", () => {
  const error = new DaemonAutostartProcessExitedError(new Error("boom"), deadPid, "/tmp/launch.log");
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_not_present");
  assert.match(classification.hint, /exited before becoming ready/iu);
  assert.match(classification.hint, /ha daemon start --service/u);
  // No bare restart recommendation.
  assert.doesNotMatch(classification.hint, /(?:Start with|run|Run) 'ha daemon restart'/u);
});

test("circuit-open error classifies as daemon_unavailable and surfaces the honest stop condition", () => {
  const error = new DaemonAutostartCircuitOpenError(5, 5, 0, "/tmp/daemon.sock", new Error("last death"));
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_unavailable");
  assert.match(classification.hint, /DAEMON_AUTOSTART_CIRCUIT_OPEN/u);
  assert.match(classification.hint, /Do NOT/u, "the circuit message must carry its own do-not-restart guidance");
});

test("connection-refused (ECONNREFUSED) classifies as daemon_not_present", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED /tmp/daemon.sock"), { code: "ECONNREFUSED" });
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_not_present");
  assert.match(classification.hint, /No daemon is listening/u);
});

test("a generic unavailable error keeps the daemon_unavailable code and the recovery hatch", () => {
  const error = new Error("some other transport failure");
  const classification = classifyLocalDaemonLifecycle(error);
  assert.equal(classification.code, "daemon_unavailable");
  assert.match(classification.hint, /ha daemon status --json/u);
});
