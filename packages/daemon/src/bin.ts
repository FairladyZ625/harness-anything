#!/usr/bin/env node
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";

async function main(argv: readonly string[]): Promise<number> {
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
      "Usage: harness-anything-daemon serve|--service [--user-root <path>] [--daemon-id <id>] | offline <command>\n",
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
  const { clearDaemonStoppedMarker, runtimeDaemonStartRefusal } = await import("./client/daemon-autostart.ts");
  const userRoot = path.resolve(option("--user-root") ?? daemonUserRoot());
  const daemonId = option("--daemon-id") ?? daemonIdFromEnv();
  const refusal = runtimeDaemonStartRefusal();
  if (refusal) throw new Error(refusal.hint);
  clearDaemonStoppedMarker(userRoot, daemonId);
  return runResidentDaemon(userRoot, daemonId, (receipt, code) => {
    console.log(JSON.stringify(receipt));
    return code;
  });
}

async function runResidentDaemon(
  userRoot: string,
  daemonId: string,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
): Promise<number> {
  const { startDaemon } = await import("./runtime.ts"),
    { startDetachedProcess } = await import("./process-port.ts"),
    { daemonStdioLogPath } = await import("./lifecycle-log.ts");
  // The signal latch registers before startup: a TERM that lands during the
  // startup replay parks here and drains at the next yield instead of being
  // swallowed by synchronous work. stop() is idempotent, so a second signal
  // cannot cut the drain short.
  let daemon: Awaited<ReturnType<typeof startDaemon>>,
    stopping: Promise<void> | null = null,
    parked: (() => void) | undefined;
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
    daemon = await startDaemon({
      userRoot,
      daemonId,
      shutdownRequested: () => stopping !== null,
      requestShutdown: requestStop,
      // A superseded exit has no guaranteed successor starter: task-bound runtimes and worktree
      // callers are refused autostart by design, and no service manager supervises this process,
      // so the outgoing daemon hands the slot to the disk build itself. The entry path on disk is
      // the new build — that is what drift means — and the singleton arbitrates any race with a
      // concurrent autostart.
      onSupersededExit: () => {
        startDetachedProcess(
          process.execPath,
          process.argv.slice(1),
          process.env,
          daemonStdioLogPath(userRoot, daemonId),
          process.cwd(),
        );
      },
    });
    if (!("stop" in daemon)) return finish(deferredServeReceipt(daemon, userRoot), 0);
    if (stopping === null) {
      await idle;
      await stopping;
    } else await daemon.stop();
    return 0;
  } finally {
    process.removeListener("SIGTERM", requestStop);
    process.removeListener("SIGINT", requestStop);
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
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  consumeKnownError(error);
}
