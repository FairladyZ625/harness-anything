import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import { acquireDaemonSingleton, daemonPidPath } from "./daemon-singleton.ts";
import { openDaemonHost } from "./daemon-host.ts";
import { createJsonRpcProtocolServer } from "./protocol/json-rpc-server.ts";
import { openDaemonRequestLog } from "./request-log.ts";
import { openDaemonLifecycleLog } from "./lifecycle-log.ts";
import { openDaemonConnLog } from "./conn-log.ts";
import { daemonBuildStamp, observeDaemonBuild } from "./build-identity.ts";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";
import type { DaemonHostOpenInput } from "./daemon-host-open.ts";
import type { DaemonLifecycleEntry, DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { DaemonBuildDrainStatus } from "./protocol/daemon-protocol.contract.ts";

export interface RunningDaemon {
  readonly endpoint: string;
  readonly stop: () => Promise<void>;
}
export interface DaemonServeDeferred {
  readonly pid: number | null;
  readonly endpoint: string;
  readonly witness: "unix-socket" | "singleton-lock";
}
export type DaemonServeStart = RunningDaemon | DaemonServeDeferred;
export async function startDaemon(input: {
  readonly daemonId: string;
  readonly userRoot: string;
  readonly endpoint?: string;
  readonly runtimeFile?: string;
  readonly shutdownRequested?: () => boolean;
  readonly requestShutdown?: () => void;
  readonly attachTimeoutMs?: number;
  readonly openCell?: DaemonHostOpenInput["openCell"];
}): Promise<DaemonServeStart> {
  const endpoint = input.endpoint ?? localUserDaemonEndpoint(input.userRoot, input.daemonId);
  // The singleton claim precedes every workspace attachment and the socket
  // bind, so the socket and the workspace writer locks can only ever share
  // one holder.
  const singleton = await acquireDaemonSingleton({ userRoot: input.userRoot, daemonId: input.daemonId, endpoint });
  if (singleton.claim === "incumbent") return { pid: singleton.pid, endpoint, witness: singleton.witness };
  const pidPath = daemonPidPath(input.userRoot, input.daemonId);
  mkdirSync(path.dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  const lifecycle = openDaemonLifecycleLog({ userRoot: input.userRoot, daemonId: input.daemonId });
  const build = daemonBuildStamp();
  const buildObserver = observeDaemonBuild(input.runtimeFile);
  lifecycle.record({ event: "process_start", endpoint, ...buildObserver.status() });
  // Connection- and request-level traffic sink; async by design so the socket hot path never waits on disk.
  const connLog = openDaemonConnLog({ userRoot: input.userRoot, daemonId: input.daemonId });
  let host: Awaited<ReturnType<typeof openDaemonHost>> | undefined,
    transport: ReturnType<typeof createUnixSocketTransportServer> | undefined,
    stopPromise: Promise<void> | null = null,
    activeRequests = 0,
    drainCheckScheduled = false,
    buildSupersessionObserved = false,
    socketBound = false,
    stopping = false;
  const liveRuntimeSessions = new Set<string>();
  const buildDrainStatus = (): DaemonBuildDrainStatus => {
    const repos = host?.status().repos ?? [];
    return {
      liveRuntimeSessions: liveRuntimeSessions.size,
      pendingWrites: repos.reduce((total, repo) => total + (repo.queueDepth ?? 0), 0),
      attachingRepositories: repos.filter((repo) => repo.state === "warming").length,
    };
  };
  // Shutdown used to close the socket first and release the pid file and the singleton lock after the
  // WAL drain, so for the whole length of that drain the endpoint said "gone" while the pid file and
  // the lock said "here". Three observers each guessed differently in that gap. Admission is now this
  // flag rather than a closed socket, so the endpoint stays bound and answers `daemon_stopping` until
  // the drain finishes, and endpoint, pid file and lock are released together: an observer either
  // finds a daemon that can speak for itself, or finds nothing at all.
  const stop = (outcome: "stop_requested" | "build_superseded" = "stop_requested"): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      // The release below is in `finally` because the invariant above is unconditional: whatever the
      // drain does, the pid file and the lock must not outlive this call. They used to sit after the
      // awaits, so any rejection on the way down — most easily a long migration replay failing inside
      // RepoCell.close — left the lock held by a process that was already gone, and the next daemon
      // could never claim it.
      try {
        // RepoCell.close drains each local WAL before the daemon advertises its terminal boundary.
        await host!.close();
        lifecycle.record({ event: "process_exit", outcome });
        await transport!.stop();
        await connLog.settle();
      } finally {
        rmSync(pidPath, { force: true });
        singleton.release();
      }
    })();
    return stopPromise;
  };
  const requestDrainCheck = (): void => {
    if (!buildSupersessionObserved || drainCheckScheduled || stopPromise) return;
    drainCheckScheduled = true;
    setImmediate(() => {
      drainCheckScheduled = false;
      if (stopPromise || activeRequests > 0 || !buildObserver.status().drifted) return;
      const drain = buildDrainStatus();
      if (drain.liveRuntimeSessions > 0 || drain.pendingWrites > 0 || drain.attachingRepositories > 0) return;
      void stop("build_superseded").catch((error: unknown) => {
        console.error(
          `daemon build-supersession drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };
  const recordLifecycle: DaemonLifecycleRecorder = (entry: DaemonLifecycleEntry): void => {
    lifecycle.record(entry);
    if (entry.event === "runtime_spawn" && entry.runtimeSessionId) liveRuntimeSessions.add(entry.runtimeSessionId);
    if (entry.event === "runtime_exit" && entry.runtimeSessionId) liveRuntimeSessions.delete(entry.runtimeSessionId);
    if (entry.event === "runtime_exit" || entry.event === "attachments_settled") requestDrainCheck();
  };
  try {
    host = await openDaemonHost({ ...input, endpoint, recordLifecycle });
    // One sink for the daemon; the protocol server is created per connection and reports into it.
    const requestLog = openDaemonRequestLog({
      resolveRootDir: (repoId) => host!.status().repos.find((repo) => repo.repoId === repoId)?.rootDir,
    });
    transport = createUnixSocketTransportServer({
      daemonId: input.daemonId,
      socketPath: endpoint,
      createProtocolServer: (authContext, emit, connectionId, signal) =>
        createJsonRpcProtocolServer({
          host: host!,
          build,
          buildObserver,
          authContext: { ...authContext, connectionSignal: signal },
          emit,
          connectionId: connLog.connectionOpened(connectionId, authContext.transportKind),
          recordRequest: requestLog.record,
          recordTraffic: connLog.request,
          buildDrainStatus,
          stopping: () => stopping,
          onRequestStarted: () => {
            activeRequests += 1;
          },
          onBuildDriftObserved: () => {
            buildSupersessionObserved = true;
          },
          onRequestSettled: (method) => {
            activeRequests = Math.max(0, activeRequests - 1);
            if (method !== "protocol.hello") requestDrainCheck();
          },
          requestShutdown:
            input.requestShutdown ??
            (() => {
              void stop();
            }),
        }),
      onConnectionClosed: (connection) => connLog.connectionClosed(connection.connectionId),
    });
    await transport.start();
    socketBound = true;
    lifecycle.record({ event: "socket_bound", endpoint });
    host.startAttachments();
  } catch (error) {
    lifecycle.record({
      event: "process_exit",
      outcome: "startup_failed",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    // A failed startup releases the same three keys in the same order a drained shutdown does, so a
    // bound endpoint never outlives the pid file that names its owner.
    if (socketBound) await transport!.stop();
    await connLog.settle();
    await host?.close();
    rmSync(pidPath, { force: true });
    singleton.release();
    throw error;
  }
  return { endpoint, stop };
}
export { daemonPidPath, readDaemonPid } from "./daemon-singleton.ts";
