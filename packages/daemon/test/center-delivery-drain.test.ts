// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createFleetDeliveryDrain } from "../src/fleet/center-delivery-drain.ts";

for (const order of [
  ["preparationFinished", "sendingFinished", "released"],
  ["preparationFinished", "released", "sendingFinished"],
  ["released", "preparationFinished", "sendingFinished"],
] as const) {
  test(`delivery drain waits for every owned phase: ${order.join(" → ")}`, () => {
    let notifications = 0;
    const drain = createFleetDeliveryDrain(() => notifications++);
    const first = drain.admit();
    const second = drain.admit();
    for (const [index, phase] of order.entries()) {
      first[phase]();
      assert.equal(drain.pending(), index === 2 ? 1 : 2);
      assert.equal(notifications, index === 2 ? 1 : 0);
    }
    first.released();
    first.sendingFinished();
    assert.equal(notifications, 1, "abort and pump failure can release the same delivery");
    for (const phase of order) second[phase]();
    assert.equal(drain.pending(), 0);
    assert.equal(notifications, 2);
  });
}
