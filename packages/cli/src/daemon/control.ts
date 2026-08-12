import { realpathSync } from "node:fs";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint } from "../../../daemon/src/client/local-daemon-target.ts"; import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts"; import { startDetachedProcess, terminateProcess } from "../../../daemon/src/process-port.ts";
import { daemonPidPath, readDaemonPid, startDaemon } from "../../../daemon/src/runtime.ts";
export async function runDaemonControl(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("daemon"), command = argv[at + 1], subcommand = argv[at + 2];
  const json = argv.includes("--json"), userRoot = path.resolve(daemonOption(argv, "--user-root") ?? daemonUserRoot());
  const daemonId = daemonOption(argv, "--daemon-id") ?? daemonIdFromEnv();
  try {
    if (command === "repo" && subcommand === "register") { const root = daemonOption(argv, "--root"), repoId = daemonOption(argv, "--repo-id"); if (!root || !repoId) return emitDaemonReceipt(daemonFailure("daemon-repo-register", "missing_field", "Add --repo-id and --root."), json, 2); const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.register", { rootDir: path.resolve(root), repoId }, 75); return emitDaemonReceipt(result, json, result.ok === true ? 0 : 1); }
    if (command === "repo" && subcommand === "unregister") { const repoId = daemonOption(argv, "--repo-id"); if (!repoId) return emitDaemonReceipt(daemonFailure("daemon-repo-unregister", "missing_field", "Add --repo-id."), json, 2);
      const result = await requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.repo.unregister", { repoId }, 75); return emitDaemonReceipt(result, json, result.ok === true ? 0 : 1); }
    if (command === "serve") return serve(userRoot, daemonId);
    if (command === "start") { if (!argv.includes("--service")) return emitDaemonReceipt(daemonFailure("daemon-start", "service_required", "Use explicit `ha daemon start --service`."), json, 2);
      const running = await status(userRoot, daemonId).catch(() => null); if (running?.ok === true) return emitDaemonReceipt(running, json, 0); const entry = realpathSync(fileURLToPath(new URL(import.meta.url.endsWith(".js") ? "../index.js" : "../index.ts", import.meta.url)));
      startDetachedProcess(process.execPath, [entry, "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId], process.env); const receipt = await waitForStatus(userRoot, daemonId); return emitDaemonReceipt(receipt, json, receipt.ok === true ? 0 : 1); }
    if (command === "status") { const receipt = await status(userRoot, daemonId); return emitDaemonReceipt(receipt, json, 0); }
    if (command === "stop") { const pid = readDaemonPid(userRoot, daemonId); if (pid === null) return emitDaemonReceipt(daemonFailure("daemon-stop", "daemon_unavailable", "No explicit daemon is running."), json, 1); terminateProcess(pid); return emitDaemonReceipt({ ok: true, command: "daemon-stop", pid }, json, 0); }
    return emitDaemonReceipt(daemonFailure("daemon", "unsupported_command", "Use daemon repo register|unregister, start --service, status, or stop."), json, 2);
  } catch (error) { return emitDaemonReceipt(daemonFailure(`daemon-${command ?? "unknown"}`, code(error), message(error)), json, 1); }
}
async function serve(userRoot: string, daemonId: string): Promise<number> { const running = await startDaemon({ userRoot, daemonId }); await new Promise<void>((resolve) => { const stop = () => void running.stop().finally(resolve); process.once("SIGTERM", stop); process.once("SIGINT", stop); }); return 0; }
async function status(userRoot: string, daemonId: string): Promise<Record<string, unknown>> { return requestDaemonJsonRpcAt(localUserDaemonEndpoint(userRoot, daemonId), "daemon.status", {}, 75) as Promise<Record<string, unknown>>; }
async function waitForStatus(userRoot: string, daemonId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) { try { return await status(userRoot, daemonId); } catch (error) { consumeKnownError(error); await delay(20); } }
  return daemonFailure("daemon-start", "daemon_unavailable", `Daemon did not bind ${localUserDaemonEndpoint(userRoot, daemonId)}; inspect ${daemonPidPath(userRoot, daemonId)}.`);
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function daemonOption(argv: readonly string[], name: string): string | undefined { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; }
function daemonFailure(command: string, errorCode: string, nextAction: string): Record<string, unknown> { return { schema: "command-receipt/v2", ok: false,
  command, outcome: "rejected", opId: "N/A", origin: "cli", code: errorCode, evidence: `rejection:${errorCode}`,
  error: { code: errorCode, hint: nextAction }, nextAction }; }
function emitDaemonReceipt(receipt: Record<string, unknown>, json: boolean, exitCode: number): number { const output = { schema: "command-receipt/v2", command: "daemon", outcome: receipt.ok === true ? "applied" : "rejected", ...receipt }; if (json) console.log(JSON.stringify(output));
  else if (receipt.ok === true) console.log(String(receipt.command ?? "daemon")); else console.error(`error code=${String((receipt.error as { code?: unknown })?.code)} hint=${String(receipt.nextAction)}`); return exitCode; }
function code(error: unknown): string { const value = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "daemon_control_failed"; return ["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(value) ? "daemon_unavailable" : value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function consumeKnownError(error: unknown): void { void error; }
