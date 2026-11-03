// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDaemonOperation,
  currentDaemonOperationTrace,
  markDaemonOperationPhase,
  observeDaemonOperation,
  observeDaemonRequest,
  recordDaemonOperationPhaseSpan,
  updateDaemonOperation,
  withDaemonObservation,
  type DaemonOperationObserver,
  type DaemonOperationTrace,
} from "../src/daemon-operation.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

function collector() {
  const begins: Record<string, unknown>[] = [];
  const traces: DaemonOperationTrace[] = [];
  const observer: DaemonOperationObserver = {
    begin: (fields) => {
      begins.push({ ...fields });
      return {
        update: () => undefined,
        end: (trace) => {
          if (trace) traces.push(trace);
        },
      };
    },
  };
  return { observer, begins, traces };
}

test("one request carries trace ids, node and request/reply bytes through its phase windows", () => {
  const observed = collector();
  let captured: ReturnType<typeof captureDaemonOperation> = null;
  const result = withDaemonObservation(observed.observer, () =>
    observeDaemonOperation(
      {
        method: "repo.task.show",
        repoId: "repo-a",
        actor: "person-a",
        nodeId: "node-7",
        phase: "authentication",
        requestBytes: 120,
      },
      () => {
        captured = captureDaemonOperation();
        markDaemonOperationPhase("authorization");
        markDaemonOperationPhase("projection-read");
        const started = performance.now();
        while (performance.now() - started < 10) {
          /* deliberate slow stage */
        }
        updateDaemonOperation({ outcome: "ok", replyBytes: 240 });
        return 42;
      },
    ),
  );
  assert.equal(result, 42);
  assert.ok(captured);
  assert.equal(observed.begins.length, 1);
  assert.match(String(observed.begins[0]!.traceId), /^[0-9a-f]{32}$/u);
  assert.match(String(observed.begins[0]!.spanId), /^[0-9a-f]{16}$/u);
  const trace = observed.traces[0]!;
  assert.equal(trace.nodeId, "node-7");
  assert.equal(trace.requestBytes, 120);
  assert.equal(trace.replyBytes, 240);
  assert.equal(trace.outcome, "ok");
  assert.deepEqual(
    trace.phases.map((phase) => phase.name),
    ["authentication", "authorization", "projection-read"],
  );
  const projection = trace.phases.find((phase) => phase.name === "projection-read")!;
  assert.ok(projection.endedAtMs - projection.startedAtMs >= 8);
});

test("an explicit writer window closes the queue stage and opens no duplicate phase", () => {
  const observed = collector();
  withDaemonObservation(observed.observer, () =>
    observeDaemonOperation({ method: "repo.task.run", phase: "authentication" }, () => {
      markDaemonOperationPhase("authorization");
      markDaemonOperationPhase("write-queue");
      const queued = performance.now();
      while (performance.now() - queued < 5) {
        /* queue wait */
      }
      const startedAtMs = Number(process.hrtime.bigint() / 1_000_000n);
      recordDaemonOperationPhaseSpan("write-execution", startedAtMs, startedAtMs + 20);
      assert.deepEqual(
        currentDaemonOperationTrace()!.phases.map((phase) => phase.name),
        ["authentication", "authorization", "write-queue", "write-execution"],
      );
    }),
  );
  const trace = observed.traces[0]!;
  const queue = trace.phases.find((phase) => phase.name === "write-queue")!;
  const execution = trace.phases.find((phase) => phase.name === "write-execution")!;
  assert.ok(queue.endedAtMs - queue.startedAtMs >= 4, JSON.stringify(trace.phases));
  assert.ok(queue.endedAtMs <= execution.startedAtMs);
  assert.ok(execution.endedAtMs - execution.startedAtMs >= 20);
});

test("captured handle marks phases after the request context is gone", () => {
  const observed = collector();
  let handle: ReturnType<typeof captureDaemonOperation> = null;
  withDaemonObservation(observed.observer, () =>
    observeDaemonOperation({ method: "repo.task.run", phase: "authentication" }, () => {
      handle = captureDaemonOperation();
    }),
  );
  assert.ok(handle);
  const base = Number(process.hrtime.bigint() / 1_000_000n);
  handle!.phaseSpan("write-execution", base + 10, base + 30);
  const phases = handle!.trace().phases;
  assert.deepEqual(
    phases.map((phase) => phase.name),
    ["authentication", "write-execution"],
  );
  assert.equal(phases[1]!.startedAtMs, base + 10);
  assert.equal(phases[1]!.endedAtMs, base + 30);
});

test("observeDaemonRequest records the authenticated fleet node, never a payload claim", () => {
  const observed = collector();
  const auth = {
    transportKind: "fleet-tls",
    nodePrincipal: { nodeId: "node-9", personId: "person-9" },
  } as DaemonAuthenticationContext;
  withDaemonObservation(observed.observer, () =>
    observeDaemonRequest(
      { jsonrpc: "2.0", id: 1, method: "daemon.status", params: { repoId: "repo-a" } },
      auth,
      () => undefined,
    ),
  );
  const trace = observed.traces[0]!;
  assert.equal(trace.nodeId, "node-9");
});
