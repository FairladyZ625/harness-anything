import net from "node:net";
import { startDetachedProcessChecked } from "../process-port.ts";
export interface DaemonLaunchSpec { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }
export type DaemonAutostartFailureCode = "daemon_spawn_not_found" | "daemon_spawn_permission" | "daemon_start_failed" | "daemon_bind_timeout";
export interface DaemonAutostartResult { readonly ok: boolean; readonly code?: DaemonAutostartFailureCode; readonly hint: string; readonly attempts: number }
export class DaemonAutostartError extends Error { readonly code: DaemonAutostartFailureCode; readonly attempts: number;
  constructor(result: DaemonAutostartResult) { super(result.hint); this.name = "DaemonAutostartError"; this.code = result.code ?? "daemon_start_failed"; this.attempts = result.attempts; } }
export function isDaemonUnreachable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) { const code = (error as { readonly code?: unknown }).code; if (typeof code === "string") return code === "ECONNREFUSED" || code === "ENOENT" || code === "ETIMEDOUT"; }
  return error instanceof Error && error.message === "daemon_unavailable";
}
export async function ensureLocalDaemonRunning(input: { readonly socketPath: string; readonly launch: () => DaemonLaunchSpec; readonly maxAttempts?: number;
  readonly readyTimeoutMs?: number; readonly retryDelayMs?: number; readonly probeIntervalMs?: number; readonly probe?: (socketPath: string) => Promise<boolean>;
  readonly spawnDetached?: (launch: DaemonLaunchSpec) => Promise<void> }): Promise<DaemonAutostartResult> {
  const maxAttempts = input.maxAttempts ?? 2, readyTimeoutMs = input.readyTimeoutMs ?? 10_000, retryDelayMs = input.retryDelayMs ?? 500, probeIntervalMs = input.probeIntervalMs ?? 50;
  const probe = input.probe ?? daemonSocketProbe, spawnDetached = input.spawnDetached ?? ((launch: DaemonLaunchSpec) => startDetachedProcessChecked(launch.command, launch.args, launch.env));
  // A freshly started daemon can die between binding its socket and finishing
  // startup; confirm readiness with a second probe before declaring success.
  const ready = async () => { if (!await probe(input.socketPath)) return false; await delay(probeIntervalMs); return probe(input.socketPath); };
  let launched: DaemonLaunchSpec | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await ready()) return { ok: true, hint: "daemon is reachable", attempts: attempt };
    try { launched = input.launch(); await spawnDetached(launched); }
    catch (error) { return { ok: false, attempts: attempt, ...classifySpawnFailure(error, launched) }; }
    for (const deadline = Date.now() + readyTimeoutMs; Date.now() < deadline;) { if (await ready()) return { ok: true, hint: "daemon is reachable", attempts: attempt }; await delay(probeIntervalMs); }
    if (attempt < maxAttempts) await delay(retryDelayMs);
  }
  return { ok: false, code: "daemon_bind_timeout", attempts: maxAttempts, hint: `The daemon did not accept connections at ${input.socketPath} within ${readyTimeoutMs}ms per attempt after ${maxAttempts} start attempts. Run this command directly to see the daemon's own error output: ${launched ? `${launched.command} ${launched.args.join(" ")}` : "the daemon launcher"}.` };
}
export async function daemonSocketProbe(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => { const socket = net.createConnection(socketPath), finish = (up: boolean) => { socket.destroy(); resolve(up); }; const timer = setTimeout(() => finish(false), 250);
    socket.once("connect", () => { clearTimeout(timer); finish(true); }); socket.once("error", () => { clearTimeout(timer); finish(false); }); });
}
function classifySpawnFailure(error: unknown, launch: DaemonLaunchSpec | null): { readonly code: DaemonAutostartFailureCode; readonly hint: string } {
  const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null;
  const detail = error instanceof Error ? error.message : String(error), command = launch ? `${launch.command} ${launch.args.join(" ")}` : "the daemon launcher";
  if (code === "ENOENT") return { code: "daemon_spawn_not_found", hint: `Starting the daemon failed because the launcher binary was not found (ENOENT): ${detail}. Command: ${command}.` };
  if (code === "EACCES" || code === "EPERM") return { code: "daemon_spawn_permission", hint: `Starting the daemon failed because permission was denied (${code}): ${detail}. Command: ${command}.` };
  return { code: "daemon_start_failed", hint: `Starting the daemon failed: ${detail}. Command: ${command}.` };
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
