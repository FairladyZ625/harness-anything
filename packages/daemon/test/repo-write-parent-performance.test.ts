// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonRequestPerformanceTrace,
  runWithDaemonRequestPerformanceTrace
} from "../src/observability/request-performance.ts";
import {
  FakeRepoWriteTransport,
  childFrame,
  command,
  readyClient,
  requestId
} from "./support/repo-write-client-fixture.ts";
import { committedCommandReceipt } from "./support/repo-write-terminal-fixture.ts";

test("parent telemetry separates child dispatch wait from child execution", async () => {
  let now = 0;
  const trace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId: "direct-parent-phases",
    receivedAtMs: 0,
    now: () => now
  });
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);

  await runWithDaemonRequestPerformanceTrace(trace, async () => {
    const result = client.direct(command("task.claim"));
    const request = transport.sent.at(-1);
    now = 4;
    transport.emit({
      ...childFrame("telemetry"),
      requestId: requestId(request),
      phase: "queue",
      elapsedMs: 0
    });
    now = 10;
    transport.emit({
      ...childFrame("direct-result"),
      requestId: requestId(request),
      receipt: committedCommandReceipt()
    });
    await result;
  });

  const summary = trace.finish("response-written");
  assert.equal(summary.phasesMs["repo-write-dispatch"], 4);
  assert.equal(summary.phasesMs["repo-write-child"], 6);
});
