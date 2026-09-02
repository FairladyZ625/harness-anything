import { existsSync } from "node:fs";
import path from "node:path";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "../../../daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import type { DaemonShutdownExchange } from "../../../daemon/src/client/local-json-rpc-shutdown.ts";
import { terminateProcess } from "../../../daemon/src/process-port.ts";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeDaemonStartRefusal } from "../../../daemon/src/client/daemon-autostart.ts";
import { readDaemonPid, startDaemon } from "../../../daemon/src/runtime.ts";
import {
  daemonProcessAlive,
  daemonSocketProbe,
  readDaemonSingletonLockPid,
  releaseDaemonPidFile,
  releaseDaemonSingletonLock,
} from "../../../daemon/src/daemon-singleton.ts";
import { daemonBuildStamp } from "../../../daemon/src/build-identity.ts";
import { cliErrorMessage } from "../cli-error.ts";
import { consumeKnownError } from "./client.ts";
import { ensureCliDaemonRunning } from "./autostart.ts";
import { firstCliCommandIndex } from "../cli/thin-command.ts";
import { runGuiLaunch } from "../cli/gui-launch.ts";
import { runDaemonConnectionControl } from "./connection-control.ts";
import { daemonFailure, daemonOption } from "./control-support.ts";
import { runDaemonRepoControl } from "./repo-control.ts";
const fleetNumber = { port: /^(?:0|[1-9][0-9]{0,4})$/u, quota: /^[1-9][0-9]{0,15}$/u };
type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;
export async function runDaemonControl(argv: readonly string[], renderReceipt: ReceiptEmitter): Promise<number> {
  const at = firstCliCommandIndex(argv);
  if (argv[at] === "gui") return runGuiLaunch(argv, {}, renderReceipt);
  const command = argv[at + 1],
    subcommand = argv[at + 2];
  const json = argv.includes("--json"),
    userRoot = path.resolve(daemonOption(argv, "--user-root") ?? daemonUserRoot()),
    invokingRoot = path.resolve(daemonOption(argv, "--root") ?? process.cwd());
  const daemonId = daemonOption(argv, "--daemon-id") ?? daemonIdFromEnv(),
    finish: ControlFinisher = (receipt, exitCode) => finishControlReceipt(renderReceipt, receipt, json, exitCode);
  try {
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
    if (command === "fleet") return fleetControl(argv, at, userRoot, daemonId, finish);
    if (command === "repo") {
      const result = await runDaemonRepoControl(argv, subcommand, userRoot, daemonId, finish);
      if (result !== undefined) return result;
    }
    if (command === "connection") return runDaemonConnectionControl(argv, subcommand, userRoot, daemonId, finish);
    if (command === "serve") {
      const refusal = runtimeDaemonStartRefusal();
      if (refusal) return finish(daemonFailure("daemon-serve", "daemon_start_runtime_forbidden", refusal.hint), 1);
      return serve(userRoot, daemonId, finish);
    }
    if (command === "start") return startDaemonService(argv, userRoot, daemonId, invokingRoot, finish);
    if (command === "status") return finish(await status(userRoot, daemonId, argv), 0);
    if (command === "stop") {
      const pid = readDaemonPid(userRoot, daemonId);
      if (pid === null) return finish(daemonFailure("daemon-stop", "daemon_unavailable", "No daemon is running."), 1);
      if (argv.includes("--force")) {
        const forced = await forceStopDaemon(userRoot, daemonId, pid);
        return finish(forced, forced.ok === true ? 0 : 1);
      }
      const exchange = await requestCooperativeStop(userRoot, daemonId, pid);
      const stopped = await waitForDaemonStop(userRoot, daemonId, pid);
      return stopped
        ? finish({ ok: true, command: "daemon-stop", pid }, 0)
        : finish(
            daemonFailure(
              "daemon-stop",
              "daemon_stop_timeout",
              await stopTimeoutHint(userRoot, daemonId, pid, exchange),
            ),
            1,
          );
    }
    return finish(
      daemonFailure(
        "daemon",
        "unsupported_command",
        [
          "Use daemon projection rebuild, daemon repo register|update|unregister,",
          "daemon connection add|update|remove|probe, fleet center start, fleet edge sync,",
          "start --service, status, or stop.",
        ].join(" "),
      ),
      2,
    );
  } catch (error) {
    return finish(daemonFailure(`daemon-${command ?? "unknown"}`, code(error), message(error)), 1);
  }
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
  let running: Record<string, unknown> | null = null;
  try {
    running = await status(userRoot, daemonId, argv);
  } catch (error) {
    consumeKnownError(error);
  }
  if (running?.ok === true) return finish(running, 0);
  const runtimeRefusal = runtimeDaemonStartRefusal();
  if (runtimeRefusal)
    return finish(daemonFailure("daemon-start", "daemon_start_runtime_forbidden", runtimeRefusal.hint), 1);
  const started = await ensureCliDaemonRunning({
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
async function fleetControl(
  argv: readonly string[],
  at: number,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const center = argv[at + 2] === "center" && argv[at + 3] === "start",
    edge = argv[at + 2] === "edge" && argv[at + 3] === "sync",
    command = center ? "daemon-fleet-center-start" : edge ? "daemon-fleet-edge-sync" : "daemon-fleet";
  const flag = (name: string) => daemonOption(argv, name),
    reject = (errorCode: string, nextAction: string) => finish(daemonFailure(command, errorCode, nextAction), 2);
  if (!center && !edge)
    return reject("unsupported_command", "Use daemon fleet center start or daemon fleet edge sync.");
  const required = center
      ? ["--port", "--key", "--cert", "--roster", "--quota-bytes"]
      : ["--host", "--port", "--ca", "--node-id", "--assignment", "--view-root", "--quota-bytes"],
    missing = required.filter((name) => !flag(name));
  if (missing.length > 0)
    return reject(
      "missing_field",
      `Add ${missing.join(" ")} to ${center ? "start the fleet TLS center" : "mirror the fleet center ledger"}.`,
    );
  const credential = flag("--credential"),
    roster = flag("--roster");
  if (edge && (credential === undefined) === (roster === undefined))
    return reject("invalid_field", "Use exactly one of --credential or --roster for edge sync.");
  if (!fleetNumber.port.test(flag("--port")!) || !fleetNumber.quota.test(flag("--quota-bytes")!))
    return reject(
      "invalid_field",
      "Use a TCP port from 0 to 65535 and a positive integer byte count for --quota-bytes.",
    );
  const edgeTarget = edge
    ? await resolveLocalDaemonTarget({
        rootDir: path.resolve(flag("--root") ?? process.cwd()),
        repoIdOverride: flag("--repo"),
        userRoot,
        daemonId,
      })
    : null;
  const centerPayload = () => ({
    port: Number(flag("--port")),
    keyPath: path.resolve(flag("--key")!),
    certPath: path.resolve(flag("--cert")!),
    rosterPath: path.resolve(flag("--roster")!),
    quotaBytes: Number(flag("--quota-bytes")),
    ...(flag("--bind") ? { bind: flag("--bind") } : {}),
    ...(flag("--state-root") ? { stateRoot: path.resolve(flag("--state-root")!) } : {}),
  });
  const edgePayload = () => ({
    host: flag("--host"),
    port: Number(flag("--port")),
    caPath: path.resolve(flag("--ca")!),
    nodeId: flag("--node-id"),
    ...(credential ? { credential } : {}),
    ...(roster ? { rosterPath: path.resolve(roster) } : {}),
    assignmentId: flag("--assignment"),
    repoId: edgeTarget!.repoId,
    viewRoot: path.resolve(flag("--view-root")!),
    quotaBytes: Number(flag("--quota-bytes")),
    workspaceRoot: edgeTarget!.canonicalRoot,
    ...(flag("--servername") ? { servername: flag("--servername") } : {}),
    timeoutMs: flag("--timeout-ms") ? Number(flag("--timeout-ms")) : 60_000,
  });
  const payload = (center ? centerPayload() : edgePayload()) as JsonObject;
  try {
    const result = await requestDaemonJsonRpcAt(
      edgeTarget?.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
      center ? "daemon.fleet.center.start" : "daemon.fleet.edge.sync",
      { payload },
      75,
    );
    return finish(result, result.ok === true ? 0 : 1);
  } catch {
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
async function serve(userRoot: string, daemonId: string, finish: ControlFinisher): Promise<number> {
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
    summary: `daemon serve deferred: ${witness}; this process did not bind the socket or take any workspace writer lock.`,
    nextAction: "Use the resident daemon (ha daemon status) or stop it first (ha daemon stop).",
  };
}
async function status(
  userRoot: string,
  daemonId: string,
  argv: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const root = path.resolve(daemonOption(argv, "--root") ?? process.cwd()),
    repoIdOverride = daemonOption(argv, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID;
  // Same resolver as every command: canonicalised registry match, and the injected-endpoint conflict check fails closed here too.
  let resolved: Awaited<ReturnType<typeof resolveLocalDaemonTarget>> | null;
  try {
    resolved = await resolveLocalDaemonTarget({ rootDir: root, repoIdOverride, userRoot, daemonId });
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "daemon_target_conflict") throw error;
    consumeKnownError(error);
    resolved = null;
  }
  const endpoint = resolved?.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
    result = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 75, undefined, undefined, true);
  const target = {
      endpoint,
      daemonId,
      userRoot,
      repoId: resolved?.repoId ?? null,
      canonicalRoot: resolved?.canonicalRoot ?? null,
    },
    detail = `target: endpoint=${endpoint} daemonId=${daemonId} userRoot=${userRoot} repoId=${target.repoId ?? "none"} canonicalRoot=${target.canonicalRoot ?? "none"}`;
  return { ...result, target, summary: `${String(result.summary ?? "daemon status")}\n${detail}` };
}
async function requestCooperativeStop(
  userRoot: string,
  daemonId: string,
  pid: number,
): Promise<DaemonShutdownExchange | null> {
  let exchange: DaemonShutdownExchange | null = null;
  try {
    const { requestDaemonShutdownAt } = await import("../../../daemon/src/client/local-json-rpc-shutdown.ts");
    exchange = await requestDaemonShutdownAt(localUserDaemonEndpoint(userRoot, daemonId), 75);
  } catch (error) {
    consumeKnownError(error);
  }
  if (exchange !== null && (exchange.stopReply === null || exchange.stopReply.ok)) return exchange;
  // Two daemons end up here: one that never reached socket bind, and one that answered "no" — a
  // build without daemon.stop, or a composition without a shutdown owner. Both cannot act on the
  // RPC, so the signal ladder takes over; serve() drains SIGTERM through the same cooperative
  // latch as an RPC stop. A daemon that stayed silent keeps its queued shutdown and is left to drain.
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
      : exchange.stopReply.ok
        ? "the daemon accepted daemon.stop but did not finish draining"
        : `the daemon rejected daemon.stop (${exchange.stopReply.code ?? "unknown"}${exchange.stopReply.message ? `: ${exchange.stopReply.message}` : ""}) and SIGTERM was sent as the fallback`;
  return `Daemon pid ${pid} did not stop within 5s. Observed: process ${alive ? "alive" : "gone"}, socket ${up ? "accepting connections" : "not accepting"}, ${reply}${daemonSkewNote(exchange?.daemonCommit ?? null)}. Run \`ha daemon stop --force\` to signal pid ${pid} directly and clear its bookkeeping.`;
}
// Skew is the diagnosis, not something to paper over: a daemon serving an older commit is the
// standing explanation for a rejected stop, and it stays stale until restarted.
function daemonSkewNote(daemonCommit: string | null): string {
  const own = daemonBuildStamp().commit;
  return daemonCommit !== null && own !== null && daemonCommit !== own
    ? `; the daemon is serving code from commit ${daemonCommit.slice(0, 12)} while this CLI is ${own.slice(0, 12)} — it is running older code`
    : "";
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
  signalStop(pid);
  if (await waitProcessExit(pid, 2_000))
    return {
      ok: true,
      command: "daemon-stop",
      pid,
      forced: true,
      summary: `daemon-stop: pid ${pid} terminated (SIGTERM)`,
    };
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
  for (const deadline = Date.now() + budgetMs; daemonProcessAlive(pid) && Date.now() < deadline; )
    await new Promise((resolve) => setTimeout(resolve, 10));
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
// Stop is done when nothing is held any more, and there are two ways to get there. Shutdown
// releases the pid file and the endpoint as its last acts, which is the fast path and the only
// one the original predicate knew. But Windows has no signals: process.kill terminates
// unconditionally, shutdown never runs, and those two never go -- so a stop that had already
// succeeded reported daemon_stop_timeout for the full five seconds (#1565). A dead process holds
// nothing, so its exit is the second way, and whoever killed it clears the bookkeeping it left.
async function waitForDaemonStop(userRoot: string, daemonId: string, pid: number): Promise<boolean> {
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
    if (readDaemonPid(userRoot, daemonId) === null && !existsSync(endpoint)) return true;
    if (!daemonProcessAlive(pid)) {
      releaseDaemonPidFile(userRoot, daemonId, pid);
      releaseDaemonSingletonLock(userRoot, daemonId, pid);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
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
