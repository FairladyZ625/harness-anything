// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { concurrencyGate } from "../src/ci-observation-actions.ts";

test("the gh call gate never runs more than its limit at once and keeps every result", async () => {
  const gate = concurrencyGate(4);
  let active = 0;
  let peak = 0;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return index;
      }),
    ),
  );
  assert.equal(peak, 4);
  assert.deepEqual(
    results,
    Array.from({ length: 20 }, (_, index) => index),
  );
});

test("a failing work releases its slot to the next waiter", async () => {
  const gate = concurrencyGate(1);
  const first = gate(async () => {
    throw new Error("gh failed");
  });
  const second = gate(async () => "second ran");
  await assert.rejects(first, /gh failed/u);
  assert.equal(await second, "second ran");
});
