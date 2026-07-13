// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compareAttributionShadow } from "../src/authority/shadow.ts";

test("attribution shadow comparison emits mismatch telemetry without canonical side effects", () => {
  const telemetry: unknown[] = [];
  const cursor = { revision: 41 };
  const receipt = { tag: "COMMITTED", opId: "op-1" };
  const commits = ["canonical-commit"];
  const canonical = observation("11");
  const shadow = { ...canonical, semanticMutationSetDigest: "22".repeat(32) };

  const result = compareAttributionShadow({
    workspaceId: "workspace-1",
    canonical,
    shadow,
    observedAt: "2026-07-13T00:00:00.000Z",
    telemetry: { emitMismatch: (event) => telemetry.push(event) }
  });

  assert.equal(result.status, "MISMATCH");
  assert.deepEqual(result.mismatches, ["semanticMutationSetDigest"]);
  assert.deepEqual(telemetry, [result]);
  assert.deepEqual(cursor, { revision: 41 });
  assert.deepEqual(receipt, { tag: "COMMITTED", opId: "op-1" });
  assert.deepEqual(commits, ["canonical-commit"]);
});

test("matching attribution shadow emits no telemetry", () => {
  const telemetry: unknown[] = [];
  const canonical = observation("11");
  const result = compareAttributionShadow({
    workspaceId: "workspace-1",
    canonical,
    shadow: { ...canonical },
    observedAt: "2026-07-13T00:00:00.000Z",
    telemetry: { emitMismatch: (event) => telemetry.push(event) }
  });
  assert.equal(result.status, "MATCH");
  assert.deepEqual(telemetry, []);
});

function observation(hexByte: string) {
  const digest = hexByte.repeat(32);
  return {
    opId: "op-1",
    semanticMutationSetDigest: digest,
    actorAxesBindingDigest: digest,
    changeSetDigest: digest,
    canonicalEventDigest: digest
  };
}
