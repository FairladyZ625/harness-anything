// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker, type TransferListItem } from "node:worker_threads";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { withDaemonObservation, observeDaemonOperation, markDaemonOperationPhase } from "../src/daemon-operation.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { daemonDiagnosticsEndpoint, localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { measureCpuWindow } from "./fixtures/diagnostics-cpu-window.ts";

const REGISTRATIONS_PER_SECOND = 100,
  REGISTRATIONS_PER_TICK = REGISTRATIONS_PER_SECOND / 10, // one 100 ms tick
  MEASURED_TICKS = 100, // 100 ticks × 100 ms = the 10 s window the 2 % budget is stated over
  REGISTRATIONS = REGISTRATIONS_PER_SECOND * 10;

// The product budget is 2 % of one CPU at 100 registrations/s. A CPU-percent assertion cannot gate
// at that margin on shared runners: identical code measured 1.56–2.52 % of one CPU across Linux
// hosts and GitHub runners, the empty baseline on the isolation server ranged 14–119 ms, and a
// fresh process' first window absorbs one-time worker startup. So also gate the deterministic
// workload that produces the CPU: registrations are published through the shared in-flight table,
// so no registration may cross the thread boundary as a message (or as a batch of them), and no
// registration may persist a record. Total CPU is still asserted against the unchanged 2 % budget.
// Count the real main-thread → worker messages, not observer calls, so a per-registration send or a
// batch send fails even when it bypasses the observer contract.
function monitorWorkerMessages() {
  const types: string[] = [],
    original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, value: unknown, transferList?: readonly TransferListItem[]) {
    const type = (value as { type?: unknown } | null)?.type;
    types.push(typeof type === "string" ? type : "unknown");
    original.call(this, value, transferList);
  };
  return {
    types,
    restore: () => {
      Worker.prototype.postMessage = original;
    },
  };
}

let registrations = 0;
function register() {
  registrations += 1;
  return observeDaemonOperation({ method: "fixture.request", repoId: "repo-a", actor: "node-a" }, () => {
    markDaemonOperationPhase("projection-read");
  });
}

