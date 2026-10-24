// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createHelloRateLimiter } from "../src/fleet/center-hello-guard.ts";

test("a valid credential always reaches authentication and clears prior failures", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return true;
    },
    { limit: 1, windowMs: 1_000, now: () => 0 },
  );
  assert.equal(await limiter("node-one", "secret"), true);
  assert.equal(await limiter("node-one", "secret"), true);
  assert.equal(checks, 2);
});

test("a spent failure budget is refused locally without consulting the credential", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 3, windowMs: 1_000, now: () => 0 },
  );
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(checks, 3);
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(checks, 3, "the refused hello must not re-introspect the credential");
});

test("a success after failures resets the node's budget", async () => {
  const verdicts = [false, true, false];
  let checks = 0;
  const limiter = createHelloRateLimiter(() => verdicts[checks++] ?? false, {
    limit: 2,
    windowMs: 1_000,
    now: () => 0,
  });
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(await limiter("node-one", "good"), true);
  assert.equal(await limiter("node-one", "bad"), false, "the fresh budget admits one more credential check");
  assert.equal(checks, 3);
});

test("the failure window passing admits the node again", async () => {
  let clock = 0;
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, now: () => clock },
  );
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(checks, 1, "still inside the window: refused locally");
  clock = 1_001;
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(checks, 2, "the window passed: the credential check runs again");
});

test("one node's failures never touch another node's budget", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, now: () => 0 },
  );
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(await limiter("node-one", "bad"), false);
  assert.equal(await limiter("node-two", "good"), false);
  assert.equal(checks, 2, "node-two's first hello still reaches the credential check");
});

test("the tracked-node bound drops the oldest nodes first", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, trackedNodes: 2, now: () => 0 },
  );
  for (const nodeId of ["node-a", "node-b", "node-c"]) await limiter(nodeId, "bad");
  assert.equal(checks, 3);
  await limiter("node-c", "bad");
  assert.equal(checks, 3, "node-c is still tracked: refused locally");
  await limiter("node-a", "bad");
  assert.equal(checks, 4, "node-a was the oldest failure and was dropped: its next hello re-checks");
});
