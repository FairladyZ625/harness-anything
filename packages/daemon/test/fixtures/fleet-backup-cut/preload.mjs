// Imported only by this test's Worker adapter. No diagnostics use production parentPort.
import threads, {
  getEnvironmentData,
  workerData,
  MessageChannel,
  BroadcastChannel,
  threadId,
  parentPort,
} from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";

export const probeKey = "fleet-backup-cut/v1";
const NativeWorker = threads.Worker;
let restore;

export function installAdapter(config) {
  if (restore) throw new Error("backup cut adapter already installed");
  const channel = new BroadcastChannel(config.channel);
  channel.unref();
  const emit = (event) =>
    channel.postMessage({
      ...event,
      producerThreadId: threadId,
      order: Atomics.add(new Int32Array(config.shared), 1, 1),
    });
  const received = (message) => {
    if (message.schema === "harness-repo-writer-cancel/v1")
      emit({ event: "cancel-received", requestId: message.requestId });
    if (message.schema === "harness-repo-writer-request/v1" && message.payload?.action?.taskId === config.taskId)
      queueMicrotask(() => emit({ event: "write-received", requestId: message.requestId }));
  };
  // Only the resident writer consumes cancellation. Do not change read/backup worker port refs.
  if (workerData?.schema === "harness-repo-writer-bootstrap/v1" && workerData.role !== "reader")
    parentPort.on("message", received);
  let backups = 0;
  class ObservedWorker extends NativeWorker {
    constructor(url, options = {}) {
      const filename = String(url);
      const backup = /\/fleet-basebackup-worker\.(?:ts|js)$/u.test(filename);
      const writer = /\/repo-writer-worker\.(?:ts|js)$/u.test(filename);
      const ports = backup ? new MessageChannel() : null;
      const extra = backup
        ? { [probeKey]: { ...config, fault: backups++ === 0 ? config.fault : undefined, port: ports.port2 } }
        : {};
      try {
        super(url, {
          ...options,
          // Node's test child includes process-only flags; they are invalid when explicitly
          // passed to a Worker. Keep the caller's explicit flags plus this test preload.
          execArgv: [...(options.execArgv ?? []), `--import=${import.meta.url}`],
          workerData: { ...options.workerData, ...extra },
          transferList: [...(options.transferList ?? []), ...(ports ? [ports.port2] : [])],
        });
      } catch (error) {
        ports?.port1.close();
        ports?.port2.close();
        throw error;
      }
      const targetThreadId = this.threadId;
      if (ports) {
        emit({ event: "backup-created", parentThreadId: threadId, targetThreadId });
        ports.port1.on("message", (entry) => channel.postMessage(entry));
        this.on("message", (message) => {
          if (message.kind === "pinned") emit({ event: "pinned", position: message.metadata.position, targetThreadId });
          if (message.kind === "complete") emit({ event: "archive-complete", targetThreadId });
        });
        this.on("error", (error) => emit({ event: "backup-error", message: error.message, targetThreadId }));
        this.on("exit", (code) => {
          emit({ event: "backup-exit", code, targetThreadId });
          ports.port1.close();
        });
      }
      if (writer) {
        const send = this.postMessage;
        const snapshots = new Set();
        this.postMessage = function (message, ...args) {
          // Observe only the selected real task write; never serialize its binding or credentials.
          if (message.schema === "harness-repo-writer-request/v1" && message.payload?.action?.taskId === config.taskId)
            emit({ event: "write-dispatched", requestId: message.requestId, targetThreadId });
          if (message.schema === "harness-repo-writer-request/v1" && message.method === "fleetBackup") {
            snapshots.add(message.requestId);
            emit({ event: "snapshot-dispatched", requestId: message.requestId, targetThreadId });
          }
          return send.call(this, message, ...args);
        };
        this.on("message", (message) => {
          if (message.schema === "harness-repo-writer-receipt/v1" && snapshots.has(message.requestId))
            emit({
              event: "snapshot-receipt",
              requestId: message.requestId,
              outcome: message.outcome,
              error: message.error,
              queueHead: message.queueHead ?? null,
              targetThreadId,
            });
          if (message.schema === "harness-repo-writer-receipt/v1" && message.value?.taskId === config.taskId)
            emit({
              event: "writer-receipt",
              requestId: message.requestId,
              queueHead: message.queueHead ?? null,
              targetThreadId,
            });
        });
      }
    }
  }
  threads.Worker = ObservedWorker;
  syncBuiltinESMExports();
  restore = () => {
    threads.Worker = NativeWorker;
    syncBuiltinESMExports();
    channel.close();
    parentPort?.off("message", received);
    restore = undefined;
  };
  return () => restore();
}

const inherited = getEnvironmentData(probeKey);
if (inherited) installAdapter(inherited);
const probe = workerData?.[probeKey];
if (probe) {
  const cells = new Int32Array(probe.shared);
  const emit = (event) =>
    probe.port.postMessage({ ...event, producerThreadId: threadId, order: Atomics.add(cells, 1, 1), threadId });
  const prepare = DatabaseSync.prototype.prepare;
  const send = parentPort.postMessage;
  parentPort.postMessage = function (message, ...args) {
    const result = send.call(this, message, ...args);
    if (message.kind === "pinned" && probe.holdArchive) {
      emit({ event: "archive-held" });
      const outcome = Atomics.wait(cells, 2, 0, 30_000);
      if (outcome === "timed-out") throw new Error("archive barrier was not released within its cleanup bound");
      emit({ event: "archive-barrier-released" });
      if (probe.fault === "after-pinned") throw new Error("injected backup failure after pinning");
    }
    return result;
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    const ledger =
      sql ===
      "SELECT repo_id,generation,revision,history,sequence FROM ledger_meta JOIN replication_state USING(singleton)";
    const projection = sql === "SELECT watermark,schema_version FROM projection_meta WHERE singleton=1";
    if (!ledger && !projection) return statement;
    const get = statement.get;
    statement.get = function (...args) {
      const row = get.apply(this, args);
      emit({ event: ledger ? "ledger-select" : "projection-select", row: { ...row } });
      if (ledger) {
        const outcome = Atomics.wait(cells, 0, 0, 30_000);
        if (outcome === "timed-out") throw new Error("backup cut barrier was not released within its cleanup bound");
        emit({ event: "barrier-released" });
      } else {
        DatabaseSync.prototype.prepare = prepare;
        emit({ event: "sqlite-patch-restored" });
        if (probe.fault === "before-pinned") throw new Error("injected backup failure before pinning");
      }
      return row;
    };
    return statement;
  };
  process.once("exit", () => {
    DatabaseSync.prototype.prepare = prepare;
    probe.port.close();
  });
}
