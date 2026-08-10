// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCommandSurfaceParity,
  findCommandSurfaceParityViolations
} from "./check-command-surface-parity.mjs";

test("registry, capabilities, and packaged help stay in bidirectional parity", () => {
  assert.deepEqual(findCommandSurfaceParityViolations(), []);
});

test("positive mutation: deleting one registry entry makes the parity gate red", () => {
  const surface = collectCommandSurfaceParity();
  const removed = surface.registry.find((entry) => !surface.capabilityExclusions.has(entry.kind));
  assert.notEqual(removed, undefined);
  const violations = findCommandSurfaceParityViolations({
    ...surface,
    registry: surface.registry.filter((entry) => entry.kind !== removed.kind)
  });

  assert.equal(violations.some((message) => message.includes(`descriptor command ${removed.kind} is missing from registry`)), true);
  assert.equal(violations.some((message) => message.includes(`capabilities advertises unregistered command ${removed.kind}`)), true);
});
