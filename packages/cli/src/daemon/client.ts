import { realpathSync, readFileSync } from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts"; import { canonicalRoot, commandClassForAction, daemonMethodAcceptsPayloadExecutor, workspaceId, type DaemonSessionEnvironment } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, readRegisteredRepos, resolveLocalDaemonEndpoint, resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget,
  type LocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
export type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";

const autostartFailureCodes = ["daemon_spawn_not_found", "daemon_spawn_permission", "daemon_start_failed", "daemon_bind_timeout", "daemon_starting"] as const;
export function daemonServeEntry(): string { return realpathSync(fileURLToPath(new URL(import.meta.url.endsWith(".js") ? "../index.js" : "../index.ts", import.meta.url))); }
export function cliDaemonServeLaunch(userRoot: string, daemonId: string, execPath = process.execPath): DaemonLaunchSpec {
  return { command: execPath, args: [daemonServeEntry(), "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId], env: process.env };
}
export function daemonAutostartFailureCode(error: unknown): string | null { const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null; return code !== null && (autostartFailureCodes as readonly string[]).includes(code) ? code : null; }
// daemon_response_timeout proves one connection went unanswered within its deadline; the daemon being absent is a
// different, checkable claim. Flattening the deadline into daemon_unavailable once sent a degraded waiting client
// to read daemon lifecycle logs while the daemon was healthy, so the classified code rides through unflattened.
export function daemonResponseTimeoutCode(error: unknown): "daemon_response_timeout" | null { return typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "daemon_response_timeout" ? "daemon_response_timeout" : null; }
export function daemonTargetFailureCode(error: unknown): "daemon_target_conflict" | null { return typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "daemon_target_conflict" ? "daemon_target_conflict" : null; }
// The autostart seam is imported lazily so the thin dist static import graph stays
// entry/parser/transport-only; it is only reachable on a connection-level failure.
async function withAutostart(request: () => Promise<JsonObject>, launch: () => DaemonLaunchSpec, socketPath: string, autostart: boolean): Promise<JsonObject> {
  try { return await request(); }
  catch (error) {
    if (!autostart) throw error;
    const { DaemonAutostartError, ensureLocalDaemonRunning, isDaemonUnreachable } = await import("../../../daemon/src/client/daemon-autostart.ts");
    if (!isDaemonUnreachable(error)) throw error;
    const started = await ensureLocalDaemonRunning({ socketPath, launch, onProgress: (progress) => process.stderr.write(`${progress.message}\n`) });
    if (!started.ok) throw new DaemonAutostartError(started);
    return await request();
  }
}
export async function runCommandThroughDaemon(command: ThinCommand, onPhase: (receipt: JsonObject) => void = () => undefined, options: { readonly autostart?: boolean; readonly env?: NodeJS.ProcessEnv } = {}): Promise<JsonObject> {
  const { requestLocalDaemonJsonRpcForTarget } = await import("../../../daemon/src/client/local-json-rpc-client.ts"), autostart = options.autostart ?? command.action.kind !== "receipt-show", env = options.env ?? process.env;
  if (command.action.kind === "repo-bootstrap") { const userRoot = daemonUserRoot(env), daemonId = daemonIdFromEnv(env), { kind: _kind, ...params } = command.action, socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ repoId: workspaceId("bootstrap"),
    canonicalRoot: canonicalRoot(command.rootDir, true), userRoot, daemonId, socketPath }, "daemon.repo.bootstrap", { rootDir: command.rootDir, ...params }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  if (command.method.startsWith("daemon.runtimeInstance.")) { const userRoot = daemonUserRoot(env), daemonId = daemonIdFromEnv(env), { kind: _kind, ...payload } = command.action, socketPath = resolveLocalDaemonEndpoint({ userRoot, daemonId, env, repoId: env.HARNESS_DAEMON_REPO_ID, canonicalRoot: command.rootDir }); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ userRoot, daemonId, socketPath }, command.method, { payload: payload as JsonObject }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  const fleetRuntime = await fleetRuntimeRoute(command, env);
  if (fleetRuntime) { const userRoot = daemonUserRoot(env), daemonId = daemonIdFromEnv(env), socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ userRoot, daemonId, socketPath }, "daemon.fleet.task.run", { payload: fleetRuntime as JsonObject }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  const fleetTask = await fleetTaskRoute(command, env);
  if (fleetTask) { const userRoot = daemonUserRoot(env), daemonId = daemonIdFromEnv(env), socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ userRoot, daemonId, socketPath }, "daemon.fleet.task.run", { payload: fleetTask as JsonObject }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  const fleetDoc = await fleetDocRoute(command, env);
  if (fleetDoc) { const userRoot = daemonUserRoot(env), daemonId = daemonIdFromEnv(env), socketPath = localUserDaemonEndpoint(userRoot, daemonId); return withAutostart(() => requestLocalDaemonJsonRpcForTarget({ userRoot, daemonId, socketPath }, fleetDoc.method, { payload: fleetDoc.payload as JsonObject }, 75), () => cliDaemonServeLaunch(userRoot, daemonId), socketPath, autostart); }
  const target = { ...resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId, env }), sessionEnvironment: interactiveSessionEnvironment(env) };
  const { kind: _kind, ...actionPayload } = command.action, payload = command.method === "repo.script.run" ? Object.fromEntries(Object.entries(actionPayload).filter(([field, value]) => field !== "schema" && (field !== "taskId" || value !== null))) : actionPayload, executor = declaredExecutor(env);
  // repo.task.run carries the executor inside its open action envelope; every other method takes
  // payload.executor exactly where the daemon contract declares the field (daemonMethodAcceptsPayloadExecutor),
  // so a newly contracted command needs no CLI-side list edit to stay un-injected.
  const requestPayload = command.method === "repo.task.run" ? { action: executor ? { ...command.action, executor } : command.action } : executor && daemonMethodAcceptsPayloadExecutor(command.method) ? { ...payload, executor } : payload;
  const request = () => requestLocalDaemonJsonRpcForTarget(target, command.method, { repo: { repoId: target.repoId }, payload: requestPayload as JsonObject }, 75, readResponseDeadlineMs(command.action.kind));
  let result = await withAutostart(request, () => cliDaemonServeLaunch(target.userRoot, target.daemonId), target.socketPath, autostart);
  result = await settleRepoWarming(result, request, target.userRoot, target.daemonId);
  if (command.action.kind !== "preset-run-start") return result; let observed = 0;
  for (;;) { const phases = Array.isArray(result.phases) ? result.phases.filter((phase): phase is string => typeof phase === "string") : []; for (const phase of phases.slice(observed)) onPhase({ ...result, ok: !["op_rejected", "failed", "outcome_unknown"].includes(phase), command: "preset-run-start", summary: `preset-run-start: ${phase}` }); observed = phases.length; if (["applied", "op_rejected", "failed", "outcome_unknown"].includes(String(result.outcome))) { const ok = result.outcome === "applied"; return { ...result, ok, command: "preset-run-start", summary: `preset-run-start: ${String(result.phase)}`, ...(!ok ? { error: { code: result.code ?? "preset_run_failed", hint: result.nextAction ?? "Inspect the run receipt." } } : {}) }; } await new Promise((resolve) => setTimeout(resolve, 20)); try { result = await requestLocalDaemonJsonRpcForTarget(target, "repo.preset.run.status", { repo: { repoId: target.repoId }, payload: { runId: result.runId } }, 75); } catch (error) { consumeKnownError(error); result = { ...result, outcome: "outcome_unknown", phase: "outcome_unknown", phases: [...phases, "outcome_unknown"], code: "daemon_disconnect", nextAction: "Reconnect and inspect status; do not automatically retry." }; } }
}
async function settleRepoWarming(initial: JsonObject, request: () => Promise<JsonObject>, userRoot: string, daemonId: string): Promise<JsonObject> {
  if (!isRepoWarming(initial)) return initial; const { readDaemonStartProgress } = await import("../../../daemon/src/client/daemon-autostart.ts"), launch = cliDaemonServeLaunch(userRoot, daemonId), startedAt = Date.now(), deadline = startedAt + 60_000; let result = initial, reported = "";
  while (isRepoWarming(result) && Date.now() < deadline) { const progress = readDaemonStartProgress(launch, Date.now() - startedAt); if (progress) { const key = `${progress.fingerprint}:${Math.floor((Date.now() - startedAt) / 1_000)}`; if (key !== reported) { reported = key; process.stderr.write(`${progress.message}\n`); } } await new Promise((resolve) => setTimeout(resolve, 250)); result = await request(); }
  return result;
}
function isRepoWarming(result: JsonObject): boolean { const error = result.error && typeof result.error === "object" && !Array.isArray(result.error) ? result.error as JsonObject : null; return result.code === "repo_warming" || error?.code === "repo_warming"; }
export async function streamRuntimeThroughDaemon(command: ThinCommand, runtimeSessionId: string, onValue: (value: unknown) => void): Promise<() => void> { const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }), { streamAgentRuntimeAt } = await import("../../../daemon/src/client/local-json-rpc-stream.ts"); return streamAgentRuntimeAt({ socketPath: target.socketPath, repoId: target.repoId, payload: { runtimeSessionId, afterCursor: "stream:0" }, onValue, timeoutMs: 2_000 }); }
export async function openRuntimeStatusReader(command: ThinCommand, runtimeSessionId: string): Promise<{ readonly read: () => Promise<JsonObject>; readonly close: () => void }> { const fleetCommand = { ...command, method: "repo.agentRuntime.sessions.read", action: { kind: "runtime-status", runtimeSessionId } } as ThinCommand; if (await fleetRuntimeRoute(fleetCommand)) return { read: () => runCommandThroughDaemon(fleetCommand), close: () => undefined }; const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }), { connectSocket, JsonRpcLineClient } = await import("../../../daemon/src/client/local-json-rpc-client.ts"), { currentDaemonProtocolVersion } = await import("../../../daemon/src/protocol/version.ts"), socket = await connectSocket(target.socketPath, 2_000), client = new JsonRpcLineClient(socket, socket); try { await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 30_000); } catch (error) { socket.destroy(); throw error; } return { read: () => client.request("repo.agentRuntime.sessions.read", { repo: { repoId: target.repoId }, payload: { runtimeSessionId } }, 30_000), close: () => client.close() }; }
// The sign-in relay stays lazy for the same reason the autostart seam does: the thin dist static
// import graph stays entry/parser/transport-only, and the tty bridge only loads for an
// interactive auth command.
export async function relayRuntimeAuthTerminal(command: ThinCommand, sessionId: string, onOutput: (text: string) => void): Promise<number> { const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }), { relayDaemonTerminal } = await import("../../../daemon/src/client/terminal-relay.ts"); return relayDaemonTerminal({ socketPath: target.socketPath, repoId: target.repoId, sessionId, write: onOutput }); }
// Reads never mutate and every measured read answers in well under a second, so a read that is still unanswered after
// this long is queued behind a long write. Naming that deadline turns an open-ended silent socket into one classified
// failure; writes stay unbounded because their honest duration is not knowable from here.
const readResponseDeadlineMs = (kind: string): number | undefined => { try { return commandClassForAction(kind) === "repo-read" ? 30_000 : undefined; } catch (error) { consumeKnownError(error); return undefined; } };
// The automatic lease product entry: on a remote-edge workspace the task write
// commands route through the fleet channel instead of a local cell. The
// operator never runs a lease command — acquisition, queueing, and renewal are
// the center's job (dec_9E7AC30E/CH2).
// task-create rides its own preset method; the lifecycle commands ride repo.task.run.
const fleetTaskMethods = ["repo.task.run", "repo.task.create"];
const fleetRuntimeMethods = ["repo.agentRuntime.spawn", "repo.agentRuntime.cancel", "repo.agentRuntime.overview", "repo.agentRuntime.sessions.read"] as const;
export async function fleetRuntimeRoute(command: ThinCommand, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown> | null> {
  if (!(fleetRuntimeMethods as readonly string[]).includes(command.method)) return null;
  const config = await fleetEdgeRegistration(command, env); if (!config) return null;
  const { kind: _kind, executor: _executor, wait: _wait, noStream: _noStream, detach: _detach, ...action } = command.action as Record<string, unknown>;
  return { host: config.host, port: config.port, caPath: config.caPath, ...(config.servername ? { servername: config.servername } : {}), nodeId: config.nodeId, ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}), ...(config.credential ? { credential: config.credential } : {}), assignmentId: config.assignmentId, repoId: config.repoId, viewRoot: config.viewRoot, quotaBytes: config.quotaBytes, workspaceRoot: config.workspaceRoot, action: { kind: "fleet-runtime", method: command.method, payload: action } };
}
// The fleet modules stay lazy for the same reason the autostart seam does: the
// thin dist static import graph stays entry/parser/transport-only. Registry mode
// is the single repo-mode source of truth; its matched canonical root also owns
// fleet-edge.json for commands launched from worktrees or descendants.
export async function fleetTaskRoute(command: ThinCommand, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown> | null> {
  if (!fleetTaskMethods.includes(command.method)) return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const { FLEET_TASK_COMMAND_KINDS } = await import("../../../daemon/src/fleet/contract.ts");
  if (!(FLEET_TASK_COMMAND_KINDS as readonly string[]).includes(command.action.kind)) return null;
  const { executor: _executor, createMode, verb: _verb, commandType: _commandType, fromFile, jsonInput, fromLegacyId, ...action } = command.action as Record<string, unknown> & { executor?: unknown; createMode?: unknown; verb?: unknown; commandType?: unknown; fromFile?: unknown; jsonInput?: unknown; fromLegacyId?: unknown };
  // Migration/import/admin creation and legacy conversion are intentionally
  // outside the remote-edge surface. Falling through produces the existing,
  // explicit repo_mode_read_only receipt instead of silently dropping their
  // authority-bearing fields on the fleet route.
  if (command.action.kind === "task-create" && (createMode !== undefined || fromLegacyId !== undefined)) return null;
  const payload: Record<string, unknown> = { host: config.host, port: config.port, caPath: config.caPath, ...(config.servername ? { servername: config.servername } : {}), nodeId: config.nodeId, ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}), ...(config.credential ? { credential: config.credential } : {}), assignmentId: config.assignmentId, repoId: config.repoId, viewRoot: config.viewRoot, quotaBytes: config.quotaBytes, workspaceRoot: config.workspaceRoot, ...(config.waitTimeoutMs ? { waitTimeoutMs: config.waitTimeoutMs } : {}), action };
  if (typeof fromFile === "string" || typeof jsonInput === "string") { const source = typeof fromFile === "string" ? `--from-file ${fromFile}` : "--json-input", file = typeof fromFile === "string" ? path.isAbsolute(fromFile) ? fromFile : path.join(command.rootDir, fromFile) : null; let packet: unknown; try { packet = JSON.parse(file ? readFileSync(file, "utf8") : String(jsonInput)); } catch (error) { throw Object.assign(new Error(`${source} could not be read as JSON on this edge: ${error instanceof Error ? error.message : String(error)}`), { code: "invalid_field" }); }
    if (packet === null || typeof packet !== "object" || Array.isArray(packet)) throw Object.assign(new Error(`${source} must contain one JSON object.`), { code: "invalid_field" });
    if (command.action.kind === "task-create") { const fields = packet as Record<string, unknown>; const unsupported = Object.keys(fields).filter((field) => ["fromFile", "jsonInput", "kind", "createMode", "fromLegacyId"].includes(field)); if (unsupported.length) throw Object.assign(new Error(`--from-file for task create cannot carry ${unsupported.join(", ")} over the fleet channel.`), { code: "invalid_field" }); payload.action = { ...fields, ...action }; }
    else payload.action = { ...action, submission: packet }; }
  return payload;
}
// The registry-mode gate behind every fleet reroute: a workspace only takes a
// fleet channel when fleet-edge.json names it AND its canonical root is
// registered in remote-edge mode (adversarial F7 discipline, shared by the
// task and doc surfaces).
type FleetEdgeConfigModule = import("../../../daemon/src/client/fleet-edge-config.ts").FleetEdgeConfig;
async function fleetEdgeRegistration(
  command: ThinCommand,
  env: NodeJS.ProcessEnv,
): Promise<(FleetEdgeConfigModule & { readonly workspaceRoot: string }) | null> {
  const { readFleetEdgeConfig } = await import("../../../daemon/src/client/fleet-edge-config.ts");
  const commandRoot = path.resolve(command.rootDir), registered = readRegisteredRepos(daemonUserRoot(env)).filter((repo) => repo.state === "enabled" && (commandRoot === path.resolve(repo.canonicalRoot) || commandRoot.startsWith(`${path.resolve(repo.canonicalRoot)}${path.sep}`))).sort((left, right) => path.resolve(right.canonicalRoot).length - path.resolve(left.canonicalRoot).length)[0];
  if (registered?.mode !== "remote-edge") return null;
  const config = readFleetEdgeConfig(registered.canonicalRoot);
  return config?.repoId === registered.repoId
    ? { ...config, workspaceRoot: path.resolve(registered.canonicalRoot) }
    : null;
}
// Class-B surface on a remote-edge workspace: `ha doc sync` becomes one
// compare→push/pull fleet round, and the three conflict exits become fleet
// conflict-exit rounds. Everything else keeps its local receipt path.
const fleetDocSyncKinds = new Map([["doc-dry-run", { method: "daemon.fleet.doc.sync", dryRun: true }], ["doc-submit", { method: "daemon.fleet.doc.sync", dryRun: false }], ["doc-conflict-resolve", { method: "daemon.fleet.conflict.exit", action: "resolve" }], ["doc-conflict-discard-local", { method: "daemon.fleet.conflict.exit", action: "discard-local" }], ["doc-conflict-overwrite-center", { method: "daemon.fleet.conflict.exit", action: "overwrite-center" }]]);
export async function fleetDocRoute(command: ThinCommand, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly method: string; readonly payload: Record<string, unknown> } | null> {
  const kind = command.action.kind, route = fleetDocSyncKinds.get(kind);
  if (route === undefined || command.method !== "repo.task.run") return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const payload: Record<string, unknown> = { host: config.host, port: config.port, caPath: config.caPath, ...(config.servername ? { servername: config.servername } : {}), nodeId: config.nodeId, ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}), ...(config.credential ? { credential: config.credential } : {}), assignmentId: config.assignmentId, repoId: config.repoId, viewRoot: config.viewRoot, quotaBytes: config.quotaBytes, workspaceRoot: config.workspaceRoot };
  if ("dryRun" in route) { payload.dryRun = route.dryRun; payload.paths = Array.isArray(command.action.paths) ? command.action.paths.filter((value): value is string => typeof value === "string") : []; }
  else { payload.action = route.action; payload.conflictId = command.action.conflictId; }
  return { method: route.method, payload };
}
function declaredExecutor(env: NodeJS.ProcessEnv = process.env): JsonObject | null {
  const raw = env.HARNESS_ACTOR?.trim();
  if (!raw) return null;
  const match = /^agent:([A-Za-z0-9][A-Za-z0-9._:-]*)$/u.exec(raw);
  if (!match) throw new Error("HARNESS_ACTOR must use agent:<id> with an alphanumeric id containing only letters, numbers, dot, underscore, colon, or dash.");
  return { kind: "agent", id: match[1]! };
}
function interactiveSessionEnvironment(env: NodeJS.ProcessEnv): DaemonSessionEnvironment {
  const claudeSessionId = env.CLAUDE_CODE_SESSION_ID?.trim(), codexThreadId = env.CODEX_THREAD_ID?.trim(), codexSessionId = env.CODEX_SESSION_ID?.trim();
  return { ...(claudeSessionId ? { CLAUDE_CODE_SESSION_ID: claudeSessionId } : {}), ...(codexThreadId ? { CODEX_THREAD_ID: codexThreadId } : {}), ...(codexSessionId ? { CODEX_SESSION_ID: codexSessionId } : {}) };
}
export function consumeKnownError(error: unknown): void { void error; }
