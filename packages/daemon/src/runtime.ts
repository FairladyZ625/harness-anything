import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readDaemonRegistry } from "@harness-anything/kernel/daemon-registry";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import { acquireDaemonSingleton, daemonPidPath } from "./daemon-singleton.ts";
import type { openDaemonHost } from "./daemon-host.ts";
import type { openDaemonRequestLog } from "./request-log.ts";
import { openDaemonLifecycleLog } from "./lifecycle-log.ts";
import { openDaemonConnLog } from "./conn-log.ts";
import { daemonBuildStamp, observeDaemonBuild, type DaemonBuildObserver } from "./build-identity.ts";
import { firstWorkspaceLinkFinding, workspaceLinkFailure } from "./workspace-link-integrity.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";
import type { DaemonHostOpenInput } from "./daemon-host-open.ts";
import type { DaemonLifecycleEntry, DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { DaemonBuildDrainStatus } from "./protocol/daemon-protocol.contract.ts";
import type { openDaemonDiagnostics } from "./daemon-diagnostics.ts";

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
/** Teardown must reach the lock even when an earlier step rejects; resident supersession keeps
 *  its pid until process exit. A teardown failure must not mask the drain's own rejection. */
async function settleTeardownStep(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    // The caller is already unwinding and the remaining teardown matters more than this step's reason.
    consumeKnownError(error);
  }
}

