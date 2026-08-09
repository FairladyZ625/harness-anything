// PLT-Honest: owns the per-socket startup-flight lifecycle for daemon
// autostart. Extracted from local-json-rpc-client.ts so that file stays under
// the complexity budget. Two invariants live here:
//
//   1. Single-flight dedup: concurrent callers on one socket share one spawn.
//   2. Resurrection-chain guard: a spawned daemon that is still alive (honest
//      slow start) is JOINED by later callers instead of spawning a sibling,
//      and a consecutive-death breaker opens after N genuine deaths. Both
//      come from daemon-autostart-circuit.ts; this module wires them into the
//      spawn/probe loop.
import {
  daemonAutostartFailureError,
  daemonAutostartProcessExitedError,
  daemonProcessIsAlive,
  DaemonAutostartTimeoutError,
  type SpawnedDaemonAutostartProcess
} from "./daemon-autostart-process.ts";
import {
  clearLiveDaemonStartup,
  daemonAutostartCircuitDecision,
  daemonAutostartCircuitOpenError,
  liveDaemonStartupPid,
  recordLiveDaemonStartup,
  reportDaemonAutostartOutcome,
  resolveDaemonAutostartCircuitOptions,
  type DaemonAutostartCircuitOptions
} from "./daemon-autostart-circuit.ts";
import { connectUnixSocketWithNamespaceDiagnostic } from "./daemon-socket-connection.ts";
import { JsonRpcLineClient } from "./json-rpc-line-client.ts";
import { currentDaemonProtocolVersion } from "../protocol/method-registry.ts";

