// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { withDaemonObservation, observeDaemonOperation, markDaemonOperationPhase } from "../src/daemon-operation.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { daemonDiagnosticsEndpoint, localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";

// A finite 10-second observation window, with exactly 100 simulated node requests per second.
// Timer ticks drive the workload; this is a CPU measurement, not a sleep used for synchronization.
async function measure(work: () => void) {
  const cpu = process.cpuUsage(),
    start = performance.now();
  await new Promise<void>((resolve) => {
    let ticks = 0;
    const timer = setInterval(() => {
      for (let node = 0; node < 10; node++) work();
      if (++ticks === 100) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
  const usage = process.cpuUsage(cpu),
    elapsedMs = performance.now() - start;
  return {
    cpuMs: (usage.user + usage.system) / 1_000,
    elapsedMs,
    cpuPercent: (usage.user + usage.system) / (elapsedMs * 10),
  };
}

test(
  "watchdog overhead at 100 requests per second stays below two percent of one CPU",
  { timeout: 40_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-diag-cpu-")),
      endpoint = localUserDaemonEndpoint(root, "diagnostics-cpu");
    try {
      const baseline = await measure(() => {}),
        diagnostics = await openDaemonDiagnostics({ userRoot: root, daemonId: "cpu", endpoint });
      let observed;
      try {
        observed = await withDaemonObservation(diagnostics.observer, () =>
          measure(() =>
            observeDaemonOperation({ method: "fixture.request", repoId: "repo-a", actor: "node-a" }, () => {
              markDaemonOperationPhase("projection-read");
            }),
          ),
        );
        const status = await requestDaemonJsonRpcAt(
          daemonDiagnosticsEndpoint(endpoint),
          "daemon.status",
          {},
          1_000,
          2_000,
        );
        assert.equal((status.inFlight as unknown[]).length, 0);
        assert.ok((status.metrics as Record<string, unknown>).heapUsed! > 0);
      } finally {
        await diagnostics.close();
      }
      const files = readdirSync(path.join(root, "logs")).filter((name) => name.includes("diagnostics")),
        bytes = files.reduce((size, name) => size + readFileSync(path.join(root, "logs", name)).byteLength, 0),
        report = {
          node: process.version,
          platform: process.platform,
          baseline,
          observed,
          addedCpuPercent: observed.cpuPercent - baseline.cpuPercent,
          bytesPerDay: (bytes * 86_400_000) / observed.elapsedMs,
        };
      console.log("diagnostics CPU measurement", JSON.stringify(report));
      assert.ok(report.addedCpuPercent < 2, JSON.stringify(report));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
