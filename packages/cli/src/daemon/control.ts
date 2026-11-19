import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import path from "node:path";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import type { DaemonShutdownExchange } from "@harness-anything/daemon/internal/client/local-json-rpc-shutdown";
import { terminateProcess } from "@harness-anything/daemon/internal/process-port";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { readFleetEdgeConfig } from "@harness-anything/daemon/internal/client/fleet-edge-config";
import {
  isDaemonUnreachable,
  clearDaemonStoppedMarker,
  runtimeDaemonStartRefusal,
  writeDaemonStoppedMarker,
} from "@harness-anything/daemon/internal/client/daemon-autostart";
import {
  daemonProcessAlive,
  daemonSocketProbe,
  readDaemonPid,
  readDaemonSingletonLockPid,
  releaseDaemonPidFile,
  releaseDaemonSingletonLock,
} from "@harness-anything/daemon/internal/daemon-singleton";
import { cliErrorMessage } from "../cli-error.ts";
import { consumeKnownError } from "./client.ts";
import { ensureCliDaemonRunning } from "./autostart.ts";
import { firstCliCommandIndex } from "../cli/command-index.ts";
import { daemonFailure, daemonOption } from "./control-support.ts";
import { assessDaemonStatus, status } from "./control-status.ts";
import { fleetRepointControl } from "./fleet-repoint-control.ts";
const fleetNumber = { port: /^(?:0|[1-9][0-9]{0,4})$/u, quota: /^[1-9][0-9]{0,15}$/u };
type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;
export async function runDaemonControl(argv: readonly string[], renderReceipt: ReceiptEmitter): Promise<number> {
  const at = firstCliCommandIndex(argv);
  const command = argv[at + 1];
  const metricsValidationFailure = await metricsValidationError(argv, command);
  if (metricsValidationFailure) {
    renderReceipt(
      daemonFailure("daemon-metrics", "invalid_field", cliErrorMessage(metricsValidationFailure)),
      argv.includes("--json"),
    );
    return 1;
  }
  const subcommand = argv[at + 2];
  const json = argv.includes("--json"),
    userRoot = path.resolve(daemonOption(argv, "--user-root") ?? daemonUserRoot()),
    invokingRoot = path.resolve(daemonOption(argv, "--root") ?? process.cwd());
  const daemonId = daemonOption(argv, "--daemon-id") ?? daemonIdFromEnv(),
    finish: ControlFinisher = (receipt, exitCode) => finishControlReceipt(renderReceipt, receipt, json, exitCode);
  // A worker's execution authority never includes local service controls or their signal ladder.
  // `probe` is the exception: it sends only hello/status, reads process counters, and captures with
  // read-only tools, so the dispatched task can produce its own real-center availability evidence.
  if (process.env.HARNESS_EXECUTION_CREDENTIAL && command !== "probe") {
    renderReceipt(
      daemonFailure(
        `${argv[at]}-${argv[at + 1] ?? "status"}`,
        "execution_credential_rejected",
        "Execution credentials are restricted to the dispatched task; use a human session for daemon controls.",
      ),
      argv.includes("--json"),
    );
    return 1;
  }
  if (argv[at] === "gui") {
    const { runGuiLaunch } = await import("../cli/gui-launch.ts");
    return runGuiLaunch(argv, {}, renderReceipt);
  }
  try {
    if (command === "probe") {
      const { runDaemonProbeControl } = await import("./probe/probe-control.ts");
      return await runDaemonProbeControl(argv, userRoot, daemonId, finish);
    }
    if (!(command === "status" || command === undefined)) {
      const { assertCanonicalCliEntry } = await import("./cli-entry-guard.ts");
      assertCanonicalCliEntry();
    }
    const observed = await runDaemonObserverCommand(command, argv, userRoot, daemonId, json, finish);
    if (observed !== undefined) return observed;
    if (command === "projection" && subcommand === "rebuild") {
      const suppliedRoot = daemonOption(argv, "--root");
      if (argv.includes("--root") && (!suppliedRoot || suppliedRoot.startsWith("-")))
        return finish(
          daemonFailure("daemon-projection-rebuild", "missing_field", "Add a workspace path after --root."),
          2,
        );
      const target = await resolveLocalDaemonTarget({
        rootDir: path.resolve(suppliedRoot ?? process.cwd()),
        repoIdOverride: daemonOption(argv, "--repo"),
        userRoot,
        daemonId,
      });
      const result = await requestDaemonJsonRpcAt(
        target.socketPath,
        "repo.task.run",
        { repo: { repoId: target.repoId }, payload: { action: { kind: "projection-rebuild" } } },
        75,
      );
      return finish(result, result.ok === true ? 0 : 1);
    }
    // `return await`, not `return`: a bare return resolves the subcommand's rejection only after
    // this catch has let go, and a known coded error leaves the CLI as a bare stack, not a receipt.
    if (command === "fleet" || argv[at] === "fleet")
      return await dispatchFleetControl(argv, at, userRoot, daemonId, finish);
    if (command === "auto-claim") return await runNodeAutoClaimControl(argv, at, userRoot, daemonId, finish);
    const repoResult = await maybeRunDaemonRepoControl(command, argv, subcommand, userRoot, daemonId, finish);
    if (repoResult !== undefined) return repoResult;
    if (command === "connection") {
      const { runDaemonConnectionControl } = await import("./connection-control.ts");
      return await runDaemonConnectionControl(argv, subcommand, userRoot, daemonId, finish);
    }
    if (command === "service") {
      const { runDaemonServiceControl } = await import("./service-control.ts");
      return await runDaemonServiceControl(subcommand, userRoot, daemonId, invokingRoot, finish);
    }
    if (command === "start") return await startDaemonService(argv, userRoot, daemonId, invokingRoot, finish);
    if (command === "status") {
      const assessed = assessDaemonStatus(await status(userRoot, daemonId, argv));
      return finish(assessed.receipt, assessed.exitCode);
    }
    if (command === "stop") {
      const pid = readDaemonPid(userRoot, daemonId);
      if (pid === null) return finish(daemonFailure("daemon-stop", "daemon_unavailable", "No daemon is running."), 1);
      if (daemonProcessAlive(pid) && !argv.includes("--daemon-id")) {
        try {
          await resolveLocalDaemonTarget({ rootDir: invokingRoot, userRoot, daemonId, env: {} });
        } catch (error) {
          if (code(error) !== "workspace_not_registered") throw error;
          return finish(
            daemonFailure(
              "daemon-stop",
              "workspace_not_registered",
              "Run this command from a workspace mounted by the daemon, or select the daemon explicitly with --daemon-id.",
            ),
            1,
          );
        }
      }
      if (argv.includes("--force")) {
        const forced = await forceStopDaemon(userRoot, daemonId, pid);
        return finish(forced, forced.ok === true ? 0 : 1);
      }
      const exchange = await requestCooperativeStop(userRoot, daemonId, pid);
      writeDaemonStoppedMarker(userRoot, daemonId);
      const outcome = await waitForDaemonStop(userRoot, daemonId, pid, exchange);
      if (outcome === "stopped")
        return finish(
          {
            ok: true,
            command: "daemon-stop",
            pid,
            summary: `daemon-stop: pid ${pid} stopped; an explicit stop does not autostart.`,
            next: [{ command: "ha daemon start --service", reason: "Restart the daemon when you need it again." }],
          },
          0,
        );
      if (outcome === "draining") return finish(drainingStopReceipt(pid), 0);
      return finish(
        daemonFailure("daemon-stop", "daemon_stop_timeout", await stopTimeoutHint(userRoot, daemonId, pid, exchange)),
        1,
      );
    }
    return finish(
      daemonFailure(
        "daemon",
        "unsupported_command",
        [
          "Use daemon projection rebuild, daemon repo register|update,",
          "daemon connection add|update|remove|probe, fleet status, fleet center start, fleet edge sync|repoint,",
          "service install|uninstall|status, start --service, status [--diagnostics], metrics, top, slo, or stop.",
        ].join(" "),
      ),
      2,
    );
  } catch (error) {
    return finish(daemonFailure(controlFailureName(argv[at], command), code(error), message(error)), 1);
  }
}
function controlFailureName(domain: string | undefined, command: string | undefined): string {
  return `${domain ?? "daemon"}-${command ?? "unknown"}`;
}
async function runNodeAutoClaimControl(
  argv: readonly string[],
  commandIndex: number,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const { applyNodeAutoClaimControl, parseNodeAutoClaimControl } = await import("./node-auto-claim.ts");
  const parsed = parseNodeAutoClaimControl(argv.slice(commandIndex + 2));
  if (typeof parsed === "string") return finish(daemonFailure("daemon-auto-claim", "invalid_field", parsed), 2);
  const receipt = await applyNodeAutoClaimControl(parsed, userRoot, async (policy) => {
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    if (!(await daemonSocketProbe(endpoint))) return null;
    return await requestDaemonJsonRpcAt(
      endpoint,
      "daemon.nodeAutoClaim.configure",
      { policy: policy as unknown as JsonObject },
      75,
    );
  });
  return finish(receipt, receipt.ok === false ? 2 : 0);
}

