#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";

let exitAfterSupersession = false;

async function main(argv: readonly string[], afterParentExit = false): Promise<number> {
  if (argv[0] === "--after-parent-exit") {
    // The inherited pipe closes only when the old process actually exits, releasing OS writer locks.
    process.stdin.resume();
    await once(process.stdin, "end");
    process.argv.splice(2, 1);
    return main(argv.slice(1), true);
  }
  if (argv[0] === "--runtime-worker-host") {
    const { runRuntimeWorkerHost } = await import("./runtime-worker-host.ts");
    await runRuntimeWorkerHost();
    return 0;
  }
  if (argv[0] === "offline") {
    const { runOfflineStorageCommand } = await import("./offline-storage.ts");
    return runOfflineStorageCommand(argv.slice(1));
  }
  if (!(argv[0] === "serve" || argv[0] === "--service")) {
    process.stderr.write(
      "Usage: harness-anything-daemon serve|--service [--user-root <path>] [--daemon-id <id>] [--supervised] | offline <command>\n",
    );
    return 2;
  }
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    if (at < 0) return undefined;
    const value = argv[at + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return value;
  };
  const { daemonUserRoot, daemonIdFromEnv } = await import("./client/local-daemon-target.ts");
  const { clearDaemonStoppedMarker, readDaemonStoppedAt, runtimeDaemonStartRefusal } = await import(
    "./client/daemon-autostart.ts"
  );
  const userRoot = path.resolve(option("--user-root") ?? daemonUserRoot());
  const daemonId = option("--daemon-id") ?? daemonIdFromEnv();
  const refusal = runtimeDaemonStartRefusal();
  if (refusal) throw new Error(refusal.hint);
  // A service manager starts this entry on its own schedule (boot, a restart after a killed stop),
  // so under supervision the operator's stop is still the operator's: leaving cleanly is what keeps
  // the service manager from trying again. Only `ha daemon start --service` clears the marker.
  const supervised = argv.includes("--supervised"),
    respectStoppedMarker = supervised || argv.includes("--respect-stopped-marker"),
    stoppedAt = respectStoppedMarker ? readDaemonStoppedAt(userRoot, daemonId) : null;
  if (stoppedAt) {
    if (afterParentExit) exitAfterSupersession = true;
    process.stderr.write(`daemon not started: stopped by the operator at ${stoppedAt}\n`);
    return 0;
  }
  if (!respectStoppedMarker) clearDaemonStoppedMarker(userRoot, daemonId);
  const markerOption = process.argv.indexOf("--respect-stopped-marker", 2);
  if (markerOption !== -1) process.argv.splice(markerOption, 1);
  if (afterParentExit) {
    const { installedDaemonServiceUnit } = await import("./client/daemon-service.ts");
    if (installedDaemonServiceUnit({ userRoot, daemonId })) {
      // An installed unit owns startup even if the failed incumbent was launched manually.
      const { ensureLocalDaemonRunning } = await import("./client/daemon-autostart.ts");
      const { localUserDaemonEndpoint } = await import("./client/local-daemon-target.ts");
      exitAfterSupersession = true;
      const result = await ensureLocalDaemonRunning({
        socketPath: localUserDaemonEndpoint(userRoot, daemonId),
        invokingRoot: process.cwd(),
        launch: () => ({ command: process.execPath, args: process.argv.slice(1), env: process.env }),
      });
      if (!result.ok) process.stderr.write(`daemon failure recovery could not start service: ${result.hint}\n`);
      return result.ok ? 0 : 1;
    }
  }
  return runResidentDaemon(userRoot, daemonId, supervised, (receipt, code) => {
    console.log(JSON.stringify(receipt));
    return code;
  });
}

