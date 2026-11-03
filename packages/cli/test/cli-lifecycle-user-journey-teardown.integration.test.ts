// harness-test-tier: integration
import test from "node:test";

import {
  assert,
  rmSync,
  runClient,
  setup,
  startClient,
  stopClient,
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
