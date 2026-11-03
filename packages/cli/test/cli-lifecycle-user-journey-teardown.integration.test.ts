// harness-test-tier: integration
import test from "node:test";

import {
  assert,
  rmSync,
  runClient,
  setup,
  startClient,
  stopClient,
  waitForDaemonExit,
} from "./cli-lifecycle-user-journey-stress.fixture.ts";

// The eight-client stress case can exhaust the daemon's 10s start budget on Windows, which would
// keep the teardown assertion below from ever running. One client exercises the same ownership
// boundary: start a resident daemon, write through it, stop it, then remove the temporary root.
test("one isolated CLI client stops its daemon before the temporary root is removed", async () => {
  const fixture = setup(0);
  try {
    await startClient(fixture);
    const outcomes = await runClient(fixture, 0);
    assert.equal(outcomes.length, 3);
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("daemon exit wait names a process that never releases its endpoint", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      waitForDaemonExit({
        pid: () => 999_999,
        deadline: Date.now() + 20,
        alive: () => true,
        endpointExists: () => true,
        delayMs: 5,
      }),
    /daemon-stop deadline exceeded/u,
  );
  assert.ok(Date.now() - startedAt < 1_000, "the deadline must bound the wait, not the probe");
});

test("daemon exit wait returns once the process and endpoint are gone", async () => {
  await waitForDaemonExit({
    pid: () => null,
    deadline: Date.now() + 20,
    alive: () => false,
    endpointExists: () => false,
  });
});

test("daemon exit wait keeps probing after a PID appears below the initial snapshot", async () => {
  let pid: number | null = null,
    endpoint = true,
    discoveries = 0;
  await assert.rejects(
    () =>
      waitForDaemonExit({
        pid: () => pid,
        deadline: Date.now() + 40,
        alive: (value) => value === 999_999,
        endpointExists: () => endpoint,
        onStalled: () => {
          discoveries += 1;
          pid = 999_999;
          endpoint = false;
        },
        delayMs: 5,
      }),
    /daemon-stop deadline exceeded/u,
  );
  assert.ok(discoveries > 0, "the helper must keep probing after the PID is discovered");
});
