import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint } from "../../../daemon/src/client/local-daemon-target.ts"; import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts"; import { detachedProcessOptions, terminateProcess } from "../../../daemon/src/process-port.ts"; import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { ensureLocalDaemonRunning } from "../../../daemon/src/client/daemon-autostart.ts";
import { readDaemonPid, startDaemon } from "../../../daemon/src/runtime.ts";
import { cliDaemonServeLaunch, consumeKnownError } from "./client.ts";
const fleetNumber = { port: /^(?:0|[1-9][0-9]{0,4})$/u, quota: /^[1-9][0-9]{0,15}$/u };
type ReceiptEmitter = (receipt: Record<string, unknown>, json: boolean) => void;
type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;
export async function runDaemonControl(argv: readonly string[], renderReceipt: ReceiptEmitter): Promise<number> {
  if (argv.includes("gui") && !argv.includes("daemon")) return runGuiLaunch(argv, {}, renderReceipt);
  const at = argv.indexOf("daemon"), command = argv[at + 1], subcommand = argv[at + 2];
  const json = argv.includes("--json"), userRoot = path.resolve(daemonOption(argv, "--user-root") ?? daemonUserRoot());
  const daemonId = daemonOption(argv, "--daemon-id") ?? daemonIdFromEnv(), finish: ControlFinisher = (receipt, exitCode) => finishControlReceipt(renderReceipt, receipt, json, exitCode);
  try {
    if (command === "fleet") return fleetControl(argv, at, userRoot, daemonId, finish);
    if (command === "repo" && subcommand === "register") { const root = daemonOption(argv, "--root"), repoId = daemonOption(argv, "--repo-id"), mode = daemonOption(argv, "--mode"); if (!root || !repoId) return finish(daemonFailure("daemon-repo-register", "missing_field", "Add --repo-id and --root."), 2); if (mode !== undefined && !["local", "remote-center", "remote-edge"].includes(mode)) return finish(daemonFailure("daemon-repo-register", "invalid_field", "Use --mode local, remote-center, or remote-edge."), 2); const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.register", { rootDir: path.resolve(root), repoId, ...(mode ? { mode } : {}) }, 75); return finish(result, result.ok === true ? 0 : 1); }
    if (command === "repo" && subcommand === "unregister") { const repoId = daemonOption(argv, "--repo-id"); if (!repoId) return finish(daemonFailure("daemon-repo-unregister", "missing_field", "Add --repo-id."), 2);
      const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.unregister", { repoId }, 75); return finish(result, result.ok === true ? 0 : 1); }
    if (command === "serve") return serve(userRoot, daemonId, finish);
    if (command === "start") { if (!argv.includes("--service")) return finish(daemonFailure("daemon-start", "service_required", "Use `ha daemon start --service` to start the resident daemon; other CLI commands start it on demand."), 2);
      const running = await status(userRoot, daemonId).catch(() => null); if (running?.ok === true) return finish(running, 0);
      const started = await ensureLocalDaemonRunning({ socketPath: localUserDaemonEndpoint(userRoot, daemonId), launch: () => cliDaemonServeLaunch(userRoot, daemonId) });
      return started.ok ? finish(await status(userRoot, daemonId), 0) : finish(daemonFailure("daemon-start", started.code ?? "daemon_start_failed", started.hint), 1); }
    if (command === "status") { const receipt = await status(userRoot, daemonId); return finish(receipt, 0); }
    if (command === "stop") { const pid = readDaemonPid(userRoot, daemonId); if (pid === null) return finish(daemonFailure("daemon-stop", "daemon_unavailable", "No daemon is running."), 1); terminateProcess(pid); return finish({ ok: true, command: "daemon-stop", pid }, 0); }
    return finish(daemonFailure("daemon", "unsupported_command", "Use daemon repo register|unregister, fleet center start, fleet edge sync, start --service, status, or stop."), 2);
  } catch (error) { return finish(daemonFailure(`daemon-${command ?? "unknown"}`, code(error), message(error)), 1); }
}
async function fleetControl(argv: readonly string[], at: number, userRoot: string, daemonId: string, finish: ControlFinisher): Promise<number> {
  const center = argv[at + 2] === "center" && argv[at + 3] === "start", edge = argv[at + 2] === "edge" && argv[at + 3] === "sync", command = center ? "daemon-fleet-center-start" : edge ? "daemon-fleet-edge-sync" : "daemon-fleet";
  const flag = (name: string) => daemonOption(argv, name), reject = (errorCode: string, nextAction: string) => finish(daemonFailure(command, errorCode, nextAction), 2);
  if (!center && !edge) return reject("unsupported_command", "Use daemon fleet center start or daemon fleet edge sync.");
  const required = center ? ["--port", "--key", "--cert", "--roster", "--quota-bytes"] : ["--host", "--port", "--ca", "--node-id", "--credential", "--assignment", "--view-root", "--quota-bytes"], missing = required.filter((name) => !flag(name));
  if (missing.length > 0) return reject("missing_field", `Add ${missing.join(" ")} to ${center ? "start the fleet TLS center" : "mirror the fleet center ledger"}.`);
  if (!fleetNumber.port.test(flag("--port")!) || !fleetNumber.quota.test(flag("--quota-bytes")!)) return reject("invalid_field", "Use a TCP port from 0 to 65535 and a positive integer byte count for --quota-bytes.");
  const payload = (center ? { port: Number(flag("--port")), keyPath: path.resolve(flag("--key")!), certPath: path.resolve(flag("--cert")!), rosterPath: path.resolve(flag("--roster")!), quotaBytes: Number(flag("--quota-bytes")), ...(flag("--bind") ? { bind: flag("--bind") } : {}), ...(flag("--state-root") ? { stateRoot: path.resolve(flag("--state-root")!) } : {}) } : { host: flag("--host"), port: Number(flag("--port")), caPath: path.resolve(flag("--ca")!), nodeId: flag("--node-id"), credential: flag("--credential"), assignmentId: flag("--assignment"), viewRoot: path.resolve(flag("--view-root")!), quotaBytes: Number(flag("--quota-bytes")), ...(flag("--servername") ? { servername: flag("--servername") } : {}), timeoutMs: flag("--timeout-ms") ? Number(flag("--timeout-ms")) : 60_000 }) as JsonObject;
  try { const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), center ? "daemon.fleet.center.start" : "daemon.fleet.edge.sync", { payload }, 75); return finish(result, result.ok === true ? 0 : 1); }
  catch { return finish(daemonFailure(command, "daemon_unavailable", `Start the resident daemon with \`ha daemon start --service\`, then retry ${command.replace("daemon-", "ha daemon ").replaceAll("-", " ")}.`), 1); }
}
async function serve(userRoot: string, daemonId: string, finish: ControlFinisher): Promise<number> {
  // The signal latch registers before startup: a TERM that lands during the
  // startup replay parks here and drains at the next yield instead of being
  // swallowed by synchronous work. stop() is idempotent, so a second signal
  // cannot cut the drain short.
  let daemon: Awaited<ReturnType<typeof startDaemon>>, stopping: Promise<void> | null = null, parked: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => { parked = resolve; });
  const requestStop = () => { parked?.(); stopping ??= (async () => { if (daemon && "stop" in daemon) await daemon.stop(); })(); };
  process.once("SIGTERM", requestStop); process.once("SIGINT", requestStop);
  try {
    daemon = await startDaemon({ userRoot, daemonId, shutdownRequested: () => stopping !== null });
    if (!("stop" in daemon)) return finish(deferredServeReceipt(daemon, userRoot), 0);
    if (stopping === null) { await idle; await stopping; } else await daemon.stop();
    return 0;
  } finally { process.removeListener("SIGTERM", requestStop); process.removeListener("SIGINT", requestStop); }
}
function deferredServeReceipt(incumbent: { readonly pid: number | null; readonly endpoint: string; readonly witness: string }, userRoot: string): Record<string, unknown> {
  const witness = incumbent.witness === "unix-socket" ? `a daemon is already accepting connections at ${incumbent.endpoint}` : `daemon pid ${incumbent.pid} already holds the singleton lock for --user-root ${userRoot}`;
  return { ok: true, command: "daemon-serve", outcome: "deferred", incumbent: { pid: incumbent.pid, endpoint: incumbent.endpoint }, summary: `daemon serve deferred: ${witness}; this process did not bind the socket or take any workspace writer lock.`, nextAction: "Use the resident daemon (ha daemon status) or stop it first (ha daemon stop)." };
}
async function status(userRoot: string, daemonId: string): Promise<Record<string, unknown>> { return requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.status", {}, 75) as Promise<Record<string, unknown>>; }
function daemonOption(argv: readonly string[], name: string): string | undefined { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; }
function daemonFailure(command: string, errorCode: string, nextAction: string): Record<string, unknown> { return { schema: "command-receipt/v2", ok: false,
  command, outcome: "op_rejected", opId: "N/A", origin: "cli", code: errorCode, evidence: `rejection:${errorCode}`,
  error: { code: errorCode, hint: nextAction }, nextAction }; }
function finishControlReceipt(renderReceipt: ReceiptEmitter, receipt: Record<string, unknown>, json: boolean, exitCode: number): number { renderReceipt({ schema: "command-receipt/v2", command: "daemon", outcome: receipt.ok === true ? "applied" : "rejected", ...receipt }, json); return exitCode; }
function code(error: unknown): string { const value = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_control_failed"; return ["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(value) ? "daemon_unavailable" : value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const guiRequire = createRequire(import.meta.url);
export interface GuiLaunchDependencies { readonly resolveElectronBinary?: () => string | undefined; readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess; readonly workspaceRoot?: string; }
export function runGuiLaunch(argv: readonly string[], dependencies: GuiLaunchDependencies, renderReceipt: ReceiptEmitter): number {
  const json = argv.includes("--json"), finish = (receipt: Record<string, unknown>, exitCode: number) => finishControlReceipt(renderReceipt, receipt, json, exitCode), reject = (errorCode: string, hint: string) => finish(daemonFailure("gui", errorCode, hint), 1);
  const workspaceRoot = dependencies.workspaceRoot ?? guiWorkspaceRoot();
  if (!workspaceRoot) return reject("gui_unavailable", "Run `ha gui` from a harness-anything source workspace that contains the GUI package.");
  const electronBinary = (dependencies.resolveElectronBinary ?? guiElectronBinary)();
  if (!electronBinary) return reject("electron_unavailable", "Run `node node_modules/electron/install.js` in the harness-anything workspace, then retry `ha gui`.");
  if (!existsSync(path.join(workspaceRoot, "packages/gui/dist/index.html"))) return reject("gui_dist_missing", "Run `npm run build -w @harness-anything/gui` from the harness-anything workspace, then retry `ha gui`.");
  // Electron loads the preload before the renderer, so a missing bundle opens a window whose
  // IPC bridge is silently undefined. Refuse up front rather than hand back a dead GUI.
  if (!existsSync(path.join(workspaceRoot, "packages/gui/dist-electron/electron-preload.cjs"))) return reject("gui_preload_missing", "Run `npm run build:preload -w @harness-anything/gui` from the harness-anything workspace, then retry `ha gui`.");
  try { const child = (dependencies.spawnProcess ?? spawn)(electronBinary, [path.join(workspaceRoot, "packages/gui/src/main/electron-main.ts")], { cwd: workspaceRoot, ...detachedProcessOptions, env: guiLaunchEnvironment(guiRoot(argv)) });
    // spawn reports an unusable binary asynchronously, so the catch below never sees it and a
    // detached launch cannot wait for the event. An absent pid is the synchronous witness that
    // the launch failed; the listener keeps the async ENOENT from crashing this process instead.
    child.on?.("error", consumeKnownError);
    if (child.pid === undefined) return reject("gui_launch_failed", `Electron at ${electronBinary} could not be started. Reinstall it with \`node node_modules/electron/install.js\`, then retry \`ha gui\`.`);
    child.unref(); return finish({ ok: true, command: "gui", pid: child.pid }, 0); }
  catch (error) { return reject("gui_launch_failed", `Electron could not start the GUI. Cause: ${message(error)}`); }
}
function guiElectronBinary(): string | undefined {
  // `electron` ships a stub package whose binary arrives from a postinstall download, so a
  // resolvable package is not a runnable one. Probe the executable itself to keep the two states apart.
  try { const packageRoot = path.dirname(guiRequire.resolve("electron/package.json")), relativeBinary = readFileSync(path.join(packageRoot, "path.txt"), "utf8").trim();
    if (!relativeBinary) return undefined;
    const candidate = path.resolve(packageRoot, "dist", relativeBinary); accessSync(candidate, constants.F_OK | constants.X_OK); return candidate; }
  catch (error) { consumeKnownError(error); return undefined; }
}
function guiWorkspaceRoot(): string | undefined {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) { if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "packages/gui/src/main/electron-main.ts"))) return current;
    const parent = path.dirname(current); if (parent === current) return undefined; current = parent; }
}
function guiRoot(argv: readonly string[]): string { const supplied = daemonOption(argv, "--root"); return path.resolve(supplied && !supplied.startsWith("-") ? supplied : process.cwd()); }
function guiLaunchEnvironment(rootDir: string): NodeJS.ProcessEnv {
  // A packaged launch must never inherit the dev loop's renderer origin or node-mode flag.
  const environment: NodeJS.ProcessEnv = { ...process.env, HARNESS_GUI_ROOT: rootDir };
  delete environment.ELECTRON_RENDERER_URL; delete environment.ELECTRON_RUN_AS_NODE; return environment;
}
