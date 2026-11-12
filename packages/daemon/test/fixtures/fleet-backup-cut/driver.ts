import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import tls from "node:tls";
import { BroadcastChannel, setEnvironmentData } from "node:worker_threads";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fleetReplicationFixture, replicationRepoId } from "../../fleet-replication.fixture.ts";
import { catchUpReplica } from "../../replica-catch-up.fixture.ts";
import { readReplicaGeneration } from "../../../src/fleet/replica-generation.ts";
import { installAdapter, probeKey } from "./preload.mjs";

type Entry = { event: string; order: number; [key: string]: any };
export type Schedule = "stationary" | "after-pinned" | "between-selects";

export async function runCut(t: TestContext, schedule: Schedule): Promise<void> {
  const shared = new SharedArrayBuffer(8),
    cells = new Int32Array(shared);
  const config = { shared, channel: `backup-cut-${randomUUID()}`, taskId: "task_cut000000000000000000000001" };
  const entries: Entry[] = [];
  const pending = new Set<() => void>();
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    const entry = { event, ...detail, order: Atomics.add(cells, 1, 1) };
    accept(entry);
  };
  const accept = (entry: Entry) => {
    entries.push(entry);
    process.stdout.write(`[backup-cut] ${JSON.stringify({ schedule, ...entry })}\n`);
    for (const check of [...pending]) check();
  };
  const wait = (event: string): Promise<Entry> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(check);
        reject(new Error(`missing discrete event: ${event}`));
      }, 30_000);
      const check = () => {
        const entry = entries.find((entry) => entry.event === event);
        if (!entry) return;
        clearTimeout(timer);
        pending.delete(check);
        resolve(entry);
      };
      pending.add(check);
      check();
    });
  const channel = new BroadcastChannel(config.channel);
  channel.onmessage = ({ data }) => accept(data);
  setEnvironmentData(probeKey, config);
  const restore = installAdapter(config);
  const release = () => {
    record("release-requested");
    Atomics.store(cells, 0, 1);
    Atomics.notify(cells, 0);
  };
  // Registered before fixture cleanup: a failed assertion cannot strand its backup worker.
  t.after(() => {
    release();
    setEnvironmentData(probeKey, undefined);
    restore();
    channel.close();
  });
  record("environment", {
    node: process.version,
    platform: process.platform,
    concurrency: process.env.HARNESS_TEST_CONCURRENCY ?? "runner-argv",
    actor: process.env.HARNESS_ACTOR,
  });
  const f = await fleetReplicationFixture(t);
  const seeded = await f.centerRun({
    kind: "task-create",
    taskId: "task_cutseed00000000000000000001",
    title: "cut seed",
  });
  assert.equal(seeded.outcome, "applied");
  const center = await f.openCenter();
  const viewRoot = path.join(f.root, "review-view");
  const viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
  const reader = f.centerReader();
  const projectionPath = reader.path;
  reader.close();
  const readCut = () => {
    const ledger = new DatabaseSync(f.ledgerPath, { readOnly: true });
    const projection = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      return {
        ledger: Number(ledger.prepare("SELECT revision FROM ledger_meta").get()!.revision),
        projection: Number(projection.prepare("SELECT watermark FROM projection_meta").get()!.watermark),
      };
    } finally {
      projection.close();
      ledger.close();
    }
  };
  const initial = readCut();
  assert.equal(initial.ledger, initial.projection);
  record("pre-cut", {
    ...initial,
    phase: "first-review-catchup",
    nodeId: "edge-one",
    repoId: replicationRepoId,
    view: "review-view",
    centerPort: center.port,
  });
  // Socket observations stay in this isolated test process and record no application payloads.
  const nativeConnect = tls.connect,
    nativeDestroy = tls.TLSSocket.prototype.destroy;
  t.mock.method(tls, "connect", (...args: any[]) => {
    const socket = (nativeConnect as any)(...args);
    const write = socket.write;
    socket.write = function (chunk: any, ...rest: any[]) {
      if (typeof chunk === "string")
        for (const line of chunk.split("\n")) {
          if (!line.startsWith('{"type":"replica.')) continue;
          const frame = JSON.parse(line);
          if (["replica.start", "replica.ack"].includes(frame.type))
            record(frame.type, {
              localPort: socket.localPort,
              remotePort: socket.remotePort,
              ...(frame.type === "replica.ack"
                ? { durable: frame.durable, applied: frame.applied }
                : { position: frame.position }),
            });
        }
      return (write as any).call(this, chunk, ...rest);
    };
    socket.once("secureConnect", () =>
      record("client-connected", { localPort: socket.localPort, remotePort: socket.remotePort }),
    );
    socket.once("close", () => record("client-close", { localPort: socket.localPort, remotePort: center.port }));
    return socket;
  });
  t.mock.method(tls.TLSSocket.prototype, "destroy", function (this: tls.TLSSocket, error?: Error) {
    if (this.localPort === center.port && error)
      record("center-destroy", { localPort: this.localPort, remotePort: this.remotePort, message: error.message });
    return nativeDestroy.call(this, error);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const replica = catchUpReplica({
    hostname: "127.0.0.1",
    port: center.port,
    ca: f.cert,
    servername: "localhost",
    nodeId: "edge-one",
    credential: "secret-edge-one",
    repoId: replicationRepoId,
    viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
    readAccessToken: f.owners.readAccessToken("edge-one"),
  }).then(
    (value) => {
      record("helper-confirmed", { position: value.replica.knownHead });
      return { value, error: null };
    },
    (error: Error) => {
      record("helper-failed", {
        message: error.message,
        generation: readReplicaGeneration(viewDir)?.metadata.position ?? null,
      });
      return { value: null, error };
    },
  );
  record("helper-waiting", {
    waiter: "first applied confirmation (admitted)",
    nodeId: "edge-one",
    view: "review-view",
  });
  await wait("ledger-select");
  let receipt: any = null;
  const write = async () => {
    record("write-requested", { taskId: config.taskId });
    receipt = await f.centerRun({ kind: "task-create", taskId: config.taskId, title: "one real center write" });
    record("write-receipt", { opId: receipt.opId, outcome: receipt.outcome, cut: readCut() });
    assert.equal(receipt.outcome, "applied");
    const cut = readCut();
    assert.equal(cut.ledger, initial.ledger + 1);
    assert.equal(cut.projection, cut.ledger);
  };
  let writing: Promise<void> | null = null;
  if (schedule === "between-selects") {
    writing = write();
    const created = await wait("backup-created");
    if (created.parentThreadId === 0) await writing;
    else {
      // A source fix can move pinning under the existing writer. Release on dispatch into that
      // owner, then verify its completed receipt names the preceding queue head below. No clock
      // or absence of a receipt is used to claim the write was blocked.
      const dispatched = await wait("write-dispatched");
      assert.equal(dispatched.targetThreadId, created.parentThreadId);
      record("write-dispatched-to-backup-owner");
    }
  }
  release();
  if (schedule === "after-pinned") {
    await wait("pinned");
    writing = write();
  }
  const result = await replica;
  await writing;
  await wait("backup-exit");
  record("center-observed", {
    failures: f.transportErrors.map(({ nodeId, error }) => ({ nodeId, message: String(error) })),
    replica: center.status().replicas,
    currentCut: readCut(),
    generation: readReplicaGeneration(viewDir)?.metadata.position ?? null,
  });
  record("assertions-start", {
    centerAlive: f.host.status().repos.some((r) => r.repoId === replicationRepoId && r.state === "attached"),
  });
  try {
    assert.equal(result.error, null, "first replica must receive its initial applied confirmation");
    const ledger = entries.find((e) => e.event === "ledger-select")!;
    const projection = entries.find((e) => e.event === "projection-select")!;
    assert.equal(ledger.row.revision, projection.row.watermark, "backup uses one accepted and projected cut");
    assert.equal(f.transportErrors.length, 0);
    assert.equal(entries.filter((e) => e.event === "pinned").length, 1);
    assert.ok(
      entries.some((e) => e.event === "replica.ack"),
      "receiver sent its applied ACK",
    );
    if (schedule === "between-selects") {
      const writer = await wait("writer-receipt");
      assert.ok(writer.queueHead, "the real write waited behind the snapshot owner's queue head");
      assert.ok(
        entries.find((e) => e.event === "pinned")!.order < entries.find((e) => e.event === "write-receipt")!.order,
      );
    }
  } finally {
    record("assertions-end");
    record("teardown-authorized");
  }
}
