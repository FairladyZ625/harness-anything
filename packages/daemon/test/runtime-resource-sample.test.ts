// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { availableMemoryFraction, cpuBusyFraction, cpuIdleFraction } from "../src/runtime-resource-sample.ts";

test("macOS uses memory_pressure availability, not the free page count", () => {
  assert.equal(
    availableMemoryFraction("darwin", "Pages free: 1\nSystem-wide memory free percentage: 64%\n", 128 * 1024 ** 3),
    0.64,
  );
});
test("Linux uses MemAvailable including reclaimable cache", () => {
  assert.equal(availableMemoryFraction("linux", "MemFree: 1 kB\nMemAvailable: 262144 kB\n", 1024 ** 3), 0.25);
});
test("Windows waits for a complete CPU interval and measures busy time", () => {
  assert.equal(cpuBusyFraction(null, { idle: 100, total: 200 }), null);
  assert.equal(cpuBusyFraction({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 0.75);
});
test("all platforms expose sampled CPU idle fraction", () => {
  assert.equal(cpuIdleFraction(null, { idle: 100, total: 200 }), null);
  assert.equal(cpuIdleFraction({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 0.25);
});
test("missing or invalid OS counters fail instead of reporting idle", () => {
  assert.throws(() => availableMemoryFraction("darwin", "Pages free: 500", 1));
  assert.throws(() => availableMemoryFraction("darwin", "System-wide memory free percentage: 101%", 1));
  assert.throws(() => availableMemoryFraction("linux", "MemFree: 100 kB", 1));
  assert.throws(() => cpuBusyFraction({ idle: 100, total: 200 }, { idle: 100, total: 200 }));
  assert.throws(() => cpuBusyFraction({ idle: 100, total: 200 }, { idle: 250, total: 300 }));
});
