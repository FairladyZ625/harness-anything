import { realpathSync } from "node:fs"; import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts"; import { canonicalRoot, workspaceId } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget,
  type LocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
export type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";

const autostartFailureCodes = ["daemon_spawn_not_found", "daemon_spawn_permission", "daemon_start_failed", "daemon_bind_timeout"] as const;
export function daemonServeEntry(): string { return realpathSync(fileURLToPath(new URL(import.meta.url.endsWith(".js") ? "../index.js" : "../index.ts", import.meta.url))); }
export function cliDaemonServeLaunch(userRoot: string, daemonId: string, execPath = process.execPath): DaemonLaunchSpec {
  return { command: execPath, args: [daemonServeEntry(), "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId], env: process.env };
}
export function daemonAutostartFailureCode(error: unknown): string | null { const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null; return code !== null && (autostartFailureCodes as readonly string[]).includes(code) ? code : null; }
// The autostart seam is imported lazily so the thin dist static import graph stays
// entry/parser/transport-only; it is only reachable on a connection-level failure.
async function withAutostart(request: () => Promise<JsonObject>, launch: () => DaemonLaunchSpec, socketPath: string, autostart: boolean): Promise<JsonObject> {
  try { return await request(); }
  catch (error) {
    if (!autostart) throw error;
    const { DaemonAutostartError, ensureLocalDaemonRunning, isDaemonUnreachable } = await import("../../../daemon/src/client/daemon-autostart.ts");
    if (!isDaemonUnreachable(error)) throw error;
    const started = await ensureLocalDaemonRunning({ socketPath, launch });
    if (!started.ok) throw new DaemonAutostartError(started);
    return await request();
  }
}
export async function runCommandThroughDaemon(command: ThinCommand, onPhase: (receipt: JsonObject) => void = () => undefined, options: { readonly autostart?: boolean } = {}): Promise<JsonObject> {
  const { requestLocalDaemonJsonRpcForTarget } = await import("../../../daemon/src/client/local-json-rpc-client.ts"), autostart = options.autostart !== false;
  if (command.action.kind === "repo-bootstrap") { const userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv(), { kind: _kind, ...params } = command.action, socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ repoId: workspaceId("bootstrap"),
    canonicalRoot: canonicalRoot(command.rootDir, true), userRoot, daemonId, socketPath }, "daemon.repo.bootstrap", { rootDir: command.rootDir, ...params }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  if (command.method.startsWith("daemon.runtimeInstance.")) { const userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv(), { kind: _kind, ...payload } = command.action, socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ userRoot, daemonId, socketPath }, command.method, { payload: payload as JsonObject }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId });
  const { kind: _kind, ...actionPayload } = command.action, payload = command.method === "repo.script.run" ? Object.fromEntries(Object.entries(actionPayload).filter(([field, value]) => field !== "schema" && (field !== "taskId" || value !== null))) : actionPayload, executor = declaredExecutor();
  const requestPayload = command.method === "repo.task.run" ? { action: executor ? { ...command.action, executor } : command.action } : executor ? { ...payload, executor } : payload;
  let result = await withAutostart(() => requestLocalDaemonJsonRpcForTarget(target, command.method, { repo: { repoId: target.repoId }, payload: requestPayload as JsonObject }, 75), () => cliDaemonServeLaunch(target.userRoot, target.daemonId), target.socketPath, autostart);
  if (command.action.kind !== "preset-run-start") return result; let observed = 0;
  for (;;) { const phases = Array.isArray(result.phases) ? result.phases.filter((phase): phase is string => typeof phase === "string") : []; for (const phase of phases.slice(observed)) onPhase({ ...result, ok: !["rejected", "failed", "outcome_unknown"].includes(phase), command: "preset-run-start", summary: `preset-run-start: ${phase}` }); observed = phases.length; if (["applied", "rejected", "failed", "outcome_unknown"].includes(String(result.outcome))) { const ok = result.outcome === "applied"; return { ...result, ok, command: "preset-run-start", summary: `preset-run-start: ${String(result.phase)}`, ...(!ok ? { error: { code: result.code ?? "preset_run_failed", hint: result.nextAction ?? "Inspect the run receipt." } } : {}) }; } await new Promise((resolve) => setTimeout(resolve, 20)); try { result = await requestLocalDaemonJsonRpcForTarget(target, "repo.preset.run.status", { repo: { repoId: target.repoId }, payload: { runId: result.runId } }, 75); } catch (error) { consumeKnownError(error); result = { ...result, outcome: "outcome_unknown", phase: "outcome_unknown", phases: [...phases, "outcome_unknown"], code: "daemon_disconnect", nextAction: "Reconnect and inspect status; do not automatically retry." }; } }
}
function declaredExecutor(env: NodeJS.ProcessEnv = process.env): JsonObject | null {
  const raw = env.HARNESS_ACTOR?.trim();
  if (!raw) return null;
  const match = /^agent:([A-Za-z0-9][A-Za-z0-9._:-]*)$/u.exec(raw);
  if (!match) throw new Error("HARNESS_ACTOR must use agent:<id> with an alphanumeric id containing only letters, numbers, dot, underscore, colon, or dash.");
  return { kind: "agent", id: match[1]! };
}
export function consumeKnownError(error: unknown): void { void error; }
