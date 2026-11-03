// harness-test-tier: integration
import assert from "node:assert/strict";
import { registerDaemonRepo } from "@harness-anything/storage";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { copyHarnessLedgerWithCow, copyHarnessRuntimeLedgerWithCow } from "../../gui/test-support/harness-copy.mjs";
import { constants, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openRepoCellProxy } from "../src/repo-cell-proxy.ts";
import { makeRepoReadRuntime } from "../src/repo-read-runtime.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { holdRead } from "./fixtures/read-p99-gate.ts";
import { initIngressRepo, rpc } from "./fixtures/runtime-ingress.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

test(
  "paired socket p99 detects the same slow read on the entry thread and passes in the read pool",
  { timeout: 900_000 },
  async (t) => {
    const sourceRoot = process.env.FLEET_STRESS_READ_FROZEN_ROOT;
    const frozenRoot = sourceRoot ? mkdtempSync(path.join(tmpdir(), "ha-read-frozen-")) : undefined;
    try {
      if (frozenRoot) {
        copyHarnessLedgerWithCow(path.join(sourceRoot!, "harness"), path.join(frozenRoot, "harness"));
        copyHarnessRuntimeLedgerWithCow(sourceRoot!, frozenRoot);
        const snapshot = new DatabaseSync(path.join(frozenRoot, ".harness/cache/task.sqlite"), { readOnly: true });
        try {
          t.diagnostic(
            `frozen-shape=${JSON.stringify({ tasks: snapshot.prepare("SELECT count(*) AS n FROM task_snapshot").get()!.n, documents: snapshot.prepare("SELECT count(*) AS n FROM document").get()!.n, relations: snapshot.prepare("SELECT count(*) AS n FROM relation_edge").get()!.n })}`,
          );
        } finally {
          snapshot.close();
        }
      }
      const before = await measure(true, frozenRoot),
        after = await measure(false, frozenRoot);
      const responsive = (metrics: Record<string, number>) => {
        assert.ok(metrics.status! < 500, JSON.stringify(metrics));
        assert.ok(metrics.hello! < 500, JSON.stringify(metrics));
      };
      // Same responsiveness assertion is red with the read restored to the entry thread.
      assert.throws(() => responsive(before), { code: "ERR_ASSERTION" });
      responsive(after);
      assert.equal(before.readTimeouts, frozenRoot ? 5 : 20);
      assert.equal(after.readTimeouts, 0, "all probes, including writes, must finish before releasing the slow read");
      assert.ok(after.write! < before.write!, JSON.stringify({ before, after }));
      t.diagnostic(
        `paired-read-p99=${JSON.stringify({ samples: frozenRoot ? 5 : 20, slowReadMs: frozenRoot ? 10000 : 1000, before, after, negativeControl: "responsiveness assertion rejected entry-thread reads" })}`,
      );
    } finally {
      if (frozenRoot) rmSync(frozenRoot, { recursive: true, force: true });
    }
  },
);

async function measure(entryThread: boolean, frozenRoot?: string): Promise<Record<string, number>> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-read-p99-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = frozenRoot ? "canonical" : "read-p99",
    daemonId = "read-p99",
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    barrier = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
  Atomics.store(barrier, 4, frozenRoot ? 10_000 : 1_000);
  initIngressRepo(root, process.getuid?.() ?? 0);
  if (frozenRoot) {
    rmSync(path.join(root, "harness"), { recursive: true, force: true });
    copyHarnessLedgerWithCow(path.join(frozenRoot, "harness"), path.join(root, "harness"));
    cpSync(path.join(frozenRoot, ".harness"), path.join(root, ".harness"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE_FORCE,
    });
  }
  signInPolicyTestUser(userRoot, "owner", [repoId], "admin");
  const registration = { canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false };
  // A canonical snapshot already contains settings. The seed helper enumerates the ledger
  // and would measure fixture setup rather than the daemon's independent read boundary.
  if (frozenRoot) registerDaemonRepo(registration);
  else registerBootstrappedDaemonRepo(registration);
  const host = await openDaemonHost({
    daemonId,
    userRoot,
    openCell: async (input) => {
      const cell = await openRepoCellProxy(input, {
        createReadWorker: (_url, options) =>
          new Worker(new URL("./fixtures/read-p99-worker.ts", import.meta.url), {
            ...options,
            workerData: { ...options.workerData, barrier: barrier.buffer },
          }),
      });
      if (!entryThread) return cell;
      const reader = makeRepoReadRuntime(input);
      return {
        ...cell,
        read: async (method, payload, binding) => {
          holdRead(barrier);
          return reader.read(method, payload, binding) as never;
        },
        close: async () => {
          await reader.close();
          await cell.close();
        },
      };
    },
  });
  const transport = createUnixSocketTransportServer({
    daemonId,
    socketPath: endpoint,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
  });
  let probe: Worker | undefined;
  try {
    await transport.start();
    await host.attachmentsSettled();
    await rpc(host, { transportKind: "unix-socket" }, "repo.workspace.summary.read", { repo: { repoId } });
    probe = new Worker(new URL("./fixtures/read-p99-probe-worker.ts", import.meta.url), {
      workerData: { endpoint, repoId, samples: frozenRoot ? 5 : 20, barrier: barrier.buffer },
    });
    const result = new Promise<Record<string, number[]>>((resolve, reject) => {
      probe!.on("message", (message) => {
        if (message.type === "result") resolve(message.measurements);
      });
      probe!.on("error", reject);
    });
    await once(probe, "message");
    for (let sequence = 1; sequence <= (frozenRoot ? 5 : 20); sequence++) {
      Atomics.store(barrier, 0, sequence);
      await rpc(host, { transportKind: "unix-socket" }, "repo.workspace.summary.read", { repo: { repoId } });
      while (Atomics.load(barrier, 3) < sequence) await Atomics.waitAsync(barrier, 3, sequence - 1).value;
    }
    const metrics = Object.fromEntries(
      Object.entries(await result).map(([name, values]) => [
        name,
        [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1]!,
      ]),
    );
    return { ...metrics, readTimeouts: Atomics.load(barrier, 5) };
  } finally {
    await probe?.terminate();
    await transport.stop();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
}
