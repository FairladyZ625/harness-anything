// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  __daemonAutostartCircuitStateForTest,
  daemonAutostartCircuitDecision,
  daemonAutostartCircuitOpenError,
  defaultDaemonAutostartMaxConsecutiveFailures,
  liveDaemonStartupPid,
  recordLiveDaemonStartup,
  reportDaemonAutostartOutcome,
  resetDaemonAutostartCircuit,
  resolveDaemonAutostartCircuitOptions,
  type DaemonAutostartCircuitOptions
} from "../src/client/daemon-autostart-circuit.ts";

const socketA = `/tmp/ha-circuit-test-a-${process.pid}.sock`;
const socketB = `/tmp/ha-circuit-test-b-${process.pid}.sock`;
const options: DaemonAutostartCircuitOptions = {
  maxConsecutiveFailures: 3,
  backoffBaseMs: 100,
  backoffCapMs: 1_000
};
const t0 = 10_000_000;

function reset() {
  resetDaemonAutostartCircuit(socketA);
  resetDaemonAutostartCircuit(socketB);
}

test("a timeout with a live spawned pid is treated as honest slow start, not a breaker failure", () => {
  reset();
  const livePid = process.pid; // the test process itself is alive
  reportDaemonAutostartOutcome(socketA, {
    ok: false,
    spawnedPid: livePid,
    processExited: false,
    cause: new Error("probe timeout")
  }, options, t0);
  const state = __daemonAutostartCircuitStateForTest(socketA);
  assert.equal(state?.consecutiveFailures, 0, "slow start must not count against the breaker");
  assert.equal(state?.liveStartupPid, livePid, "live pid recorded for joining");
  // While a live pid is recorded, the decision suppresses sibling spawns even
  // though the breaker itself has zero failures: the join path owns this.
  const decision = daemonAutostartCircuitDecision(socketA, options, t0);
  assert.equal(decision.consecutiveFailures, 0);
});

test("a timeout with a dead spawned pid counts against the breaker and applies backoff", () => {
  reset();
  const deadPid = 999_999; // not alive
  reportDaemonAutostartOutcome(socketA, {
    ok: false,
    spawnedPid: deadPid,
    processExited: true,
    cause: new Error("exited")
  }, options, t0);
  const state = __daemonAutostartCircuitStateForTest(socketA);
  assert.equal(state?.consecutiveFailures, 1);
  assert.equal(state?.liveStartupPid, undefined);
  // Immediately after the failure, backoff is in effect: spawn disallowed.
  const immediate = daemonAutostartCircuitDecision(socketA, options, t0);
  assert.equal(immediate.allowSpawn, false, "backoff must gate the retry");
  assert.ok(immediate.retryAfterMs > 0);
  // After the backoff window passes, spawn is allowed again (1 < 3 limit).
  const afterBackoff = daemonAutostartCircuitDecision(socketA, options, t0 + 200);
  assert.equal(afterBackoff.allowSpawn, true);
});

test("after N consecutive deaths the breaker opens and refuses to spawn", () => {
  reset();
  for (let i = 0; i < 3; i += 1) {
    reportDaemonAutostartOutcome(socketA, {
      ok: false,
      spawnedPid: 999_990 + i,
      processExited: true,
      cause: new Error(`death ${i + 1}`)
    }, options, t0 + i * 1_000);
  }
  // Even well past the last backoff, the failure limit keeps it open.
  const decision = daemonAutostartCircuitDecision(socketA, options, t0 + 100_000);
  assert.equal(decision.allowSpawn, false, "breaker must open after N deaths");
  assert.equal(decision.consecutiveFailures, 3);
  assert.ok(decision.lastCause instanceof Error);
});

test("the refusal text says backing off while backing off, and giving up only once it gives up", () => {
  reset();
  reportDaemonAutostartOutcome(socketA, {
    ok: false,
    spawnedPid: 999_999,
    processExited: true,
    cause: new Error("exited")
  }, options, t0);
  const backingOff = daemonAutostartCircuitOpenError(
    socketA,
    daemonAutostartCircuitDecision(socketA, options, t0),
    options
  );
  assert.match(backingOff.message, /DAEMON_AUTOSTART_BACKOFF/u);
  assert.ok(
    !backingOff.message.includes("stopped autostarting"),
    `one failure of three is not giving up; got: ${backingOff.message}`
  );

  for (let i = 1; i < 3; i += 1) {
    reportDaemonAutostartOutcome(socketA, {
      ok: false,
      spawnedPid: 999_990 + i,
      processExited: true,
      cause: new Error(`death ${i + 1}`)
    }, options, t0 + i * 10_000);
  }
  const gaveUp = daemonAutostartCircuitOpenError(
    socketA,
    daemonAutostartCircuitDecision(socketA, options, t0 + 100_000),
    options
  );
  assert.match(gaveUp.message, /DAEMON_AUTOSTART_CIRCUIT_OPEN: stopped autostarting/u);
  assert.ok(
    !gaveUp.message.includes("DAEMON_AUTOSTART_BACKOFF"),
    `an open breaker must not also claim it is merely backing off; got: ${gaveUp.message}`
  );
});

