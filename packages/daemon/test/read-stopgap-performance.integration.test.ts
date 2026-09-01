// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

test("runtime discovery write load keeps independent read clients within the stopgap latency envelope", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-read-stopgap-perf-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "read-stopgap-perf",
    repoId = "read-stopgap-perf",
    uid = process.getuid?.() ?? 0,
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    executablePath = writeProviderExecutable(
      path.join(parent, "codex-stub"),
      `if (process.argv.slice(2).join(" ") === "login status") process.exit(0); process.exit(0);\n`,
    ),
    installation = {
      installationId: "installation-read-stopgap",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-09-01T00:00:00.000Z",
    };
  let discoveryCalls = 0;
  initIngressRepo(root, uid);
  registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({
      daemonId,
      userRoot,
      runtimeDiscover: async () => {
        discoveryCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return [installation];
      },
      runtimeLaunch: () => ({
        pid: 4242,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    }),
    transport = createUnixSocketTransportServer({
      daemonId,
      socketPath: endpoint,
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
    }),
    readCalls = [
      ["workspaceSummary", "repo.workspace.summary.read", { repo: { repoId } }],
      ["guiTaskList", "repo.tasks.list", { repo: { repoId }, payload: { limit: 1 } }],
      [
        "legacyTaskList",
        "repo.task.read",
        { repo: { repoId }, payload: { action: { kind: "task-list", limit: 1 } } },
      ],
    ] as const;
  await transport.start();
  try {
    await host.attachmentsSettled();
    await request("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "read-stopgap-codex",
        name: "Read stopgap Codex",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["gpt-stopgap"],
        authMode: "subscription",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const idle = await measure(readCalls, 20),
      callsBeforeSpawn = discoveryCalls,
      spawn = request("repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "read-stopgap-codex",
          cwd: { scope: "repo-root" },
          prompt: "Measure the async discovery boundary.",
          taskId: null,
          idempotencyKey: "read-stopgap-load",
        },
      });
    await eventually(() => discoveryCalls > callsBeforeSpawn);
    const loaded = await measure(readCalls, 50),
      spawned = await spawn,
      metrics = Object.fromEntries(
        readCalls.map(([name]) => [
          name,
          {
            idle: distribution(idle[name]),
            loaded: distribution(loaded[name]),
          },
        ]),
      ) as Record<string, { idle: Distribution; loaded: Distribution }>;
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    for (const [name, metric] of Object.entries(metrics))
      assert.equal(
        metric.loaded.p95 <= Math.max(1, metric.idle.p95) * 2,
        true,
        `${name}: ${JSON.stringify(metric)}`,
      );
    t.diagnostic(`read-stopgap-metrics=${JSON.stringify(metrics)}`);
  } finally {
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }

  async function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requestDaemonJsonRpcAt(endpoint, method, params, 2_000, 5_000);
  }
  async function measure(
    calls: typeof readCalls,
    samples: number,
  ): Promise<Record<(typeof readCalls)[number][0], number[]>> {
    const values = Object.fromEntries(calls.map(([name]) => [name, []])) as Record<
      (typeof readCalls)[number][0],
      number[]
    >;
    for (let sample = 0; sample < samples; sample += 1)
      for (const [name, method, params] of calls) {
        const startedAt = performance.now();
        await request(method, params);
        values[name].push(Math.round(performance.now() - startedAt));
      }
    return values;
  }
});

interface Distribution {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right),
    percentile = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("runtime discovery load did not start");
}
