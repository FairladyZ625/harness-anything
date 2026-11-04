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

interface Owner {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly state: Int32Array;
  references: number;
}
const owners = new Map<string, Owner>();

/** Synchronous ports share one physical embedded owner; no socket or second PGlite instance. */
export function createPGliteTaskQueryReader(
  options: PgQueryConnectionOptions & { readonly storage: PGliteStorageBackendConfig },
): PgTaskQueryReader {
  assertPGliteRuntime();
  let release: (() => void) | undefined;
  try {
    const reader = createPgTaskQueryReader({ ...options, path: options.path ?? "pglite:task-projection" }, (input) => {
      const lease = acquireOwner(options);
      release = lease.release;
      lease.owner.worker.postMessage(
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

function acquireOwner(options: PgQueryConnectionOptions & { readonly storage: PGliteStorageBackendConfig }) {
  const dataDir = options.storage.dataDir,
    key =
      dataDir === undefined
        ? JSON.stringify([
            "memory",
            options.repoId,
            options.scope.tenantId,
            options.scope.projectId,
            options.scope.policyEpoch,
          ])
        : dataDir.includes("://")
          ? dataDir
          : resolve(dataDir);
  let owner = owners.get(key);
  if (owner && Atomics.load(owner.state, 0) === -1)
    throw Object.assign(new Error("Embedded database owner is unavailable; close its readers before reopening"), {
      code: "pglite_owner_unavailable",
    });
  if (!owner) {
    const { port1, port2 } = new MessageChannel(),
      state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      worker = new Worker(new URL(`./query-owner-worker${extname(import.meta.filename)}`, import.meta.url), {
        workerData: {
          kind: "pglite-query-owner",
          repoId: options.repoId,
          storage: { backend: "pglite", dataDir, scope: options.scope },
          ready: state,
          responsePort: port2,
        },
        transferList: [port2],
        execArgv: process.execArgv.filter(
          (value) => value === "--experimental-strip-types" || value === "--enable-source-maps",
        ),
      });
    owner = { worker, port: port1, state, references: 0 };
    owners.set(key, owner);
    worker.on("error", () => {
      Atomics.store(state, 0, -1);
    });
    worker.on("exit", () => {
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
