// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { runFleetReplicaPullClient, runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { readEdgeManifestEntries } from "../src/fleet/replica-read-model.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";

test(
  "two edges consume the shared continuous sequence while the complete checkpoint executor is blocked",
  { timeout: 30_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const control = new Int32Array(new SharedArrayBuffer(4));
    const held = Promise.withResolvers<void>();
    const Worker = workerThreads.Worker;
    const mock = t.mock.method(
      workerThreads,
      "Worker",
      class extends Worker {
        constructor(url: string | URL, options: workerThreads.WorkerOptions = {}) {
          const checkpoint = String(url).endsWith("/replica-cut-executor.ts");
          super(checkpoint ? new URL("./fleet-checkpoint-build-barrier.fixture.ts", import.meta.url) : url, {
            ...options,
            ...(checkpoint
              ? { workerData: { ...options.workerData, control, pauseAfter: 2, moduleUrl: String(url) } }
              : {}),
          });
          if (checkpoint)
            this.on("message", (message) => {
              if (message.checkpointBuildHeld) held.resolve();
            });
        }
      },
    );
    syncBuiltinESMExports();
    const release = () => {
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
    };
    t.after(() => {
      release();
      mock.mock.restore();
      syncBuiltinESMExports();
    });
    const source = f.host.replica(f.subject.repoId);
    const base = (await source.prepare())!;
    const center = await f.center();
    const peer = (nodeId: string) => ({
      port: center.port,
      ca: f.cert,
      nodeId,
      credential: "machine-secret",
      repoId: f.subject.repoId,
    });
    const options = (nodeId: string) => ({
      ...peer(nodeId),
      viewRoot: path.join(f.root, nodeId),
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    for (const node of ["node-one", "node-two"])
      assert.equal((await runFleetReplicaPullClient(options(node))).current.cut.revision, base.revision);
    const checkpoint = source.prepare();
    await held.promise;
    const revisions: number[] = [];
    try {
      for (const [index, nodeId] of ["node-one", "node-two", "node-one"].entries()) {
        const command = {
          ...peer(nodeId),
          opId: `sequence-write-${index}`,
          taskId: `task-interleaved-${index}`,
          waitMs: 0,
          action: {
            kind: "task-create",
            taskId: `task-interleaved-${index}`,
            title: `Interleaved ${index}`,
            idempotencyKey: `sequence-${index}`,
          } as const,
        };
        const write = await runFleetTaskCommandClient(command);
        assert.equal(write.outcome, "applied");
        await waitForFleetPublication(f.host, f.subject.repoId, String(write.receipt!.opId), f.auth);
        const duplicate = await runFleetTaskCommandClient(command);
        assert.equal(duplicate.revision, write.revision, "duplicate operation does not append a second revision");
        revisions.push(write.revision!);
        const frames: string[] = [];
        const pulled = await runFleetReplicaPullClient({
          ...options(nodeId),
          through: write.revision!,
          onFrame: (frame) => frames.push(frame.schema),
        });
        assert.ok(frames.includes("fleet.delta.begin/v1"));
        assert.ok(!frames.includes("fleet.snapshot.begin/v1"));
        assert.ok(pulled.current.cut.revision >= write.revision!);
        assert.equal(Atomics.load(control, 0), 1, "complete checkpoint remains blocked when write-through returns");
        withEdgeReadModel({ ...options(nodeId), principalId: "person-owner" }, (queries) => {
          for (let seen = 0; seen <= index; seen++)
            assert.ok(queries.list().rows.some((row) => row.taskId === `task-interleaved-${seen}`));
        });
      }
      const workspace = path.join(f.root, "command-workspace");
      applyFleetMirrorCut(options("node-two").viewRoot, f.subject.repoId, workspace, "pull");
      const commandResult = await runFleetEdgeTask({
        payload: {
          host: "127.0.0.1",
          port: center.port,
          caPath: f.certFile,
          servername: "localhost",
          nodeId: "node-two",
          credential: "machine-secret",
          repoId: f.subject.repoId,
          viewRoot: options("node-two").viewRoot,
          quotaBytes: 64 * 1024 * 1024,
          workspaceRoot: workspace,
          action: { kind: "task-create", taskId: "task-command-return", title: "Command return" },
        },
      });
      assert.equal(commandResult.outcome, "applied", JSON.stringify(commandResult));
      assert.equal(commandResult.mirrorOutcome, "applied", JSON.stringify(commandResult));
      assert.equal(Atomics.load(control, 0), 1, "real edge command returns while full checkpoint is blocked");
      withEdgeReadModel({ ...options("node-two"), principalId: "person-owner" }, (queries) => {
        assert.ok(queries.list().rows.some((row) => row.taskId === "task-command-return"));
      });
      const target = source.latest()!;
      for (const nodeId of ["node-one", "node-two"]) {
        const pulled = await runFleetReplicaPullClient({ ...options(nodeId), through: target.revision });
        assert.equal(pulled.current.cut.headDigest, target.headDigest);
        assert.equal(pulled.current.manifestDigest, target.manifest.digest);
        const file = path.join(
          options(nodeId).viewRoot,
          "repos",
          f.subject.repoId,
          "views",
          nodeId,
          "cuts",
          `${target.revision}-g${pulled.current.schemaGeneration}`,
          "manifest.json",
        );
        assert.deepEqual(
          [...readEdgeManifestEntries(file)].sort((a, b) => a.path.localeCompare(b.path)),
          source.manifest(target.revision)!.sort((a, b) => a.path.localeCompare(b.path)),
          "complete documents and read model match T",
        );
      }
      t.diagnostic(
        `R=${base.revision}; interleaved writes=${revisions.join(",")}; T=${target.revision}; checkpoint blocked throughout both independent ACKs`,
      );
    } finally {
      release();
      await checkpoint;
    }
  },
);
