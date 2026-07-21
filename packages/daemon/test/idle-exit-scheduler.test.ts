// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDaemonIdleExitScheduler } from "../src/service/idle-exit-scheduler.ts";

test("background authority recovery keeps an idle daemon alive until recovery settles", async () => {
  let recovering = true;
  let idleStops = 0;
  const scheduler = createDaemonIdleExitScheduler({
    idleMs: 25,
    isStopping: () => false,
    activeConnections: () => 0,
    hasActiveWork: () => recovering,
    requestIdleStop: () => { idleStops += 1; }
  });
  try {
    scheduler.schedule();
    await delay(90);
    assert.equal(idleStops, 0);

    recovering = false;
    const deadline = Date.now() + 250;
    while (idleStops === 0 && Date.now() < deadline) await delay(5);
    assert.equal(idleStops, 1);
  } finally {
    scheduler.disarm();
  }
});