// Local type aliases avoid a circular import on local-json-rpc-client.ts.
// Both the target and options types are generic so callers pass their full
// concrete types through without the flight module depending on them.
export interface DaemonAutostartFlightPhase {
  readonly env?: NodeJS.ProcessEnv;
  readonly onPhase?: (phase: "connect-start" | "launch-start" | "ready" | "request-start" | "request-end") => void;
}
export interface DaemonStartupFlight {
  startedAt: number;
  deadline: number;
  lastError: unknown;
  spawnedPid?: number;
  observedSocketOwnerPid?: number;
  launchStderrPath?: string;
  promise: Promise<void>;
}
export interface DaemonAutostartFlightDeps<Target, Options extends DaemonAutostartFlightPhase> {
  readonly launchLocalDaemon: (
    target: Target,
    options: Options
  ) => SpawnedDaemonAutostartProcess;
  readonly localDaemonRetryIntervalMs: number;
  readonly minimumReadyProbeResponseTimeoutMs: number;
  readonly readDaemonSocketOwner?: (
    socketPath: string
  ) => { readonly pid: number; readonly alive: boolean } | undefined;
}
const daemonStartupFlights = new Map<string, DaemonStartupFlight>();
export function createDaemonAutostartFlightManager<Target extends { readonly socketPath: string }, Options extends DaemonAutostartFlightPhase>(
  deps: DaemonAutostartFlightDeps<Target, Options>
) {
  const minimumReadyProbeResponseTimeoutMs = deps.minimumReadyProbeResponseTimeoutMs;
  async function ensureLocalDaemonStarted(
    target: Target,
    autostart: Options,
    connectTimeoutMs: number,
    deadline: number,
    autostartTimeoutMs: number
  ): Promise<void> {
    const existing = daemonStartupFlights.get(target.socketPath);
    if (existing) {
      if (Date.now() >= existing.deadline) {
        daemonStartupFlights.delete(target.socketPath);
      } else {
        existing.deadline = Math.max(existing.deadline, deadline);
        return waitForDaemonStartupFlight(target.socketPath, existing, deadline, autostartTimeoutMs);
      }
    }
    // PLT-Honest resurrection-chain guard: join a live spawned pid instead of
    // spawning a sibling. See module header.
    const livePid = liveDaemonStartupPid(target.socketPath);
    const circuitOptions = resolveDaemonAutostartCircuitOptions(autostart.env ?? process.env);
    if (livePid !== undefined) {
      const flight: DaemonStartupFlight = {
        startedAt: Date.now(),
        deadline,
        lastError: undefined,
        spawnedPid: livePid,
        promise: Promise.resolve()
      };
      flight.promise = joinLiveDaemonStartup(target, connectTimeoutMs, flight, circuitOptions);
      daemonStartupFlights.set(target.socketPath, flight);
      flight.promise.then(
        () => clearDaemonStartupFlight(target.socketPath, flight),
        () => clearDaemonStartupFlight(target.socketPath, flight)
      );
      return waitForDaemonStartupFlight(target.socketPath, flight, deadline, autostartTimeoutMs);
    }
    const decision = daemonAutostartCircuitDecision(target.socketPath, circuitOptions);
    if (!decision.allowSpawn) {
      throw daemonAutostartCircuitOpenError(target.socketPath, decision, circuitOptions);
    }
    const flight: DaemonStartupFlight = {
      startedAt: Date.now(),
      deadline,
      lastError: undefined,
      promise: Promise.resolve()
    };
    flight.promise = spawnAndWaitForLocalDaemon(target, autostart, connectTimeoutMs, flight, circuitOptions);
    daemonStartupFlights.set(target.socketPath, flight);
    flight.promise.then(
      () => clearDaemonStartupFlight(target.socketPath, flight),
      () => clearDaemonStartupFlight(target.socketPath, flight)
    );
    return waitForDaemonStartupFlight(target.socketPath, flight, deadline, autostartTimeoutMs);
  }
  async function spawnAndWaitForLocalDaemon(
    target: Target,
    autostart: Options,
    connectTimeoutMs: number,
    flight: DaemonStartupFlight,
    circuitOptions: DaemonAutostartCircuitOptions
  ): Promise<void> {
    autostart.onPhase?.("launch-start");
    const launch = deps.launchLocalDaemon(target, autostart);
    flight.spawnedPid = launch.pid;
    flight.launchStderrPath = launch.launchStderrPath;
    recordLiveDaemonStartup(target.socketPath, launch.pid);
    while (Date.now() <= flight.deadline) {
      try {
        await probeLocalDaemonReady(
          target.socketPath,
          boundedDeadlineTimeout(connectTimeoutMs, flight.deadline),
          readyProbeResponseTimeout(flight.deadline)
        );
        autostart.onPhase?.("ready");
        reportDaemonAutostartOutcome(target.socketPath, {
          ok: true, spawnedPid: flight.spawnedPid, processExited: false, cause: undefined
        }, circuitOptions);
        return;
      } catch (error) {
        flight.lastError = error;
        const exited = daemonAutostartProcessExitedError(flight.lastError, flight.spawnedPid, flight.launchStderrPath);
        if (exited) {
          const owner = deps.readDaemonSocketOwner?.(target.socketPath);
          if (owner?.alive && owner.pid !== flight.spawnedPid) {
            flight.observedSocketOwnerPid = owner.pid;
            clearLiveDaemonStartup(target.socketPath, flight.spawnedPid);
          } else {
            reportDaemonAutostartOutcome(target.socketPath, {
              ok: false, spawnedPid: flight.spawnedPid, processExited: true, cause: flight.lastError
            }, circuitOptions);
            throw exited;
          }
        }
        const retryDelayMs = Math.min(deps.localDaemonRetryIntervalMs, flight.deadline - Date.now());
        if (retryDelayMs > 0) await delay(retryDelayMs);
      }
    }
    const observedOwner = observedLiveSocketOwner(target.socketPath, flight);
    const processExited = flight.spawnedPid !== undefined && !daemonProcessIsAlive(flight.spawnedPid);
    reportDaemonAutostartOutcome(target.socketPath, {
      ok: false,
      spawnedPid: observedOwner ? undefined : flight.spawnedPid,
      processExited: observedOwner ? false : processExited,
      cause: flight.lastError
    }, circuitOptions);
    throw daemonStartupFlightFailure(flight, target.socketPath, flight.deadline - flight.startedAt);
  }
  async function joinLiveDaemonStartup(
    target: Target,
    connectTimeoutMs: number,
    flight: DaemonStartupFlight,
    circuitOptions: DaemonAutostartCircuitOptions
  ): Promise<void> {
    while (Date.now() <= flight.deadline) {
      if (flight.spawnedPid !== undefined && !daemonProcessIsAlive(flight.spawnedPid)) {
        clearLiveDaemonStartup(target.socketPath, flight.spawnedPid);
        throw new Error(
          "DAEMON_AUTOSTART_LIVE_EXITED: the daemon process pid " + flight.spawnedPid + " that was still"
          + " starting on socket " + target.socketPath + " exited before readiness. It was not killed by this"
          + " client; inspect its launch log. This is a genuine startup failure, not a slow cold start."
        );
      }
      try {
        await probeLocalDaemonReady(
          target.socketPath,
          boundedDeadlineTimeout(connectTimeoutMs, flight.deadline),
          readyProbeResponseTimeout(flight.deadline)
        );
        reportDaemonAutostartOutcome(target.socketPath, {
          ok: true, spawnedPid: flight.spawnedPid, processExited: false, cause: undefined
        }, circuitOptions);
        return;
      } catch (error) {
        flight.lastError = error;
        const retryDelayMs = Math.min(deps.localDaemonRetryIntervalMs, flight.deadline - Date.now());
        if (retryDelayMs > 0) await delay(retryDelayMs);
      }
    }
    const processExited = flight.spawnedPid !== undefined && !daemonProcessIsAlive(flight.spawnedPid);
    if (processExited) {
      clearLiveDaemonStartup(target.socketPath, flight.spawnedPid);
    }
    reportDaemonAutostartOutcome(target.socketPath, {
      ok: false, spawnedPid: flight.spawnedPid, processExited, cause: flight.lastError
    }, circuitOptions);
    throw daemonAutostartFailureError(flight.deadline - flight.startedAt, flight.lastError, flight.spawnedPid, flight.launchStderrPath);
  }
  async function waitForDaemonStartupFlight(
    socketPath: string,
    flight: DaemonStartupFlight,
    deadline: number,
    autostartTimeoutMs: number
  ): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (deadline >= flight.deadline) clearDaemonStartupFlight(socketPath, flight);
      throw daemonStartupFlightFailure(flight, socketPath, autostartTimeoutMs);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (deadline >= flight.deadline) clearDaemonStartupFlight(socketPath, flight);
        reject(daemonStartupFlightFailure(flight, socketPath, autostartTimeoutMs));
      }, remainingMs);
      flight.promise.then(
        () => { clearTimeout(timer); resolve(); },
        (error: unknown) => { clearTimeout(timer); reject(error); }
      );
    });
  }
  function clearDaemonStartupFlight(socketPath: string, flight: DaemonStartupFlight): void {
    if (daemonStartupFlights.get(socketPath) === flight) daemonStartupFlights.delete(socketPath);
  }
  function observedLiveSocketOwner(
    socketPath: string,
    flight: DaemonStartupFlight
  ): { readonly pid: number; readonly alive: true } | undefined {
    if (flight.observedSocketOwnerPid === undefined) return undefined;
    const owner = deps.readDaemonSocketOwner?.(socketPath);
    return owner?.alive && owner.pid === flight.observedSocketOwnerPid
      ? { pid: owner.pid, alive: true }
      : undefined;
  }
  function daemonStartupFlightFailure(
    flight: DaemonStartupFlight,
    socketPath: string,
    timeoutMs: number
  ): Error {
    const owner = observedLiveSocketOwner(socketPath, flight);
    return owner
      ? new DaemonAutostartTimeoutError(timeoutMs, flight.lastError, owner.pid, "observed-socket-owner")
      : daemonAutostartFailureError(timeoutMs, flight.lastError, flight.spawnedPid, flight.launchStderrPath);
  }
  function readyProbeResponseTimeout(deadline: number): number {
    const remainingMs = Math.max(1, deadline - Date.now());
    return Math.min(remainingMs, Math.max(minimumReadyProbeResponseTimeoutMs, Math.floor(remainingMs / 2)));
  }
  return { ensureLocalDaemonStarted };
}
export async function probeLocalDaemonReady(
  socketPath: string,
  connectTimeoutMs: number,
  responseTimeoutMs: number
): Promise<void> {
  const socket = await connectUnixSocketWithNamespaceDiagnostic(socketPath, connectTimeoutMs);
  const client = new JsonRpcLineClient(socket, socket);
  try {
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, responseTimeoutMs);
  } finally {
    socket.destroy();
  }
}
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function boundedDeadlineTimeout(timeoutMs: number, deadline: number): number {
  return Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
}
