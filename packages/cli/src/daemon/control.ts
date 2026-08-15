import path from "node:path";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint } from "../../../daemon/src/client/local-daemon-target.ts"; import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts"; import { terminateProcess } from "../../../daemon/src/process-port.ts"; import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { ensureLocalDaemonRunning } from "../../../daemon/src/client/daemon-autostart.ts";
import { readDaemonPid, startDaemon } from "../../../daemon/src/runtime.ts";
import { cliDaemonServeLaunch } from "./client.ts";
const fleetNumber = { port: /^(?:0|[1-9][0-9]{0,4})$/u, quota: /^[1-9][0-9]{0,15}$/u };
export async function runDaemonControl(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("daemon"), command = argv[at + 1], subcommand = argv[at + 2];
  const json = argv.includes("--json"), userRoot = path.resolve(daemonOption(argv, "--user-root") ?? daemonUserRoot());
  const daemonId = daemonOption(argv, "--daemon-id") ?? daemonIdFromEnv();
  try {
    if (command === "fleet") return fleetControl(argv, at, userRoot, daemonId, json);
    if (command === "repo" && subcommand === "register") { const root = daemonOption(argv, "--root"), repoId = daemonOption(argv, "--repo-id"); if (!root || !repoId) return emitDaemonReceipt(daemonFailure("daemon-repo-register", "missing_field", "Add --repo-id and --root."), json, 2); const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.register", { rootDir: path.resolve(root), repoId }, 75); return emitDaemonReceipt(result, json, result.ok === true ? 0 : 1); }
    if (command === "repo" && subcommand === "unregister") { const repoId = daemonOption(argv, "--repo-id"); if (!repoId) return emitDaemonReceipt(daemonFailure("daemon-repo-unregister", "missing_field", "Add --repo-id."), json, 2);
      const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.unregister", { repoId }, 75); return emitDaemonReceipt(result, json, result.ok === true ? 0 : 1); }
    if (command === "serve") return serve(userRoot, daemonId);
    if (command === "start") { if (!argv.includes("--service")) return emitDaemonReceipt(daemonFailure("daemon-start", "service_required", "Use `ha daemon start --service` to start the resident daemon; other CLI commands start it on demand."), json, 2);
      const running = await status(userRoot, daemonId).catch(() => null); if (running?.ok === true) return emitDaemonReceipt(running, json, 0);
      const started = await ensureLocalDaemonRunning({ socketPath: localUserDaemonEndpoint(userRoot, daemonId), launch: () => cliDaemonServeLaunch(userRoot, daemonId) });
      return started.ok ? emitDaemonReceipt(await status(userRoot, daemonId), json, 0) : emitDaemonReceipt(daemonFailure("daemon-start", started.code ?? "daemon_start_failed", started.hint), json, 1); }
    if (command === "status") { const receipt = await status(userRoot, daemonId); return emitDaemonReceipt(receipt, json, 0); }
    if (command === "stop") { const pid = readDaemonPid(userRoot, daemonId); if (pid === null) return emitDaemonReceipt(daemonFailure("daemon-stop", "daemon_unavailable", "No daemon is running."), json, 1); terminateProcess(pid); return emitDaemonReceipt({ ok: true, command: "daemon-stop", pid }, json, 0); }
    return emitDaemonReceipt(daemonFailure("daemon", "unsupported_command", "Use daemon repo register|unregister, fleet center start, fleet edge sync, start --service, status, or stop."), json, 2);
  } catch (error) { return emitDaemonReceipt(daemonFailure(`daemon-${command ?? "unknown"}`, code(error), message(error)), json, 1); }
}
async function fleetControl(argv: readonly string[], at: number, userRoot: string, daemonId: string, json: boolean): Promise<number> {
  const center = argv[at + 2] === "center" && argv[at + 3] === "start", edge = argv[at + 2] === "edge" && argv[at + 3] === "sync", command = center ? "daemon-fleet-center-start" : edge ? "daemon-fleet-edge-sync" : "daemon-fleet";
  const flag = (name: string) => daemonOption(argv, name), reject = (errorCode: string, nextAction: string) => emitDaemonReceipt(daemonFailure(command, errorCode, nextAction), json, 2);
  if (!center && !edge) return reject("unsupported_command", "Use daemon fleet center start or daemon fleet edge sync.");
  const required = center ? ["--port", "--key", "--cert", "--roster", "--quota-bytes"] : ["--host", "--port", "--ca", "--node-id", "--credential", "--assignment", "--view-root", "--quota-bytes"], missing = required.filter((name) => !flag(name));
  if (missing.length > 0) return reject("missing_field", `Add ${missing.join(" ")} to ${center ? "start the fleet TLS center" : "mirror the fleet center ledger"}.`);
  if (!fleetNumber.port.test(flag("--port")!) || !fleetNumber.quota.test(flag("--quota-bytes")!)) return reject("invalid_field", "Use a TCP port from 0 to 65535 and a positive integer byte count for --quota-bytes.");
  const payload = (center ? { port: Number(flag("--port")), keyPath: path.resolve(flag("--key")!), certPath: path.resolve(flag("--cert")!), rosterPath: path.resolve(flag("--roster")!), quotaBytes: Number(flag("--quota-bytes")), ...(flag("--bind") ? { bind: flag("--bind") } : {}), ...(flag("--state-root") ? { stateRoot: path.resolve(flag("--state-root")!) } : {}) } : { host: flag("--host"), port: Number(flag("--port")), caPath: path.resolve(flag("--ca")!), nodeId: flag("--node-id"), credential: flag("--credential"), assignmentId: flag("--assignment"), viewRoot: path.resolve(flag("--view-root")!), quotaBytes: Number(flag("--quota-bytes")), ...(flag("--servername") ? { servername: flag("--servername") } : {}), timeoutMs: flag("--timeout-ms") ? Number(flag("--timeout-ms")) : 60_000 }) as JsonObject;
  try { const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), center ? "daemon.fleet.center.start" : "daemon.fleet.edge.sync", { payload }, 75); return emitDaemonReceipt(result, json, result.ok === true ? 0 : 1); }
  catch { return emitDaemonReceipt(daemonFailure(command, "daemon_unavailable", `Start the resident daemon with \`ha daemon start --service\`, then retry ${command.replace("daemon-", "ha daemon ").replaceAll("-", " ")}.`), json, 1); }
}
async function serve(userRoot: string, daemonId: string): Promise<number> { const running = await startDaemon({ userRoot, daemonId }); await new Promise<void>((resolve) => { const stop = () => void running.stop().finally(resolve); process.once("SIGTERM", stop); process.once("SIGINT", stop); }); return 0; }
async function status(userRoot: string, daemonId: string): Promise<Record<string, unknown>> { return requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.status", {}, 75) as Promise<Record<string, unknown>>; }
function daemonOption(argv: readonly string[], name: string): string | undefined { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; }
function daemonFailure(command: string, errorCode: string, nextAction: string): Record<string, unknown> { return { schema: "command-receipt/v2", ok: false,
  command, outcome: "rejected", opId: "N/A", origin: "cli", code: errorCode, evidence: `rejection:${errorCode}`,
  error: { code: errorCode, hint: nextAction }, nextAction }; }
function emitDaemonReceipt(receipt: Record<string, unknown>, json: boolean, exitCode: number): number { const output = { schema: "command-receipt/v2", command: "daemon", outcome: receipt.ok === true ? "applied" : "rejected", ...receipt }; if (json) console.log(JSON.stringify(output));
  else if (receipt.ok === true) console.log(String(receipt.command ?? "daemon")); else console.error(`error code=${String((receipt.error as { code?: unknown })?.code)} hint=${String(receipt.nextAction)}`); return exitCode; }
function code(error: unknown): string { const value = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_control_failed"; return ["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(value) ? "daemon_unavailable" : value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
