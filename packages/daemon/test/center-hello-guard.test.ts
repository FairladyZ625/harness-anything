// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createHelloRateLimiter } from "../src/fleet/center-hello-guard.ts";

const sourceA = "203.0.113.9",
  sourceB = "198.51.100.7";

test("a valid credential always reaches authentication and clears prior failures from the same source", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return true;
    },
    { limit: 1, windowMs: 1_000, now: () => 0 },
  );
  assert.equal(await limiter("node-one", "secret", sourceA), true);
  assert.equal(await limiter("node-one", "secret", sourceA), true);
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
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(checks, 3);
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(checks, 3, "the refused hello must not re-introspect the credential");
});

test("a success after failures resets the source's budget", async () => {
  const verdicts = [false, true, false];
  let checks = 0;
  const limiter = createHelloRateLimiter(() => verdicts[checks++] ?? false, {
    limit: 2,
    windowMs: 1_000,
    now: () => 0,
  });
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(await limiter("node-one", "good", sourceA), true);
  assert.equal(await limiter("node-one", "bad", sourceA), false, "the fresh budget admits one more credential check");
  assert.equal(checks, 3);
});

test("the failure window passing admits the source again", async () => {
  let clock = 0;
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, now: () => clock },
  );
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(checks, 1, "still inside the window: refused locally");
  clock = 1_001;
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(checks, 2, "the window passed: the credential check runs again");
});

test("rotating the claimed node id cannot refill the failure budget", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 2, windowMs: 1_000, now: () => 0 },
  );
  assert.equal(await limiter("rotated-one", "bad", sourceA), false);
  assert.equal(await limiter("rotated-two", "bad", sourceA), false);
  assert.equal(checks, 2);
  // A fresh id from the same source buys no further credential check.
  assert.equal(await limiter("rotated-three", "bad", sourceA), false);
  assert.equal(checks, 2, "a fresh id must not buy another credential check from the same source");
  // A valid credential for an id that never failed does not regain admission while the source is spent.
  assert.equal(await limiter("node-one", "good", sourceA), false);
  assert.equal(checks, 2);
});

test("a third party's failures on one source never spend a real node's budget on another", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, now: () => 0 },
  );
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(await limiter("node-one", "bad", sourceA), false);
  assert.equal(await limiter("node-one", "good", sourceB), false);
  assert.equal(checks, 2, "the real node's source still reaches the credential check");
});

test("the tracked-source bound drops the oldest sources first", async () => {
  let checks = 0;
  const limiter = createHelloRateLimiter(
    () => {
      checks += 1;
      return false;
    },
    { limit: 1, windowMs: 1_000, trackedSources: 2, now: () => 0 },
  );
  for (const source of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) await limiter("node-one", "bad", source);
  assert.equal(checks, 3);
  await limiter("node-one", "bad", "192.0.2.3");
  assert.equal(checks, 3, "the newest source is still tracked: refused locally");
  await limiter("node-one", "bad", "192.0.2.1");
  assert.equal(checks, 4, "the oldest source was dropped: its next hello re-checks");
});
