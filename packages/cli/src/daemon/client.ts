import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { canonicalRoot, workspaceId } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget,
  type LocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";

export async function runCommandThroughDaemon(command: ThinCommand, onPhase: (receipt: JsonObject) => void = () => undefined): Promise<JsonObject> {
  const { requestLocalDaemonJsonRpcForTarget } = await import("../../../daemon/src/client/local-json-rpc-client.ts");
  if (command.action.kind === "repo-bootstrap") { const userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv(), { kind: _kind, ...params } = command.action; return requestLocalDaemonJsonRpcForTarget({ repoId: workspaceId("bootstrap"),
    canonicalRoot: canonicalRoot(command.rootDir, true), userRoot, daemonId, socketPath: localUserDaemonEndpoint(userRoot, daemonId) }, "daemon.repo.bootstrap", { rootDir: command.rootDir, ...params }, 75); }
  const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId });
  const { kind: _kind, ...actionPayload } = command.action, payload = command.method === "repo.script.run" ? Object.fromEntries(Object.entries(actionPayload).filter(([field, value]) => field !== "schema" && (field !== "taskId" || value !== null))) : actionPayload;
  let result = await requestLocalDaemonJsonRpcForTarget(target, command.method, { repo: { repoId: target.repoId }, payload: command.method === "repo.task.run" ? { action: command.action as JsonObject } : payload as JsonObject }, 75);
  if (command.action.kind !== "preset-run-start") return result; let observed = 0;
  for (;;) { const phases = Array.isArray(result.phases) ? result.phases.filter((phase): phase is string => typeof phase === "string") : []; for (const phase of phases.slice(observed)) onPhase({ ...result, ok: !["rejected", "failed", "outcome_unknown"].includes(phase), command: "preset-run-start", summary: `preset-run-start: ${phase}` }); observed = phases.length; if (["applied", "rejected", "failed", "outcome_unknown"].includes(String(result.outcome))) { const ok = result.outcome === "applied"; return { ...result, ok, command: "preset-run-start", summary: `preset-run-start: ${String(result.phase)}`, ...(!ok ? { error: { code: result.code ?? "preset_run_failed", hint: result.nextAction ?? "Inspect the run receipt." } } : {}) }; } await new Promise((resolve) => setTimeout(resolve, 20)); try { result = await requestLocalDaemonJsonRpcForTarget(target, "repo.preset.run.status", { repo: { repoId: target.repoId }, payload: { runId: result.runId } }, 75); } catch (error) { consumeKnownError(error); result = { ...result, outcome: "outcome_unknown", phase: "outcome_unknown", phases: [...phases, "outcome_unknown"], code: "daemon_disconnect", nextAction: "Reconnect and inspect status; do not automatically retry." }; } }
} function consumeKnownError(error: unknown): void { void error; }
