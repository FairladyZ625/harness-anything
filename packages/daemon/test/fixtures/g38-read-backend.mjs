import { canonicalEventCut, canonicalLedgerCut } from "@harness-anything/kernel";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { makeTaskEventStore, makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { initRepo } from "../../../storage/test/store/task-event-store.fixtures.ts";
import { seedReadLedger } from "./g38-read-ledger.mjs";
import { installReadProbe, resetReadProbe, snapshotReadProbe } from "./g38-read-probe.mjs";

export async function openReadBackend(backend, dimension, size) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-read-"));
  initRepo(rootDir);
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: parity\nsettings: {}\n",
  );
  if (backend === "sqlite") {
    let store = makeTaskEventStore({ repoId: "g38-read", rootDir });
    try {
      await seedReadLedger({ append: (bundle) => store.append(bundle), currentCut: store.currentCut }, dimension, size);
      await store.drain();
      store = makeTaskEventReader({ repoId: "g38-read", rootDir });
      const projection = makeTaskProjection({ rootDir, eventStore: store });
      projection.rebuild();
      installReadProbe();
      return {
        rootDir,
        projection,
        store,
        reset: resetReadProbe,
        snapshot: snapshotReadProbe,
        close: async () => {
          projection.close();
          await store.drain();
          rmSync(rootDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await store.drain();
      rmSync(rootDir, { recursive: true, force: true });
      throw error;
    }
  }
  const state = new Int32Array(new SharedArrayBuffer(4)),
    { port1, port2 } = new MessageChannel(),
    worker = new Worker(new URL("./g38-read-pg-worker.mjs", import.meta.url), {
      workerData: { state, responsePort: port2, dimension, size, rootDir },
      transferList: [port2],
      execArgv: [],
    });
  worker.on("error", () => {}); // wait() reports the terminal error to the synchronous caller.
  const wait = () => {
    if (Atomics.wait(state, 0, 0, 120_000) === "timed-out") throw new Error("G38 PGlite fixture timed out");
    const response = receiveMessageOnPort(port1)?.message;
    if (!response) throw new Error("G38 PGlite fixture returned no response");
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  const request = (method, ...args) => {
    Atomics.store(state, 0, 0);
    worker.postMessage({ method, args });
    return wait();
  };
  try {
    wait();
    installReadProbe();
    const projection = new Proxy(
        {},
        { get: (_, key) => (key === "path" ? "pglite:read-fixture" : (...args) => request(key, ...args)) },
      ),
      canonical = (operation, extra = {}) => request("canonical", { operation, ...extra }),
      store = {
        readHead: () => canonical("head"),
        currentCut: () => canonicalLedgerCut("g38-read", canonical("head")),
        currentCommit: () => null,
        ledgerMetadata: () => ({ repoId: "g38-read", generation: 3, revision: canonical("head")?.revision ?? 0 }),
        publication: (event) => ({ commitSha: null, cut: canonicalEventCut("g38-read", event) }),
        canonicalRef: "pglite:canonical",
        read: () => canonical("stream"),
        readEvents: (afterRevision, limit, query) => canonical("events", { afterRevision, limit, query }),
        readEvent: (value) => canonical("event", { key: "op_id", value }),
        readEventById: (value) => canonical("event", { key: "event_id", value }),
        queryEvents: (query) => canonical("events", { query }),
        readEventAtRevision: (value) => canonical("event", { key: "revision", value }),
        readBatch: (cursor, maxItems) => canonical("batch", { cursor, maxItems }),
        readContentBlob: (sha256) => canonical("content", { sha256 }),
        readContentBlobRange: (sha256, offset, maxBytes) => canonical("content-range", { sha256, offset, maxBytes }),
        readContentBlobSize: (sha256) => canonical("content-size", { sha256 }),
        drain: async () => {},
      };
    return {
      rootDir,
      projection,
      store,
      reset: () => {
        request("reset");
        resetReadProbe();
      },
      snapshot: () => {
        const remote = request("snapshot"),
          local = snapshotReadProbe();
        return Object.fromEntries(Object.keys(local).map((key) => [key, local[key] + remote[key]]));
      },
      close: async () => {
        try {
          request("close");
        } finally {
          port1.close();
          await worker.terminate();
          rmSync(rootDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    port1.close();
    await worker.terminate();
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}