async function runResidentDaemon(
  userRoot: string,
  daemonId: string,
  supervised: boolean,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
): Promise<number> {
  const { startDaemon } = await import("./runtime.ts"),
    { resolveOperatorGithubToken } = await import("./runtime-github-credentials.ts"),
    { ensureLocalDaemonRunning } = await import("./client/daemon-autostart.ts"),
    { daemonSupersededExitCode } = await import("./client/daemon-service.ts"),
    { localUserDaemonEndpoint } = await import("./client/local-daemon-target.ts"),
    { releaseDaemonPidFile } = await import("./daemon-singleton.ts");
  process.once("exit", () => releaseDaemonPidFile(userRoot, daemonId, process.pid));
  // The signal latch registers before startup: a TERM that lands during the
  // startup replay parks here and drains at the next yield instead of being
  // swallowed by synchronous work. stop() is idempotent, so a second signal
  // cannot cut the drain short.
  const ownerPid = daemonOwnerPid(process.env.HARNESS_DAEMON_OWNER_PID);
  let daemon: Awaited<ReturnType<typeof startDaemon>>,
    stopping: Promise<void> | null = null,
    superseded = false,
    supersessionFailed = false,
    parked: (() => void) | undefined,
    ownerLivenessTimer: NodeJS.Timeout | undefined;
  const idle = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const requestStop = () => {
    parked?.();
    stopping ??= (async () => {
      if (daemon && "stop" in daemon) await daemon.stop();
    })();
  };
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    const startResident = async (buildSupersessionEnabled: boolean) =>
      startDaemon({
        userRoot,
        daemonId,
        // The resident daemon is the process that owns the operator login: every runtime launch
        // inherits this token, so an isolated instance HOME needs no `gh auth login` of its own.
        runtimeGithubToken: resolveOperatorGithubToken,
        buildSupersessionEnabled,
        retainPidUntilExit: true,
        shutdownRequested: () => stopping !== null,
        requestShutdown: requestStop,
        onSupersededFailure: buildSupersessionEnabled
          ? async () => {
              try {
                // A failed drain cannot prove that every writer handle was released. Supervision
                // restarts after exit; the on-demand successor waits for our pipe to close first.
                if (!supervised) await startAfterResidentExit(userRoot, daemonId);
              } catch (error) {
                process.stderr.write(
                  `daemon failure recovery could not start: ${error instanceof Error ? error.message : String(error)}\n`,
                );
                throw error;
              } finally {
                supersessionFailed = true;
                superseded = true;
                parked?.();
              }
            }
          : undefined,
        onSupersededExit: buildSupersessionEnabled
          ? async () => {
              // The service manager restarts a daemon that exits non-zero; starting a successor here
              // as well would race it for the socket.
              if (supervised) {
                superseded = true;
                parked?.();
                return;
              }
              const endpoint = localUserDaemonEndpoint(userRoot, daemonId),
                successor = await ensureLocalDaemonRunning({
                  socketPath: endpoint,
                  invokingRoot: process.cwd(),
                  launch: () => ({ command: process.execPath, args: process.argv.slice(1), env: process.env }),
                });
              if (successor.ok) {
                superseded = true;
                parked?.();
                return;
              }
              process.stderr.write(`daemon successor failed readiness: ${successor.hint}\n`);
              daemon = await startResident(false);
            }
          : undefined,
      });
    daemon = await startResident(true);
    if (!("stop" in daemon)) return finish(deferredServeReceipt(daemon, userRoot), 0);
    if (ownerPid !== null)
      ownerLivenessTimer = setInterval(() => {
        if (!processExists(ownerPid)) requestStop();
      }, 250);
    const [stopResult] = await Promise.allSettled([
      (async () => {
        if (stopping === null) {
          await idle;
          await stopping;
        } else await daemon.stop();
      })(),
    ]);
    if (stopResult?.status === "rejected") {
      if (!superseded) throw stopResult.reason;
      process.stderr.write(
        `daemon supersession failed: ${stopResult.reason instanceof Error ? stopResult.reason.message : String(stopResult.reason)}\n`,
      );
    }
    // All daemon-owned resources have drained and the successor is ready (or the service
    // manager will start it). Remaining referenced handles must not keep the old process alive.
    exitAfterSupersession = superseded;
    return superseded && supervised ? daemonSupersededExitCode : supersessionFailed ? 1 : 0;
  } finally {
    if (ownerLivenessTimer) clearInterval(ownerLivenessTimer);
    process.removeListener("SIGTERM", requestStop);
    process.removeListener("SIGINT", requestStop);
  }
}

async function startAfterResidentExit(userRoot: string, daemonId: string): Promise<void> {
  const { closeDaemonOutputFd, daemonStdioLogPath, openDaemonOutputFd } = await import("./lifecycle-log.ts");
  const output = openDaemonOutputFd(daemonStdioLogPath(userRoot, daemonId));
  try {
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "--after-parent-exit", ...process.argv.slice(2), "--respect-stopped-marker"],
      {
        detached: true,
        windowsHide: true,
        stdio: ["pipe", output, output],
        env: process.env,
      },
    );
    await once(child, "spawn");
    child.unref();
  } finally {
    closeDaemonOutputFd(output);
  }
}

function daemonOwnerPid(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function deferredServeReceipt(
  incumbent: { readonly pid: number | null; readonly endpoint: string; readonly witness: string },
  userRoot: string,
): Record<string, unknown> {
  const witness =
    incumbent.witness === "unix-socket"
      ? `a daemon is already accepting connections at ${incumbent.endpoint}`
      : `daemon pid ${incumbent.pid} already holds the singleton lock for --user-root ${userRoot}`;
  return {
    ok: true,
    command: "daemon-serve",
    outcome: "deferred",
    incumbent: { pid: incumbent.pid, endpoint: incumbent.endpoint },
    summary:
      `daemon serve deferred: ${witness}; ` + "this process did not bind the socket or take any workspace writer lock.",
    nextAction: "Use the resident daemon (ha daemon status) or stop it first (ha daemon stop).",
  };
}

try {
  const exitCode = await main(process.argv.slice(2));
  if (exitAfterSupersession) process.exit(exitCode);
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  consumeKnownError(error);
  if (exitAfterSupersession) process.exit(1);
  process.exitCode = 1;
}
