// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindCurrentRepoWriteTelemetry,
  reportCurrentRepoWriteTelemetry,
  runWithRepoWriteTelemetry
} from "../src/runtime/repo-write-telemetry-context.ts";

test("a queued callback retains the request telemetry context that admitted it", () => {
  const phases: string[] = [];
  const queued = runWithRepoWriteTelemetry(
    (phase) => phases.push(phase),
    () => bindCurrentRepoWriteTelemetry(() => {
      reportCurrentRepoWriteTelemetry("materializer");
    })
  );

  queued();

  assert.deepEqual(phases, ["materializer"]);
});
