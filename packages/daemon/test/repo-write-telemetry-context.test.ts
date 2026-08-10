// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindCurrentRepoWriteTelemetry,
  createRepoWriteTelemetryDelivery,
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

test("normal telemetry drains every phase in one terminal batch", async () => {
  const batches: unknown[][] = [];
  const streamed: string[] = [];
  const delivery = createRepoWriteTelemetryDelivery({
    deliverBatch: async (spans) => { batches.push([...spans]); },
    deliverStream: async (phase) => { streamed.push(phase); },
    streamAfterMs: 1_000
  });

  for (let index = 0; index < 140; index += 1) {
    delivery.report("git", index, { index });
  }
  await delivery.flush();
  delivery.close();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 140);
  assert.deepEqual(streamed, []);
});

test("a slow request publishes its buffered last will and then streams phases", async () => {
  const batches: string[][] = [];
  const streamed: string[] = [];
  const delivery = createRepoWriteTelemetryDelivery({
    deliverBatch: async (spans) => { batches.push(spans.map((span) => span.phase)); },
    deliverStream: async (phase) => { streamed.push(phase); },
    streamAfterMs: 5
  });

  delivery.report("queue", 0);
  delivery.report("compile", 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  delivery.report("git", 16);
  await delivery.flush();
  delivery.close();

  assert.deepEqual(batches, [["queue", "compile"]]);
  assert.deepEqual(streamed, ["git"]);
});
