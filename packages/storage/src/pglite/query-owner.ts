import { EventEmitter } from "node:events";
import { extname, resolve } from "node:path";
import { MessageChannel, MessagePort, Worker } from "node:worker_threads";
import {
  createPgTaskQueryReader,
  waitForPgQueryWorker,
  restorePgQueryError,
  type PgQueryEndpoint,
  type PgQueryConnectionOptions,
  type PgTaskQueryReader,
} from "../pg/pg-task-query-reader.ts";
import type { PGliteStorageBackendConfig } from "../storage-backend.ts";
import { assertPGliteRuntime } from "./transaction.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { acquirePGliteDirectoryMutex } from "./data-dir-mutex.ts";

interface Owner {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly state: Int32Array;
  readonly releaseDirectory: () => void;
  references: number;
}
const owners = new Map<string, Owner>();
export interface PGliteWorkerContext {
  readonly key: string;
  readonly port: MessagePort;
  readonly state: Int32Array;
}
const contexts = new Map<string, PGliteWorkerContext>();
const closedContexts = new WeakSet<PGliteWorkerContext>();

/** A control port is transferred at worker bootstrap, never serialized into deployment config. */
export function installPGliteWorkerContext(context: PGliteWorkerContext): void {
  contexts.set(context.key, context);
  context.port.once("close", () => {
    closedContexts.add(context);
  });
  context.port.unref();
}

export function preparePGliteWorkerContext(repoId: string, storage: PGliteStorageBackendConfig) {
  const scope = resolvePostgresEventStoreScope(storage.scope),
    lease = acquirePGliteOwnerTarget(repoId, storage),
    { port1, port2 } = new MessageChannel();
  lease.target.postMessage({ operation: "attach", port: port2 }, [port2]);
  return {
    context: { key: datasetKey(repoId, scope, storage), port: port1, state: lease.state },
    transferList: [port1],
    close: lease.release,
  };
}

export function retainPGliteOwner(repoId: string, storage: PGliteStorageBackendConfig) {
  return acquirePGliteOwnerTarget(repoId, storage).release;
}

export function acquirePGliteOwnerTarget(repoId: string, storage: PGliteStorageBackendConfig) {
  assertPGliteRuntime();
  const scope = resolvePostgresEventStoreScope(storage.scope),
    context = contexts.get(datasetKey(repoId, scope, storage));
  if (context) {
    if (closedContexts.has(context) || Atomics.load(context.state, 0) === -1)
      throw Object.assign(new Error("Embedded storage owner exited"), { code: "pglite_owner_unavailable" });
    return { target: context.port as Pick<Worker, "postMessage">, state: context.state, release: () => undefined };
  }
  const lease = acquireOwner({ repoId, scope, storage });
  return {
    target: lease.owner.worker as Pick<Worker, "postMessage">,
    state: lease.owner.state,
    release: lease.release,
  };
}

/** Synchronous ports share one physical embedded owner; no socket or second PGlite instance. */
export function createPGliteTaskQueryReader(
  options: PgQueryConnectionOptions & { readonly storage: PGliteStorageBackendConfig },
): PgTaskQueryReader {
  assertPGliteRuntime();
  let release: (() => void) | undefined;
  try {
    const reader = createPgTaskQueryReader({ ...options, path: options.path ?? "pglite:task-projection" }, (input) => {
      const context = contexts.get(datasetKey(options.repoId, options.scope, options.storage));
      let target: Pick<Worker, "postMessage">;
      if (context) {
        if (closedContexts.has(context) || Atomics.load(context.state, 0) === -1)
          throw Object.assign(new Error("Embedded storage owner exited"), { code: "pglite_owner_unavailable" });
        target = context.port;
      } else {
        const lease = acquireOwner(options);
        release = lease.release;
        target = lease.owner.worker;
      }
      target.postMessage(
        {
          operation: "connect",
          input: {
            repoId: input.repoId,
            scope: input.scope,
            path: input.path,
            authoredRoot: input.authoredRoot,
            ready: input.ready,
            state: input.state,
            responsePort: input.responsePort,
          },
        },
        [input.responsePort],
      );
      return new PortEndpoint(input.requestPort);
    });
    return {
      ...reader,
      close: () => {
        try {
          reader.close();
        } finally {
          release?.();
        }
      },
    };
  } catch (error) {
    release?.();
    throw error;
  }
}