export async function startDaemon(input: {
  readonly daemonId: string;
  readonly userRoot: string;
  readonly endpoint?: string;
  readonly runtimeFile?: string;
  readonly buildObserver?: DaemonBuildObserver;
  readonly shutdownRequested?: () => boolean;
  readonly requestShutdown?: () => void;
  readonly attachTimeoutMs?: number;
  readonly openCell?: DaemonHostOpenInput["openCell"];
  readonly runtimeDiscover?: DaemonHostOpenInput["runtimeDiscover"];
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  /** Reads the operator's GitHub token once per launch; set by the resident daemon entry. */
  readonly runtimeGithubToken?: DaemonHostOpenInput["runtimeGithubToken"];
  readonly runtimeCredentialPort?: DaemonHostOpenInput["runtimeCredentialPort"];
  readonly managedRbac?: DaemonHostOpenInput["managedRbac"];
  /** Optional platform skill evaluation capability supplied by the daemon composition root. */
  readonly skillEval?: DaemonHostOpenInput["skillEval"];
  readonly skillEvalRunner?: DaemonHostOpenInput["skillEvalRunner"];
  /** Called after a build-superseded exit released the socket and singleton, so the resident
   * entry can hand the slot to the disk build. */
  readonly onSupersededExit?: () => void | Promise<void>;
  /** A failed handoff may leave writers alive: a resident must exit before its replacement opens them. */
  readonly onSupersededFailure?: () => void | Promise<void>;
  readonly buildSupersessionEnabled?: boolean;
  /** Resident entries retain the outgoing pid until actual process exit for force-stop discovery. */
  readonly retainPidUntilExit?: boolean;
  readonly shutdownDeadlineMs?: number;
  readonly shutdownDeadlineExceeded?: () => void;
}): Promise<DaemonServeStart> {
  const endpoint = input.endpoint ?? localUserDaemonEndpoint(input.userRoot, input.daemonId);
  // The singleton claim precedes every workspace attachment and the socket
  // bind, so the socket and the workspace writer locks can only ever share
  // one holder.
  const singleton = await acquireDaemonSingleton({ userRoot: input.userRoot, daemonId: input.daemonId, endpoint });
  if (singleton.claim === "incumbent") return { pid: singleton.pid, endpoint, witness: singleton.witness };
  try {
    const finding = firstWorkspaceLinkFinding(
      readDaemonRegistry({ userRoot: input.userRoot })
        .repos.filter((repo) => repo.state === "enabled" && repo.mode === "local" && repo.canonicalRoot !== null)
        .map((repo) => repo.canonicalRoot!),
    );
    if (finding) throw workspaceLinkFailure(finding);
  } catch (error) {
    singleton.release();
    throw error;
  }
  const pidPath = daemonPidPath(input.userRoot, input.daemonId);
  mkdirSync(path.dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  const lifecycle = openDaemonLifecycleLog({ userRoot: input.userRoot, daemonId: input.daemonId });
  const build = daemonBuildStamp();
  const buildObserver = input.buildObserver ?? observeDaemonBuild(input.runtimeFile);
  lifecycle.record({ event: "process_start", endpoint, ...buildObserver.status() });
  // Connection- and request-level traffic sink; async by design so the socket hot path never waits on disk.
  const connLog = openDaemonConnLog({ userRoot: input.userRoot, daemonId: input.daemonId });
  let observation: typeof import("./daemon-operation.ts");
  let diagnostics: Awaited<ReturnType<typeof openDaemonDiagnostics>> | undefined;
  let host: Awaited<ReturnType<typeof openDaemonHost>> | undefined,
    requestLog: ReturnType<typeof openDaemonRequestLog> | null = null,
    transport: ReturnType<typeof createUnixSocketTransportServer> | undefined,
    stopPromise: Promise<void> | null = null,
    activeRequests = 0,
    drainCheckScheduled = false,
    buildSupersessionObserved = false,
    socketBound = false,
    stopping = false;
  let fleetDrainDeadline: ReturnType<typeof setTimeout> | undefined;
  let buildDrainRecheck: ReturnType<typeof setInterval> | undefined;
  let fleetDrainExpired = false;
  const runtimeProcessPids = new Map<string, number>();
  const buildDraining = (): boolean => input.buildSupersessionEnabled !== false && buildSupersessionObserved;
  const buildDrainStatus = (): DaemonBuildDrainStatus => {
    const repos = host?.status().repos ?? [];
    return {
      // Informational only: it answers "how many live workers is the exit leaving behind for the
      // next daemon to adopt", not "what is still holding the daemon".
      liveRuntimeSessions: [...runtimeProcessPids.values()].filter(runtimePidIsAlive).length,
      pendingWrites: repos.reduce((total, repo) => total + (repo.queueDepth ?? 0), 0),
      attachingRepositories: repos.filter((repo) => repo.state === "warming").length,
    };
  };
  let supersessionFailure: Promise<void> | null = null;
  const notifySupersessionFailure = (): Promise<void> =>
    (supersessionFailure ??= (async () => {
      const [recovery] = await Promise.allSettled([Promise.resolve().then(() => input.onSupersededFailure?.())]);
      if (recovery?.status === "rejected")
        console.error(
          `daemon build-supersession failure recovery failed: ${recovery.reason instanceof Error ? recovery.reason.message : String(recovery.reason)}`,
        );
    })());
  // Shutdown used to close the socket first and release the pid file and the singleton lock after the
  // Git follower drain, so for the whole length of that drain the endpoint said "gone" while the pid file and
  // the lock said "here". Three observers each guessed differently in that gap. Admission is now this
  // flag rather than a closed socket, so the endpoint stays bound and answers `daemon_stopping` until
  // the drain finishes. A resident supersession may retain the outgoing pid until process exit;
  // the singleton remains the authority for claiming the released socket.
  const stop = (outcome: "stop_requested" | "build_superseded" = "stop_requested"): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    diagnostics?.state("stopping");
    lifecycle.record({ event: "process_stopping", outcome });
    clearTimeout(fleetDrainDeadline);
    clearInterval(buildDrainRecheck);
    stopPromise = (async () => {
      let drainFailed = false,
        deadlineExpired = false;
      const shutdownDeadlineMs = input.shutdownDeadlineMs ?? 30_000;
      const deadline = setTimeout(async () => {
        deadlineExpired = true;
        lifecycle.record({
          event: "process_exit",
          outcome: "shutdown_deadline_exceeded",
          reason: outcome,
          durationMs: shutdownDeadlineMs,
          error: JSON.stringify({ ...buildDrainStatus(), activeResources: process.getActiveResourcesInfo() }),
        });
        if (outcome === "build_superseded") {
          // Keep the writer claim until actual exit, even if the drain completes while the
          // existing pipe-gated successor is being prepared. A late rejection shares that recovery.
          drainFailed = true;
          await notifySupersessionFailure();
        }
        (input.shutdownDeadlineExceeded ?? (() => process.exit(1)))();
      }, shutdownDeadlineMs);
      deadline.unref();
      // Only the drain belongs in `try`; everything below it is teardown and the invariant above is
      // unconditional. These used to sit after the awaits, so any rejection on the way down — most
      // easily a long migration replay failing inside RepoCell.close — left the socket bound, the pid
      // file present and the lock held by a process that was already gone, and the next daemon could
      // never claim it. Each teardown step is also individually guarded, because one of them failing
      // must not strand the ones after it: a half-released daemon is the state this whole comment
      // exists to prevent.
      try {
        // RepoCell.close drains each Git follower before the daemon advertises its terminal boundary.
        await observation.withDaemonObservation(diagnostics!.observer, () =>
          observation.observeDaemonOperation({ method: "daemon.close", actor: "daemon", phase: "host.close" }, () =>
            host!.close(),
          ),
        );
      } catch (error) {
        drainFailed = true;
        if (outcome === "build_superseded")
          console.error(
            `daemon build-supersession drain failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        throw error;
      } finally {
        if (!deadlineExpired) lifecycle.record({ event: "process_exit", outcome });
        await settleTeardownStep(() => transport!.stop());
        await settleTeardownStep(() => connLog.settle());
        await settleTeardownStep(() => requestLog?.settle() ?? Promise.resolve());
        await settleTeardownStep(() => diagnostics!.close());
        // A resident being superseded keeps its pid until it really exits, so force-stop can find
        // it after the socket closes. Its exit hook removes only its own pid; a successor may replace it.
        if (outcome !== "build_superseded" || input.retainPidUntilExit !== true)
          await settleTeardownStep(async () => rmSync(pidPath, { force: true }));
        // A rejected drain cannot prove its writer threads stopped. Keep the singleton until
        // the resident actually dies; the next claimant removes the now-stale PID lock.
        if (!(drainFailed && outcome === "build_superseded" && input.retainPidUntilExit === true)) singleton.release();
        if (drainFailed && outcome === "build_superseded") await notifySupersessionFailure();
        clearTimeout(deadline);
      }
      // Only the supersession outcome restarts itself: an operator stop means stop, and the
      // stopped marker the CLI wrote for it blocks autostart until the operator says otherwise.
      if (outcome === "build_superseded" && !drainFailed) {
        try {
          await input.onSupersededExit?.();
        } catch (error) {
          console.error(
            `daemon build-supersession successor failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await notifySupersessionFailure();
          throw error;
        }
      }
    })();
    return stopPromise;
  };
  const requestDrainCheck = (): void => {
    if (input.buildSupersessionEnabled === false || !buildSupersessionObserved || drainCheckScheduled || stopPromise)
      return;
    drainCheckScheduled = true;
    setImmediate(() => {
      drainCheckScheduled = false;
      if (stopPromise || activeRequests > 0 || !buildObserver.status().drifted) return;
      const drain = buildDrainStatus();
      // Live runtime sessions are deliberately absent: workers run detached and the next daemon
      // re-adopts them by pid, so waiting for them would only keep superseded code resident.
      if (drain.pendingWrites > 0 || drain.attachingRepositories > 0) return;
      if (!fleetDrainExpired && host!.pendingFleetDeliveries() > 0) return;
      void stop("build_superseded").catch((error: unknown) => {
        console.error(
          `daemon build-supersession stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };
  const recordLifecycle: DaemonLifecycleRecorder = (entry: DaemonLifecycleEntry): void => {
    lifecycle.record(entry);
    if (entry.event === "runtime_spawn" && entry.runtimeSessionId && entry.pid !== undefined)
      runtimeProcessPids.set(entry.runtimeSessionId, entry.pid);
    if (entry.event === "runtime_exit" && entry.runtimeSessionId) runtimeProcessPids.delete(entry.runtimeSessionId);
    if (entry.event === "runtime_exit" || entry.event === "attachments_settled") requestDrainCheck();
  };
  try {
    // Loading the server graph is part of startup, not a prerequisite for reporting it. The
    // singleton already owns this generation, so the existing process_start covers cold imports.
    const [
      { requireExecutionRequestScope },
      { authenticateRuntimeExecutionPrincipal },
      { openDaemonHost },
      { createJsonRpcProtocolServer },
      { openDaemonRequestLog },
      { createIdentitySession },
      { readRuntimeExecutionPrincipal },
      { openDaemonDiagnostics },
      operations,
    ] = await Promise.all([
      import("./runtime-execution-scope.ts"),
      import("./runtime-execution-credential.ts"),
      import("./daemon-host.ts"),
      import("./protocol/json-rpc-server.ts"),
      import("./request-log.ts"),
      import("./authorization-provider.ts"),
      import("./runtime-execution-principal-store.ts"),
      import("./daemon-diagnostics.ts"),
      import("./daemon-operation.ts"),
    ]);
    observation = operations;
    diagnostics = await openDaemonDiagnostics({
      ...input,
      endpoint,
      writeQueues: () => host?.writeQueues() ?? [],
    });
    const oidc = createIdentitySession(input.userRoot);
    host = await observation.withDaemonObservation(diagnostics.observer, () =>
      openDaemonHost({
        ...input,
        endpoint,
        recordLifecycle,
        oidc,
        onRepoStatusChange: requestDrainCheck,
        buildDraining,
        recordTraffic: connLog.request,
      }),
    );
    // One sink for the daemon; the protocol server is created per connection and reports into it.
    requestLog = openDaemonRequestLog({
      resolveRootDir: (repoId) => host!.status().repos.find((repo) => repo.repoId === repoId)?.rootDir,
    });
    transport = createUnixSocketTransportServer({
      daemonId: input.daemonId,
      socketPath: endpoint,
      adjustFrameArrival: (observedAtMs) => diagnostics?.frameArrivalAt(observedAtMs) ?? observedAtMs,
      createProtocolServer: (authContext, emit, connectionId, signal) =>
        createJsonRpcProtocolServer({
          host: host!,
          operationObserver: diagnostics!.observer,
          build,
          buildObserver,
          authContext: { ...authContext, connectionSignal: signal },
          executionPrincipal: async (credential, method, params) => {
            const repoId =
              typeof params.repo === "object" && params.repo !== null && "repoId" in params.repo
                ? String(params.repo.repoId)
                : undefined;
            const edgeRepo = host!.status().repos.find((repo) => repo.repoId === repoId && repo.mode === "remote-edge");
            const principal = edgeRepo
              ? readRuntimeExecutionPrincipal(edgeRepo.rootDir, credential)
              : await authenticateRuntimeExecutionPrincipal(() => host!.keycloakCenter(), credential);
            if (!principal)
              throw Object.assign(new Error("Execution credential is unknown or expired on this edge runtime."), {
                code: "authorization_denied",
              });
            requireExecutionRequestScope(principal, method, params);
            return principal;
          },
          sessionIndependentRead: (method, params) => {
            if (
              ![
                "repo.agentRuntime.overview",
                "repo.agentRuntime.sessions.read",
                "repo.agentRuntime.sessions.await",
              ].includes(method)
            )
              return false;
            const repoId =
              typeof params.repo === "object" && params.repo !== null && "repoId" in params.repo
                ? String(params.repo.repoId)
                : undefined;
            return host!.status().repos.some((repo) => repo.repoId === repoId && repo.mode === "remote-edge");
          },
          edgeExecutionPrincipal: async (credential) => {
            const principal = host!
              .status()
              .repos.filter((repo) => repo.mode === "remote-edge")
              .map((repo) => readRuntimeExecutionPrincipal(repo.rootDir, credential))
              .find((entry) => entry !== null);
            if (!principal)
              throw Object.assign(new Error("Execution credential is unknown or expired on this edge runtime."), {
                code: "authorization_denied",
              });
            return principal;
          },
          sessionPrincipal: (method, params) =>
            host!.sessionPrincipal(
              {
                transportKind: authContext.transportKind,
                ...(authContext.unixSocketOwnerBoundary
                  ? { unixSocketOwnerBoundary: authContext.unixSocketOwnerBoundary }
                  : {}),
              },
              method,
              params,
            ),
          emit,
          connectionId: connLog.connectionOpened(connectionId, authContext.transportKind),
          recordRequest: requestLog!.record,
          recordTraffic: connLog.request,
          buildDrainStatus,
          buildDraining,
          stopping: () => stopping,
          onRequestStarted: () => {
            activeRequests += 1;
          },
          onBuildDriftObserved: () => {
            if (buildSupersessionObserved || input.buildSupersessionEnabled === false) return;
            buildSupersessionObserved = true;
            diagnostics!.state("draining");
            // A parked read can be the first request to observe drift and never settle. Start
            // checking here, and keep checking while work drains even if no more RPCs complete.
            // This only rechecks the existing gates; elapsed time never cancels a write or attach.
            buildDrainRecheck = setInterval(requestDrainCheck, 1_000);
            buildDrainRecheck.unref();
            requestDrainCheck();
            // Admitted deliveries already have a 30-minute total deadline. Preparation can
            // stall before that deadline starts, so build drain uses the same bound.
            fleetDrainDeadline = setTimeout(() => {
              fleetDrainExpired = true;
              requestDrainCheck();
            }, 30 * 60_000);
            fleetDrainDeadline.unref();
          },
          onRequestSettled: () => {
            activeRequests = Math.max(0, activeRequests - 1);
            requestDrainCheck();
          },
          requestShutdown:
            input.requestShutdown ??
            (() => {
              void stop();
            }),
        }),
      onConnectionClosed: (connection) => connLog.connectionClosed(connection.connectionId),
    });
    await observation.withDaemonObservation(diagnostics.observer, () => transport!.start());
    socketBound = true;
    lifecycle.record({ event: "socket_bound", endpoint });
    diagnostics.state("running");
    observation.withDaemonObservation(diagnostics.observer, () => host!.startAttachments());
  } catch (error) {
    clearInterval(buildDrainRecheck);
    clearTimeout(fleetDrainDeadline);
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
    await diagnostics?.close();
    rmSync(pidPath, { force: true });
    singleton.release();
    throw error;
  }
  return { endpoint, stop };
}
export { daemonPidPath, readDaemonPid } from "./daemon-singleton.ts";
