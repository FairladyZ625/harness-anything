// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openDaemonHost,
  createJsonRpcProtocolServer,
  createUnixSocketTransportServer,
  daemonRequestLogPath,
} from "@harness-anything/daemon";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { initIngressRepo } from "../../daemon/test/fixtures/runtime-ingress.ts";
import { registerBootstrappedDaemonRepo } from "../../daemon/test/repo-settings.fixture.ts";
import { runDaemonControl } from "../src/daemon/control.ts";
import { readMetricsHistory } from "../src/daemon/metrics.ts";
import { requestWindowMetrics } from "../src/daemon/metrics-summary.ts";

test("native metrics reads real rotated logs over one socket and rejects an actual retention gap", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-metrics-integration-"));
  const rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  const repoId = "metrics",
    daemonId = "metrics";
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  const priorEndpoint = process.env.HARNESS_DAEMON_ENDPOINT;
  const priorRelay = process.env.HARNESS_DAEMON_RELAY;
  process.env.HARNESS_DAEMON_ENDPOINT = endpoint;
  delete process.env.HARNESS_DAEMON_RELAY;
  let host: Awaited<ReturnType<typeof openDaemonHost>> | undefined;
  let transport: ReturnType<typeof createUnixSocketTransportServer> | undefined;
  try {
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    const now = Date.now();
    const rows = Array.from({ length: 130 }, (_, index) => ({
      schema: "daemon-request-log/v1",
      at: new Date(now - 600_000 + index).toISOString(),
      method: "repo.tasks.list",
      command: "task-list",
      ok: true,
      durationMs: index + 1,
      serviceMs: index,
      dispatchDelayMs: 1,
    }));
    const records = [...rows, { ...rows[129]!, method: "repo.agentRuntime.sessions.await", durationMs: 900_000 }];
    const log = daemonRequestLogPath(rootDir);
    mkdirSync(path.dirname(log), { recursive: true });
    const jsonl = (values: typeof records) => values.map((value) => JSON.stringify(value)).join("\n") + "\n";
    writeFileSync(`${log}.1`, jsonl(records.slice(0, 65)));
    writeFileSync(log, jsonl(records.slice(65)));
    host = await openDaemonHost({ userRoot, daemonId, runtimeDiscover: () => [] });
    await host.attachmentsSettled();
    transport = createUnixSocketTransportServer({
      daemonId,
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host: host!, build: { commit: null }, authContext, emit }),
    });
    await transport.start();
    let receipt: Record<string, unknown> = {};
    const exitCode = await runDaemonControl(
      [
        "daemon",
        "metrics",
        "--root",
        rootDir,
        "--repo",
        repoId,
        "--user-root",
        userRoot,
        "--daemon-id",
        daemonId,
        "--window",
        "1h",
        "--json",
      ],
      (value) => {
        receipt = value;
      },
    );
    assert.equal(exitCode, 0, JSON.stringify(receipt));
    const metrics = receipt as ReturnType<typeof requestWindowMetrics> & { history: { pages: number } };
    assert.equal(metrics.history.pages, 3);
    assert.equal(metrics.requestCount, 131);
    assert.equal(metrics.excludedAwaitRequests, 1);
    assert.equal(metrics.latency.durationMs.sampleCount, 130);
    assert.equal(metrics.latency.durationMs.p95Ms, 124);
    assert.equal(metrics.coverage.observedSpanMs, 129);
    assert.equal(metrics.coverage.continuity, "unknown");

    // Real truncation invalidates the history cursor between pages; partial statistics must fail.
    let reads = 0;
    await assert.rejects(
      readMetricsHistory(async (cursor) => {
        reads += 1;
        const page = await host!.read(
          repoId,
          "observe.tail",
          {
            kind: "repo-log",
            direction: "history",
            ...(cursor ? { cursor } : {}),
          },
          {
            transportKind: "unix-socket",
            unixSocketOwnerBoundary: {
              ownerUid: process.getuid?.() ?? 0,
              source: "unix-socket-filesystem-owner-boundary",
            },
          },
        );
        if (reads === 1) writeFileSync(log, "");
        return page;
      }),
      { code: "service_rejected" },
    );
    assert.equal(reads, 2);
  } finally {
    await transport?.stop();
    await host?.close();
    if (priorEndpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
    else process.env.HARNESS_DAEMON_ENDPOINT = priorEndpoint;
    if (priorRelay === undefined) delete process.env.HARNESS_DAEMON_RELAY;
    else process.env.HARNESS_DAEMON_RELAY = priorRelay;
    rmSync(parent, { recursive: true, force: true });
  }
});
