// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { resetRequestTraceSampling, shouldTraceRequest } from "../src/daemon-request-sampling.ts";

test("diagnostic polls are sampled only above the full-rate window; business requests are never sampled out", () => {
  resetRequestTraceSampling();
  const start = 1_000;
  for (let index = 0; index < 2_000; index += 1) assert.equal(shouldTraceRequest("daemon.status", start), true);
  let diagnostic = 0,
    business = 0;
  for (let index = 0; index < 400; index += 1) if (shouldTraceRequest("daemon.status", start)) diagnostic += 1;
  for (let index = 0; index < 400; index += 1) if (shouldTraceRequest("repo.task.run", start)) business += 1;
  assert.equal(diagnostic, 8);
  assert.equal(business, 400);
});

test("a new second restores full tracing", () => {
  resetRequestTraceSampling();
  for (let index = 0; index < 2_100; index += 1) shouldTraceRequest("protocol.hello", 1_000);
  assert.equal(shouldTraceRequest("protocol.hello", 1_000), false);
  assert.equal(shouldTraceRequest("protocol.hello", 2_001), true);
});