async function maybeRunDaemonRepoControl(
  command: string | undefined,
  argv: readonly string[],
  subcommand: string | undefined,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number | undefined> {
  if (command !== "repo") return undefined;
  const { runDaemonRepoControl } = await import("./repo-control.ts");
  return await runDaemonRepoControl(argv, subcommand, userRoot, daemonId, finish);
}

async function runDaemonObserverCommand(
  command: string | undefined,
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  json: boolean,
  finish: ControlFinisher,
): Promise<number | undefined> {
  if (command === "metrics") {
    const { renderDaemonMetrics, runDaemonMetrics } = await import("./metrics.ts");
    const receipt = await runDaemonMetrics(argv, userRoot, daemonId);
    if (json) return finish(receipt, 0);
    console.log(renderDaemonMetrics(receipt));
    return 0;
  }
  if (command === "top") {
    const { parseDaemonTopOptions, runDaemonTop } = await import("./top.ts");
    return await runDaemonTop(parseDaemonTopOptions(argv, userRoot, daemonId));
  }
  if (command !== "slo") return undefined;
  const { parseDaemonSloOptions, renderDaemonSlo, runDaemonSlo } = await import("./slo.ts");
  const receipt = await runDaemonSlo(parseDaemonSloOptions(argv, userRoot, daemonId));
  console.log(json ? JSON.stringify(receipt) : renderDaemonSlo(receipt));
  return 0;
}

async function metricsValidationError(
  argv: readonly string[],
  command: string | undefined,
): Promise<Error | undefined> {
  if (command !== "metrics") return undefined;
  const { daemonMetricsArgsError } = await import("./metrics.ts");
  return daemonMetricsArgsError(argv);
}

// Only queued writes refuse a force: they are the work a forced stop destroys (2026-09-28 lost 1219
// of them). Live runtimes are not — their workers run detached and are re-adopted by pid once a
// replacement daemon takes the slot — so they must not hold the stop hostage.
// `queueDepth` is a live counter (durable actions increment it on enqueue and decrement it on
// dequeue), not a settled backlog: one sample cannot tell a write that drains on its own from a
// stuck one, and a detached worker's event append is queued and dequeued within milliseconds. Poll
// for the same stop budget a forced exit uses and refuse only what is still backed up at its end.
async function forceStopInUseRefusal(userRoot: string, daemonId: string): Promise<Record<string, unknown> | null> {
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    { stopAttempts, stopPollMs } = cliOperationalPolicy.defaultValue.daemon;
  let queuedWrites: { repoId: string; queueDepth: number }[] = [];
  for (let attempt = 0; attempt < stopAttempts; attempt += 1) {
    if (!(await daemonSocketProbe(endpoint))) return null;
    const current = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 75, 75, undefined, true);
    queuedWrites = (Array.isArray(current.repos) ? current.repos.filter(controlRecord) : []).flatMap((repo) =>
      typeof repo.repoId === "string" && typeof repo.queueDepth === "number" && repo.queueDepth > 0
        ? [{ repoId: repo.repoId, queueDepth: repo.queueDepth }]
        : [],
    );
    if (queuedWrites.length === 0) return null;
    await new Promise((resolve) => setTimeout(resolve, stopPollMs));
  }
  return {
    ...daemonFailure(
      "daemon-stop",
      "daemon_in_use",
      `The daemon has ${String(queuedWrites.reduce((total, row) => total + row.queueDepth, 0))} queued write(s); drain them before retrying --force.`,
    ),
    usage: { queuedWrites },
  };
}
function controlRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function startDaemonService(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  invokingRoot: string,
  finish: ControlFinisher,
): Promise<number> {
  if (!argv.includes("--service"))
    return finish(
      daemonFailure(
        "daemon-start",
        "service_required",
        "Use `ha daemon start --service` to start the resident daemon; other CLI commands start it on demand.",
      ),
      2,
    );
  const runtimeRefusal = runtimeDaemonStartRefusal();
  if (runtimeRefusal)
    return finish(daemonFailure("daemon-start", "daemon_start_runtime_forbidden", runtimeRefusal.hint), 1);
  clearDaemonStoppedMarker(userRoot, daemonId);
  let running: Record<string, unknown> | null = null;
  try {
    running = await status(userRoot, daemonId, argv);
  } catch (error) {
    consumeKnownError(error);
  }
  if (running?.ok === true) return finish(running, 0);
  const started = await ensureCliDaemonRunning({
    mode: "--service",
    invokingRoot,
    userRoot,
    daemonId,
    socketPath: localUserDaemonEndpoint(userRoot, daemonId),
    onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
  });
  return started.ok
    ? finish(await status(userRoot, daemonId, argv), 0)
    : finish(daemonFailure("daemon-start", started.code ?? "daemon_start_failed", started.hint), 1);
}
async function fleetStatusControl(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  // Transport and flag errors propagate to runDaemonControl's catch, which converts them
  // into the daemon-fleet failure receipt; only the read's own rejection is handled here.
  const { renderDaemonFleetStatus, runDaemonFleetStatus } = await import("./fleet-status.ts");
  const result = await runDaemonFleetStatus(argv, userRoot, daemonId);
  if (result.ok !== true) {
    const errorCode = typeof result.code === "string" ? result.code : "fleet_status_failed";
    return finish(
      daemonFailure(
        "daemon-fleet-status",
        errorCode,
        typeof result.rejectionExplanation === "string"
          ? result.rejectionExplanation
          : "The daemon rejected the fleet overview read; rerun with --json for the full receipt.",
      ),
      1,
    );
  }
  if (argv.includes("--json")) return finish(result, 0);
  console.log(renderDaemonFleetStatus(result));
  return 0;
}
async function dispatchFleetControl(
  argv: readonly string[],
  at: number,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  if (argv[at] === "fleet" && argv[at + 1] === "center") {
    const { runFleetCenterRelocationControl } = await import("./fleet-center-relocation.ts");
    return await runFleetCenterRelocationControl(argv, userRoot, finish);
  }
  return await fleetControl(argv, at, userRoot, daemonId, finish);
}
async function fleetControl(
  argv: readonly string[],
  at: number,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const { fleetCenterStartPayload } = await import("./fleet-center-relocation.ts");
  const status = argv[at + 2] === "status",
    center = argv[at + 2] === "center" && argv[at + 3] === "start",
    edge = argv[at + 2] === "edge" && argv[at + 3] === "sync",
    command = status
      ? "daemon-fleet-status"
      : center
        ? "daemon-fleet-center-start"
        : edge
          ? "daemon-fleet-edge-sync"
          : "daemon-fleet";
  const flag = (name: string) => daemonOption(argv, name),
    reject = (errorCode: string, nextAction: string) => finish(daemonFailure(command, errorCode, nextAction), 2);
  if (status) return await fleetStatusControl(argv, userRoot, daemonId, finish);
  if (argv[at + 2] === "edge" && argv[at + 3] === "repoint")
    return fleetRepointControl(argv, userRoot, daemonId, finish);
  if (!center && !edge)
    return reject(
      "unsupported_command",
      "Use daemon fleet status, daemon fleet center start, or daemon fleet edge sync.",
    );
  const byteCountFlag = "--quota-bytes";
  const required = center ? ["--port", "--repo", byteCountFlag] : [],
    missing = required.filter((name) => !flag(name));
  if (missing.length > 0)
    return reject(
      "missing_field",
      `Add ${missing.join(" ")} to ${center ? "start the fleet TLS center" : "mirror the fleet center ledger"}.`,
    );
  const centerStart = center ? fleetCenterStartPayload(argv) : null;
  if (centerStart && !("payload" in centerStart)) return reject(centerStart.code, centerStart.nextAction);
  const edgeTarget = edge
    ? await resolveLocalDaemonTarget({
        rootDir: path.resolve(flag("--root") ?? process.cwd()),
        repoIdOverride: flag("--repo"),
        registrationMode: "remote-edge",
        userRoot,
        daemonId,
      })
    : null;
  const edgeConfig = edge ? readFleetEdgeConfig(userRoot, edgeTarget!.repoId) : null;
  const edgeFlags = {
    host: "--host",
    port: "--port",
    caPath: "--ca",
    nodeId: "--node-id",
    viewRoot: "--view-root",
    quotaBytes: byteCountFlag,
  } as const;
  const edgeValue = (name: keyof typeof edgeFlags): string | number | undefined =>
    flag(edgeFlags[name]) ?? edgeConfig?.[name];
  if (edge && Object.keys(edgeFlags).some((name) => edgeValue(name as keyof typeof edgeFlags) === undefined))
    return reject("missing_field", "Add edge connection fields or populate the node fleet-edge.json.");
  if (!fleetNumber.port.test(String(edgeValue("port"))) || !fleetNumber.quota.test(String(edgeValue("quotaBytes"))))
    return reject(
      "invalid_field",
      "Use a TCP port from 0 to 65535 and a positive integer byte count for --quota-bytes.",
    );
  // The machine credential the center issued at node registration: named on the command line, or kept
  // off it in the node's fleet-edge.json.
  const credential = flag("--credential") ?? edgeConfig?.credential;
  if (edge && credential === undefined)
    return reject("missing_field", "Add --credential, or set credential in the node fleet-edge.json.");
  const edgePayload = () => ({
    host: edgeValue("host"),
    port: Number(edgeValue("port")),
    caPath: path.resolve(String(edgeValue("caPath"))),
    ...(edgeConfig?.spkiSha256 ? { spkiSha256: edgeConfig.spkiSha256 } : {}),
    nodeId: edgeValue("nodeId"),
    credential,
    repoId: edgeTarget!.repoId,
    viewRoot: path.resolve(String(edgeValue("viewRoot"))),
    quotaBytes: Number(edgeValue("quotaBytes")),
    workspaceRoot: edgeTarget!.canonicalRoot,
    ...((flag("--servername") ?? edgeConfig?.servername)
      ? { servername: flag("--servername") ?? edgeConfig?.servername }
      : {}),
    timeoutMs: flag("--timeout-ms") ? Number(flag("--timeout-ms")) : 60_000,
  });
  const payload = (centerStart ? centerStart.payload : edgePayload()) as JsonObject;
  try {
    const result = await requestDaemonJsonRpcAt(
      edgeTarget?.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
      center ? "daemon.fleet.center.start" : "daemon.fleet.edge.sync",
      { payload },
      75,
    );
    return finish(result, result.ok === true ? 0 : 1);
  } catch (error) {
    if (!isDaemonUnreachable(error)) throw error;
    return finish(
      daemonFailure(
        command,
        "daemon_unavailable",
        `Start the resident daemon with \`ha daemon start --service\`, then retry ${command.replace("daemon-", "ha daemon ").replaceAll("-", " ")}.`,
      ),
      1,
    );
  }
}
async function requestCooperativeStop(
  userRoot: string,
  daemonId: string,
  pid: number,
): Promise<DaemonShutdownExchange | null> {
  let exchange: DaemonShutdownExchange | null = null;
  try {
    const { requestDaemonShutdownAt } = await import(
      "@harness-anything/daemon/internal/client/local-json-rpc-shutdown"
    );
    exchange = await requestDaemonShutdownAt(localUserDaemonEndpoint(userRoot, daemonId), 75);
  } catch (error) {
    if (!isDaemonUnreachable(error)) throw error;
    consumeKnownError(error);
  }
  if (exchange?.stopReply && !exchange.stopReply.ok)
    throw Object.assign(new Error(exchange.stopReply.message ?? "Daemon refused stop."), {
      code: exchange.stopReply.code ?? "daemon_stop_refused",
    });
  if (exchange !== null) return exchange;
  // Only a classified unreachable transport can use the signal path. A refusal or
  // unanswered handshake must retain its error and cannot stop another release.
  signalStop(pid);
  return exchange;
}
// The old hint pointed at the lifecycle log, which is exactly the surface that stays silent when a
// stop is rejected: the daemon never heard a request it would record. This one reports what was
// observed on the way to the timeout and names the supported escalation instead.
async function stopTimeoutHint(
  userRoot: string,
  daemonId: string,
  pid: number,
  exchange: DaemonShutdownExchange | null,
): Promise<string> {
  const alive = daemonProcessAlive(pid),
    up = await daemonSocketProbe(localUserDaemonEndpoint(userRoot, daemonId));
  const reply =
    exchange?.stopReply == null
      ? exchange?.helloAnswered === true
        ? "the daemon answered protocol.hello but never answered daemon.stop (a long write may be holding it)"
        : "the daemon accepted the connection but never answered the handshake (still starting, or wedged during startup)"
      : "the daemon accepted daemon.stop but did not finish draining";
  return `Daemon pid ${pid} did not stop within 5s. Observed: process ${alive ? "alive" : "gone"}, socket ${up ? "accepting connections" : "not accepting"}, ${reply}. Run \`ha daemon stop --force\` to signal pid ${pid} directly and clear its bookkeeping.`;
}
// The supported escalation when a daemon will not drain. Signals go to exactly the pid recorded
// for this (user-root, daemon-id), never by name, and each step first re-reads the bookkeeping:
// the singleton lock (held by every recent daemon for its whole life) must not name a different
// pid, so a replacement daemon that took over the slot — or a recycled pid behind a stale pid
// file — is refused rather than signalled.
async function forceStopDaemon(userRoot: string, daemonId: string, pid: number): Promise<Record<string, unknown>> {
  const replaced = (claimed: number | null): boolean => {
    const holder = readDaemonSingletonLockPid(userRoot, daemonId);
    return (claimed !== null && claimed !== pid) || (holder !== null && holder !== pid);
  };
  if (replaced(readDaemonPid(userRoot, daemonId)))
    return daemonFailure(
      "daemon-stop",
      "daemon_replaced",
      `The daemon slot for --daemon-id ${daemonId} no longer belongs to pid ${pid} (its bookkeeping names a different pid); no signal was sent. If pid ${pid} really is a harness daemon from before singleton bookkeeping, stop it with kill ${pid}.`,
    );
  try {
    const refusal = await forceStopInUseRefusal(userRoot, daemonId);
    if (refusal) return refusal;
  } catch (error) {
    if (!isDaemonUnreachable(error) && code(error) !== "daemon_response_timeout" && code(error) !== "daemon_closed")
      throw error;
    // A daemon that cannot answer this bounded read is the R-02 escape case for force.
    consumeKnownError(error);
  }
  writeDaemonStoppedMarker(userRoot, daemonId);
  signalStop(pid);
  if (await waitProcessExit(pid, 2_000)) {
    // A daemon that shuts down cooperatively removes its own bookkeeping. A Windows SIGTERM is
    // TerminateProcess: it runs no handler, so the pid file and singleton lock outlive the process
    // and the caller has to clear them (#1565). Release only files that still name this pid, which
    // leaves the POSIX path a no-op because the daemon already removed them.
    releaseDaemonPidFile(userRoot, daemonId, pid);
    releaseDaemonSingletonLock(userRoot, daemonId, pid);
    return {
      ok: true,
      command: "daemon-stop",
      pid,
      forced: true,
      summary: `daemon-stop: pid ${pid} terminated (SIGTERM)`,
    };
  }
  if (replaced(readDaemonPid(userRoot, daemonId)))
    return daemonFailure(
      "daemon-stop",
      "daemon_replaced",
      `The daemon slot for --daemon-id ${daemonId} was retaken while stopping pid ${pid}; no SIGKILL was sent. Run ha daemon status to see the current daemon.`,
    );
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      return daemonFailure(
        "daemon-stop",
        "daemon_force_failed",
        `pid ${pid} could not be signalled: ${message(error)}`,
      );
    consumeKnownError(error);
  }
  await waitProcessExit(pid, 2_000);
  releaseDaemonPidFile(userRoot, daemonId, pid);
  releaseDaemonSingletonLock(userRoot, daemonId, pid);
  return daemonProcessAlive(pid)
    ? daemonFailure(
        "daemon-stop",
        "daemon_force_failed",
        `pid ${pid} is still alive after SIGKILL; it is not responding to signals (check its owner or state with ps -o pid,ppid,stat,command -p ${pid}).`,
      )
    : {
        ok: true,
        command: "daemon-stop",
        pid,
        forced: true,
        summary: `daemon-stop: pid ${pid} terminated (SIGKILL); pid file and singleton lock released`,
      };
}
async function waitProcessExit(pid: number, budgetMs: number): Promise<boolean> {
  // A fixed number of attempts, not a clock deadline: the budget is spent in retries and the
  // result is the process state, so no wall-clock comparison decides success.
  for (
    let attempt = 0;
    attempt < Math.max(1, Math.ceil(budgetMs / cliOperationalPolicy.defaultValue.daemon.stopPollMs));
    attempt += 1
  ) {
    if (!daemonProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, cliOperationalPolicy.defaultValue.daemon.stopPollMs));
  }
  return !daemonProcessAlive(pid);
}
// A daemon that exited between reading its pid file and being signalled is stopped, which is what
// the caller asked for. Reporting the failed signal instead would answer a question nobody asked.
function signalStop(pid: number): void {
  try {
    terminateProcess(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    consumeKnownError(error);
  }
}
// Stop is done when nothing is held any more, and there are two ways to get there. Shutdown releases
// the pid file, the endpoint and the singleton lock in one step, so the pid file alone now witnesses
// the whole release; the endpoint check it used to carry could only disagree with it while the daemon
// was draining, which is the window this predicate kept misreading. But Windows has no signals:
// process.kill terminates unconditionally, shutdown never runs, and the pid file never goes -- so a
// stop that had already succeeded reported daemon_stop_timeout for the full five seconds (#1565). A
// dead process holds nothing, so its exit is the second way, and whoever killed it clears the
// bookkeeping it left. Anything else is judged on what the daemon said: one that acknowledged the
// stop and still answers on its endpoint is draining, because a bound endpoint now outlives nothing.
type DaemonStopOutcome = OperationalStatus.DaemonStopOutcome;
async function waitForDaemonStop(
  userRoot: string,
  daemonId: string,
  pid: number,
  exchange: DaemonShutdownExchange | null,
): Promise<DaemonStopOutcome> {
  for (let attempt = 0; attempt < cliOperationalPolicy.defaultValue.daemon.stopAttempts; attempt += 1) {
    if (readDaemonPid(userRoot, daemonId) === null) return "stopped";
    if (!daemonProcessAlive(pid)) {
      releaseDaemonPidFile(userRoot, daemonId, pid);
      releaseDaemonSingletonLock(userRoot, daemonId, pid);
      return "stopped";
    }
    await new Promise((resolve) => setTimeout(resolve, cliOperationalPolicy.defaultValue.daemon.stopPollMs));
  }
  return exchange?.stopReply?.ok === true && (await daemonSocketProbe(localUserDaemonEndpoint(userRoot, daemonId)))
    ? "draining"
    : "timeout";
}
// Draining is the daemon doing what it was asked, not a failure: it accepted the stop, it is emptying
// its write queues, and it says so on an endpoint that disappears with its pid file and its lock.
function drainingStopReceipt(pid: number): Record<string, unknown> {
  return {
    ok: true,
    command: "daemon-stop",
    pid,
    draining: true,
    summary:
      `daemon-stop: pid ${pid} accepted the stop and is draining its write queues; its endpoint, ` +
      "pid file and singleton lock are released together when the drain finishes.",
    nextAction:
      "Run `ha daemon status --diagnostics` to see what is still draining; `ha daemon stop --force` ends it without draining.",
  };
}
function finishControlReceipt(
  renderReceipt: ReceiptEmitter,
  receipt: Record<string, unknown>,
  json: boolean,
  exitCode: number,
): number {
  renderReceipt(
    {
      schema: "command-receipt/v2",
      command: "daemon",
      outcome: receipt.ok === true ? "applied" : "rejected",
      ...receipt,
    },
    json,
  );
  return exitCode;
}
function code(error: unknown): string {
  const value =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "daemon_control_failed";
  return ["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(value) ? "daemon_unavailable" : value;
}
function message(error: unknown): string {
  return cliErrorMessage(error);
}