test(
  "watchdog registration at 100 requests per second shares in-flight state without per-request messages and stays within two percent CPU",
  { timeout: 40_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-diag-cpu-")),
      endpoint = localUserDaemonEndpoint(root, "diagnostics-cpu");
    try {
      const diagnostics = await openDaemonDiagnostics({ userRoot: root, daemonId: "cpu", endpoint }),
        monitored = monitorWorkerMessages(),
        held = diagnostics.observer.begin({ method: "fixture.held", phase: "measuring" });
      let observed: Awaited<ReturnType<typeof measureCpuWindow>> = { cpuMs: 0, elapsedMs: 1, cpuPercent: 0 };
      const messages = { begin: 0, update: 0, end: 0, batches: 0, other: 0 };
      try {
        // Settle the worker's one-time startup and JIT outside the measured window; otherwise the
        // first window reports startup as resident overhead and overstates the budget.
        await withDaemonObservation(diagnostics.observer, () => measureCpuWindow(10, REGISTRATIONS_PER_TICK, register));
        const firstMeasuredMessage = monitored.types.length,
          firstMeasuredRegistration = registrations;
        observed = await withDaemonObservation(diagnostics.observer, () =>
          measureCpuWindow(MEASURED_TICKS, REGISTRATIONS_PER_TICK, register),
        );
        for (const type of monitored.types.slice(firstMeasuredMessage)) {
          if (type === "begin") messages.begin += 1;
          else if (type === "update") messages.update += 1;
          else if (type === "end") messages.end += 1;
          else if (type === "operations") messages.batches += 1;
          else messages.other += 1;
        }
        const status = await requestDaemonJsonRpcAt(
          daemonDiagnosticsEndpoint(endpoint),
          "daemon.status",
          {},
          1_000,
          2_000,
        );
        // The held operation proves the worker reads the same shared table the measured workload
        // writes; a registration cannot hide behind a message-based path.
        const inFlight = status.inFlight as { method: string; phase: string }[];
        assert.deepEqual(
          inFlight.map(({ method, phase }) => ({ method, phase })),
          [{ method: "fixture.held", phase: "measuring" }],
        );
        assert.ok((status.metrics as Record<string, unknown>).heapUsed! > 0);
        assert.equal(registrations - firstMeasuredRegistration, REGISTRATIONS);
      } finally {
        held.end();
        monitored.restore();
        await diagnostics.close();
      }
      const files = readdirSync(path.join(root, "logs")).filter((name) => name.includes("diagnostics")),
        contents = files.map((name) => readFileSync(path.join(root, "logs", name), "utf8")),
        bytes = contents.reduce((size, text) => size + Buffer.byteLength(text), 0),
        records = contents
          .flatMap((text) => text.split("\n").filter((line) => line.startsWith("{")))
          .map((line) => JSON.parse(line) as { reason?: string }),
        periodicRecords = records.filter((record) => record.reason === "metrics"),
        stallRecords = records.filter((record) => String(record.reason ?? "").startsWith("stall_")),
        registrationMessages = messages.begin + messages.update + messages.end,
        registrationMessageBatches = messages.batches,
        report = {
          node: process.version,
          platform: process.platform,
          windowMs: Math.round(observed.elapsedMs),
          cpuMs: observed.cpuMs,
          cpuPercent: observed.cpuPercent,
          budgetPercent: 2,
          withinBudget: observed.cpuPercent < 2,
          registrations: REGISTRATIONS,
          registrationMessages,
          registrationMessageBatches,
          messagesPerSecond: (registrationMessages + registrationMessageBatches) / (observed.elapsedMs / 1_000),
          otherMessages: messages.other,
          persistedRecords: records.length,
          periodicRecords: periodicRecords.length,
          stallRecords: stallRecords.length,
          bytesPerDay: (bytes * 86_400_000) / observed.elapsedMs,
        };
      console.log("diagnostics workload measurement", JSON.stringify(report));

      assert.equal(registrationMessages, 0, `per-registration messages: ${JSON.stringify(report)}`);
      assert.equal(registrationMessageBatches, 0, `registration batches: ${JSON.stringify(report)}`);
      assert.ok(messages.other <= 2, `non-registration messages: ${JSON.stringify(report)}`);
      assert.equal(
        records.length - periodicRecords.length - stallRecords.length,
        0,
        `registration must not persist a record per request: ${JSON.stringify(report)}`,
      );
      assert.ok(periodicRecords.length <= 4, `periodic persistence: ${JSON.stringify(report)}`);
      assert.ok(report.withinBudget, `steady-state CPU budget: ${JSON.stringify(report)}`);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

// Observe each transition through the real socket; message accounting stays outside the CPU window.
test("diagnostics publishes every in-flight phase instead of retaining the first update", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-diag-messages-")),
    endpoint = localUserDaemonEndpoint(root, "diagnostics-messages"),
    diagnostics = await openDaemonDiagnostics({ userRoot: root, daemonId: "messages", endpoint });
  try {
    await withDaemonObservation(diagnostics.observer, () =>
      observeDaemonOperation({ method: "fixture.request" }, async () => {
        for (const phase of [
          "authorization",
          "repository-admission",
          "write-queue",
          "write-execution",
          "serialization",
          "reply",
        ]) {
          markDaemonOperationPhase(phase);
          const status = await requestDaemonJsonRpcAt(
            daemonDiagnosticsEndpoint(endpoint),
            "daemon.status",
            {},
            1_000,
            2_000,
          );
          const operations = status.inFlight as { method: string; phase: string }[];
          assert.deepEqual(
            operations.map(({ method, phase }) => ({ method, phase })),
            [{ method: "fixture.request", phase }],
          );
        }
      }),
    );
    const status = await requestDaemonJsonRpcAt(daemonDiagnosticsEndpoint(endpoint), "daemon.status", {}, 1_000, 2_000);
    assert.deepEqual(status.inFlight, []);
  } finally {
    await diagnostics.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