test("a successful ready resets the breaker completely", () => {
  reset();
  reportDaemonAutostartOutcome(socketA, {
    ok: false,
    spawnedPid: 999_999,
    processExited: true,
    cause: new Error("death")
  }, options, t0);
  assert.equal(__daemonAutostartCircuitStateForTest(socketA)?.consecutiveFailures, 1);
  reportDaemonAutostartOutcome(socketA, {
    ok: true,
    spawnedPid: undefined,
    processExited: false,
    cause: undefined
  }, options, t0);
  assert.equal(__daemonAutostartCircuitStateForTest(socketA)?.consecutiveFailures, 0);
  assert.equal(daemonAutostartCircuitDecision(socketA, options, t0).allowSpawn, true);
});

test("circuit state is isolated per socket", () => {
  reset();
  reportDaemonAutostartOutcome(socketA, {
    ok: false,
    spawnedPid: 999_999,
    processExited: true,
    cause: new Error("a")
  }, options, t0);
  assert.equal(__daemonAutostartCircuitStateForTest(socketA)?.consecutiveFailures, 1);
  assert.equal(__daemonAutostartCircuitStateForTest(socketB)?.consecutiveFailures, 0);
  assert.equal(daemonAutostartCircuitDecision(socketB, options, t0).allowSpawn, true);
});

test("liveDaemonStartupPid clears a recorded pid that has since exited", () => {
  reset();
  recordLiveDaemonStartup(socketA, 999_999); // not alive
  assert.equal(liveDaemonStartupPid(socketA), undefined);
});

test("backoff grows exponentially and is capped", () => {
  reset();
  const capOptions: DaemonAutostartCircuitOptions = {
    maxConsecutiveFailures: 10,
    backoffBaseMs: 100,
    backoffCapMs: 500
  };
  reportDaemonAutostartOutcome(socketA, {
    ok: false, spawnedPid: 999_998, processExited: true, cause: new Error("1")
  }, capOptions, t0);
  const d1 = daemonAutostartCircuitDecision(socketA, capOptions, t0);
  assert.ok(d1.retryAfterMs >= 100, `first backoff >= base: ${d1.retryAfterMs}`);

  reportDaemonAutostartOutcome(socketA, {
    ok: false, spawnedPid: 999_997, processExited: true, cause: new Error("2")
  }, capOptions, t0);
  const d2 = daemonAutostartCircuitDecision(socketA, capOptions, t0);
  assert.ok(d2.retryAfterMs > d1.retryAfterMs, "backoff must grow");

  for (let i = 3; i <= 5; i += 1) {
    reportDaemonAutostartOutcome(socketA, {
      ok: false, spawnedPid: 999_997 - i, processExited: true, cause: new Error(String(i))
    }, capOptions, t0);
  }
  const d5 = daemonAutostartCircuitDecision(socketA, capOptions, t0);
  assert.ok(d5.retryAfterMs <= 500, `backoff must be capped: ${d5.retryAfterMs}`);
});

test("default options resolve from env", () => {
  const opts = resolveDaemonAutostartCircuitOptions({
    HARNESS_DAEMON_AUTOSTART_MAX_FAILURES: "7",
    HARNESS_DAEMON_AUTOSTART_BACKOFF_MS: "1234",
    HARNESS_DAEMON_AUTOSTART_BACKOFF_CAP_MS: "20000"
  });
  assert.equal(opts.maxConsecutiveFailures, 7);
  assert.equal(opts.backoffBaseMs, 1234);
  assert.equal(opts.backoffCapMs, 20000);
  const defaults = resolveDaemonAutostartCircuitOptions({});
  assert.equal(defaults.maxConsecutiveFailures, defaultDaemonAutostartMaxConsecutiveFailures);
});

test("resetDaemonAutostartCircuit clears a single socket without touching others", () => {
  reset();
  reportDaemonAutostartOutcome(socketA, {
    ok: false, spawnedPid: 999_999, processExited: true, cause: new Error("a")
  }, options, t0);
  reportDaemonAutostartOutcome(socketB, {
    ok: false, spawnedPid: 999_998, processExited: true, cause: new Error("b")
  }, options, t0);
  resetDaemonAutostartCircuit(socketA);
  assert.equal(__daemonAutostartCircuitStateForTest(socketA)?.consecutiveFailures, 0);
  assert.equal(__daemonAutostartCircuitStateForTest(socketB)?.consecutiveFailures, 1);
});