function datasetKey(repoId: string, scope: PgQueryConnectionOptions["scope"], storage: PGliteStorageBackendConfig) {
  const dataDir = storage.dataDir;
  return dataDir === undefined
    ? JSON.stringify(["memory", repoId, scope.tenantId, scope.projectId, scope.policyEpoch])
    : dataDir.includes("://")
      ? dataDir
      : resolve(dataDir);
}

function acquireOwner(options: PgQueryConnectionOptions & { readonly storage: PGliteStorageBackendConfig }) {
  assertPGliteRuntime();
  const dataDir = options.storage.dataDir,
    key = datasetKey(options.repoId, options.scope, options.storage);
  let owner = owners.get(key);
  if (owner && Atomics.load(owner.state, 0) === -1)
    throw Object.assign(new Error("Embedded database owner is unavailable; close its readers before reopening"), {
      code: "pglite_owner_unavailable",
    });
  if (!owner) {
    const directoryMutex = acquirePGliteDirectoryMutex(dataDir);
    const { port1, port2 } = new MessageChannel(),
      state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let worker: Worker;
    try {
      worker = new Worker(new URL(`./query-owner-worker${extname(import.meta.filename)}`, import.meta.url), {
        workerData: {
          kind: "pglite-query-owner",
          repoId: options.repoId,
          storage: { backend: "pglite", dataDir, scope: options.scope },
          ready: state,
          responsePort: port2,
          directoryMutex: directoryMutex.proof,
        },
        transferList: [port2],
        execArgv: process.execArgv.filter(
          (value) => value === "--experimental-strip-types" || value === "--enable-source-maps",
        ),
      });
    } catch (error) {
      port1.close();
      port2.close();
      directoryMutex.close();
      throw error;
    }
    owner = { worker, port: port1, state, references: 0, releaseDirectory: directoryMutex.close };
    owners.set(key, owner);
    worker.on("error", () => {
      Atomics.store(state, 0, -1);
    });
    worker.on("exit", () => {
      directoryMutex.close();
      Atomics.store(state, 0, -1);
      if (owner!.references === 0 && owners.get(key) === owner) owners.delete(key);
    });
    worker.unref();
    port1.unref();
    try {
      const startup = waitForPgQueryWorker(
        state,
        port1,
        0,
        options.startupTimeoutMs ?? 30_000,
        worker,
        "Embedded database owner failed to start",
      );
      if (startup.error) throw restorePgQueryError(startup.error);
    } catch (error) {
      Atomics.store(state, 0, -1);
      port1.close();
      void worker.terminate();
      throw error;
    }
  }
  const current = owner;
  current.references++;
  let released = false;
  return {
    owner: current,
    release() {
      if (released) return;
      released = true;
      if (--current.references !== 0) return;
      if (Atomics.load(current.state, 0) === -1) {
        void current.worker.terminate();
        return;
      }
      Atomics.store(current.state, 0, 0);
      current.worker.postMessage({ operation: "shutdown" });
      try {
        const result = waitForPgQueryWorker(
          current.state,
          current.port,
          1,
          options.queryTimeoutMs ?? 30_000,
          current.worker,
          "Embedded database owner failed to close",
        );
        if (result.error) throw restorePgQueryError(result.error);
        current.releaseDirectory();
        owners.delete(key);
      } finally {
        current.port.close();
      }
    },
  };
}

class PortEndpoint extends EventEmitter implements PgQueryEndpoint {
  private readonly port: MessagePort;
  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.on("close", () => this.emit("exit", 0));
    port.on("messageerror", (error: Error) => this.emit("error", error));
  }
  postMessage(value: unknown): void {
    this.port.postMessage(value);
  }
  terminate(): void {
    this.port.close();
  }
  unref(): void {
    this.port.unref();
  }
}
