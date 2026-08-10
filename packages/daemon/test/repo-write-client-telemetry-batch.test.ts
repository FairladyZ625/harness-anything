// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { RepoWriteClient } from "../src/runtime/repo-write-client.ts";
import {
  FakeRepoWriteTransport,
  childFrame,
  command,
  readyFrame,
  requestId
} from "./support/repo-write-client-fixture.ts";
import {
  committedCommandReceipt,
  rejectedCommandReceipt
} from "./support/repo-write-terminal-fixture.ts";

test("observes one correlated telemetry batch without expanding it for batch-aware consumers", async () => {
  const transport = new FakeRepoWriteTransport();
  const batches: unknown[] = [];
  const legacyFrames: unknown[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: (frame) => legacyFrames.push(frame),
    onTelemetryBatch: (batch) => batches.push(batch)
  });
  transport.emit(readyFrame());
  const result = client.submit(command("task.create"));
  const submit = transport.sent.at(-1);
  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-batch"
  });
  transport.emit({
    ...childFrame("telemetry-batch"),
    requestId: requestId(submit),
    opId: "op-batch",
    spans: [
      { phase: "queue", elapsedMs: 0 },
      { phase: "child-terminal-response", elapsedMs: 5 }
    ]
  });
  const receipt = committedCommandReceipt();
  transport.emit({
    ...childFrame("terminal"),
    requestId: requestId(submit),
    opId: "op-batch",
    outcome: "committed",
    receipt
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(legacyFrames, []);
  assert.deepEqual(await result, receipt);
});

test("expands telemetry batches for legacy single-frame observers", async () => {
  const transport = new FakeRepoWriteTransport();
  const phases: string[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: (frame) => phases.push(frame.phase)
  });
  transport.emit(readyFrame());
  const result = client.direct(command("task.claim"));
  const request = transport.sent.at(-1);
  transport.emit({
    ...childFrame("telemetry-batch"),
    requestId: requestId(request),
    spans: [
      { phase: "queue", elapsedMs: 0 },
      { phase: "compile", elapsedMs: 1 }
    ]
  });
  const receipt = rejectedCommandReceipt();
  transport.emit({
    ...childFrame("direct-result"),
    requestId: requestId(request),
    receipt
  });

  assert.deepEqual(phases, ["queue", "compile"]);
  assert.deepEqual(await result, receipt);
});
