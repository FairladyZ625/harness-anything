// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { waitForArrival } from "./event-arrival.ts";

test("an arrival during the first absent read is not lost", async () => {
  let arrive: (() => void) | undefined,
    subscribed = false,
    reads = 0;
  const wait = waitForArrival(
    () => {
      assert.equal(subscribed, true, "the durable read must run after the subscription");
      reads += 1;
      if (reads === 1) {
        // Publish after this read has observed nothing. A check-then-subscribe wait discards this
        // only wake-up and parks forever; subscribing first keeps it.
        arrive?.();
        return null;
      }
      return "published";
    },
    (notify) => {
      arrive = notify;
      subscribed = true;
      return () => {
        arrive = undefined;
        subscribed = false;
      };
    },
  );
  let settled = false;
  void wait.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "the wait returned instead of parking without a wake-up");
  assert.equal(await wait, "published");
  assert.equal(subscribed, false, "the wait removed its subscription");
});

test("an arrival after the absent read wakes the parked wait", async () => {
  let arrive: (() => void) | undefined,
    reads = 0;
  const wait = waitForArrival(
    () => (++reads === 1 ? null : "published"),
    (notify) => {
      arrive = notify;
      return () => {
        arrive = undefined;
      };
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "the read parked because the event was not published yet");
  arrive?.();
  assert.equal(await wait, "published");
});
