import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import {
  canonicalRoot,
  commandClassForAction,
  daemonMethodAcceptsPayload,
  daemonMethodAcceptsPayloadExecutor,
  workspaceId,
  type DaemonSessionEnvironment,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  resolveLocalDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "../../../daemon/src/client/local-daemon-target.ts";
import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import { materializePromptFile } from "../cli-runtime-prompt-file.ts";
import type { ThinCommand } from "../cli/thin-command.ts";
import { fleetDocRoute, fleetRuntimeRoute, fleetScheduleRoute, fleetTaskRoute } from "./fleet-command-route.ts";
import { openDaemonStatusReader } from "./status-reader.ts";
import { withAutostart } from "./with-autostart.ts";
import { assertCanonicalCliEntry, cliEntryNotCanonicalCode } from "./cli-entry-guard.ts";
import { isRepoAdminMethod, runRepoAdminCommand } from "./repo-admin-route.ts";
export {
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
  type LocalDaemonTarget,
} from "../../../daemon/src/client/local-daemon-target.ts";
export type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";

// These values belong to the invoking runtime worker or its provider launch,
// not to the resident daemon that owns the shared socket.
export const daemonRuntimeScopedEnvironmentKeys = [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "HARNESS_ACTOR",
  "HARNESS_DAEMON_ENDPOINT",
  "HARNESS_DAEMON_RELAY",
  "HARNESS_DAEMON_ID",
  "HARNESS_DAEMON_REPO_ID",
  "HARNESS_DAEMON_USER_ROOT",
] as const;
export function daemonServeEntry(): string {
  const manifestPath = createRequire(import.meta.url).resolve("@harness-anything/daemon/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = manifest.bin?.["harness-anything-daemon"];
  if (manifest.version !== "0.0.1" || typeof bin !== "string")
    throw new Error("The installed daemon must provide the 0.1.0 harness-anything-daemon bin.");
  return path.resolve(path.dirname(manifestPath), bin);
}
export function cliDaemonServeLaunch(
  userRoot: string,
  daemonId: string,
  execPath = process.execPath,
  entry = daemonServeEntry(),
  mode: "serve" | "--service" = "serve",
): DaemonLaunchSpec {
  const env = { ...process.env };
  for (const key of daemonRuntimeScopedEnvironmentKeys) delete env[key];
  return {
    command: execPath,
    args: [entry, mode, "--user-root", userRoot, "--daemon-id", daemonId],
    env,
  };
}
export function daemonAutostartFailureCode(error: unknown): string | null {
  return error instanceof Error &&
    error.name === "DaemonAutostartError" &&
    typeof (error as Error & { readonly code?: unknown }).code === "string"
    ? (error as Error & { readonly code: string }).code
    : null;
}
// daemon_response_timeout proves one connection went unanswered within its deadline; the daemon being absent is a
// different, checkable claim. Flattening the deadline into daemon_unavailable once sent a degraded waiting client
// to read daemon lifecycle logs while the daemon was healthy, so the classified code rides through unflattened.
export function daemonResponseTimeoutCode(error: unknown): "daemon_response_timeout" | null {
  return typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "daemon_response_timeout"
    ? "daemon_response_timeout"
    : null;
}
export function daemonTargetFailureCode(error: unknown): "daemon_target_conflict" | null {
  return typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "daemon_target_conflict"
    ? "daemon_target_conflict"
    : null;
}
export function cliEntryFailureCode(error: unknown): typeof cliEntryNotCanonicalCode | null {
  const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : null;
  return code === cliEntryNotCanonicalCode ? cliEntryNotCanonicalCode : null;
}
// Repo bootstrap and runtime-instance commands must reach the daemon an isolated runtime injected
// through HARNESS_DAEMON_ENDPOINT, not the implicit user socket: the resolver honours the injected
// endpoint and the repo scope.
function repoScopedDaemonEndpoint(
  env: NodeJS.ProcessEnv,
  command: ThinCommand,
  userRoot: string,
  daemonId: string,
): string {
  return resolveLocalDaemonEndpoint({
    userRoot,
    daemonId,
    env,
    repoId: env.HARNESS_DAEMON_REPO_ID,
    canonicalRoot: command.rootDir,
  });
}

export async function runCommandThroughDaemon(
  command: ThinCommand,
  onPhase: (receipt: JsonObject) => void = () => undefined,
  options: { readonly autostart?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
  timeRequest?: (typeof import("../cli/timing.ts"))["timedDaemonRequest"],
): Promise<JsonObject> {
  command = materializePromptFile(inlineAdjudicationNote(materializeScheduleMission(command)));
  const env = options.env ?? process.env;
  assertCanonicalCliEntry();
  const rpc = await import("../../../daemon/src/client/local-json-rpc-client.ts"),
    requestLocalDaemonJsonRpcForTarget = (timeRequest ?? ((f) => f))(((target, ...rest) =>
      rpc.requestLocalDaemonJsonRpcForTarget(
        {
          ...target,
          reportStaleBuild: true,
        },
        ...rest,
      )) as typeof rpc.requestLocalDaemonJsonRpcForTarget),
    autostart = options.autostart ?? command.action.kind !== "receipt-show";
  if (command.action.kind === "repo-bootstrap") {
    const userRoot = daemonUserRoot(env),
      daemonId = daemonIdFromEnv(env),
      { kind: _kind, ...params } = command.action,
      socketPath = repoScopedDaemonEndpoint(env, command, userRoot, daemonId);
    return withAutostart(
      () =>
        requestLocalDaemonJsonRpcForTarget(
          {
            repoId: workspaceId("bootstrap"),
            canonicalRoot: canonicalRoot(command.rootDir, true),
            userRoot,
            daemonId,
            socketPath,
          },
          "daemon.repo.bootstrap",
          { rootDir: command.rootDir, ...params },
          75,
        ),
      () => cliDaemonServeLaunch(userRoot, daemonId),
      socketPath,
      daemonAutostartOptions(command, autostart, env, userRoot, daemonId, "operation"),
    );
  }
  if (command.method.startsWith("daemon.runtimeInstance.")) {
    const userRoot = daemonUserRoot(env),
      daemonId = daemonIdFromEnv(env),
      { kind: _kind, ...payload } = command.action,
      socketPath = repoScopedDaemonEndpoint(env, command, userRoot, daemonId);
    return withAutostart(
      () =>
        requestLocalDaemonJsonRpcForTarget(
          { userRoot, daemonId, socketPath },
          command.method,
          { payload: payload as JsonObject },
          75,
        ),
      () => cliDaemonServeLaunch(userRoot, daemonId),
      socketPath,
      daemonAutostartOptions(command, autostart, env, userRoot, daemonId),
    );
  }
  if (isRepoAdminMethod(command.method))
    return runRepoAdminCommand({
      command,
      env,
      request: (target, method, params) => requestLocalDaemonJsonRpcForTarget(target, method, params, 75),
      launch: (target) => cliDaemonServeLaunch(target.userRoot, target.daemonId),
      autostartOptions: (target) =>
        daemonAutostartOptions(command, autostart, env, target.userRoot, target.daemonId, "operation"),
    });
  const fleetTask =
    (await fleetScheduleRoute(command, env)) ??
    (await fleetRuntimeRoute(command, env)) ??
    (await fleetTaskRoute(command, env));
  if (fleetTask) {
    const userRoot = daemonUserRoot(env),
      daemonId = daemonIdFromEnv(env),
      socketPath = localUserDaemonEndpoint(userRoot, daemonId);
    return withAutostart(
      () =>
        requestLocalDaemonJsonRpcForTarget(
          { userRoot, daemonId, socketPath },
          "daemon.fleet.task.run",
          { payload: fleetTask as JsonObject },
          75,
        ),
      () => cliDaemonServeLaunch(userRoot, daemonId),
      socketPath,
      daemonAutostartOptions(command, autostart, env, userRoot, daemonId, "operation"),
    );
  }
  const fleetDoc = await fleetDocRoute(command, env);
  if (fleetDoc) {
    const userRoot = daemonUserRoot(env),
      daemonId = daemonIdFromEnv(env),
      socketPath = localUserDaemonEndpoint(userRoot, daemonId);
    return withAutostart(
      () =>
        requestLocalDaemonJsonRpcForTarget(
          { userRoot, daemonId, socketPath },
          fleetDoc.method,
          { payload: fleetDoc.payload as JsonObject },
          75,
        ),
      () => cliDaemonServeLaunch(userRoot, daemonId),
      socketPath,
      daemonAutostartOptions(command, autostart, env, userRoot, daemonId, daemonCommandCategory(fleetDoc.method)),
    );
  }
  const target = {
    ...(await resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId, env })),
    sessionEnvironment: interactiveSessionEnvironment(env),
  };
  const requestPayload = daemonRequestPayload(command, env);
  const request = () =>
    requestLocalDaemonJsonRpcForTarget(
      target,
      command.method,
      {
        repo: { repoId: target.repoId },
        ...(daemonMethodAcceptsPayload(command.method) ? { payload: requestPayload as JsonObject } : {}),
      },
      75,
      readResponseDeadlineMs(command.action.kind),
    );
  let result = await withAutostart(
    request,
    () => cliDaemonServeLaunch(target.userRoot, target.daemonId),
    target.socketPath,
    daemonAutostartOptions(command, autostart, env, target.userRoot, target.daemonId),
  );
  result = await settleRepoWarming(
    result,
    () =>
      openLocalDaemonReader(target, command.method, {
        repo: { repoId: target.repoId },
        ...(daemonMethodAcceptsPayload(command.method) ? { payload: requestPayload as JsonObject } : {}),
      }),
    target.userRoot,
    target.daemonId,
  );
  if (command.action.kind !== "preset-run-start") return result;
  let observed = 0,
    statusReader: Awaited<ReturnType<typeof openLocalDaemonReader>> | undefined;
  try {
    for (;;) {
      const phases = Array.isArray(result.phases)
        ? result.phases.filter((phase): phase is string => typeof phase === "string")
        : [];
      for (const phase of phases.slice(observed))
        onPhase({
          ...result,
          ok: !["op_rejected", "failed", "outcome_unknown"].includes(phase),
          command: "preset-run-start",
          summary: `preset-run-start: ${phase}`,
        });
      observed = phases.length;
      if (["applied", "op_rejected", "failed", "outcome_unknown"].includes(String(result.outcome))) {
        const ok = result.outcome === "applied";
        return {
          ...result,
          ok,
          command: "preset-run-start",
          summary: `preset-run-start: ${String(result.phase)}`,
          ...(!ok
            ? {
                error: {
                  code: result.code ?? "preset_run_failed",
                },
              }
            : {}),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        statusReader ??= await openLocalDaemonReader(target, "repo.preset.run.status", {
          repo: { repoId: target.repoId },
          payload: { runId: result.runId },
        });
        result = await statusReader.read();
      } catch (error) {
        consumeKnownError(error);
        statusReader?.close();
        statusReader = undefined;
        result = {
          ...result,
          outcome: "outcome_unknown",
          phase: "outcome_unknown",
          phases: [...phases, "outcome_unknown"],
          code: "daemon_disconnect",
          nextAction: "Reconnect and inspect status; do not automatically retry.",
        };
      }
    }
  } finally {
    statusReader?.close();
  }
}

function daemonCommandCategory(method: string): "operation" | "daemon-lifecycle" {
  return method === "daemon.stop" || method === "daemon.status" ? "daemon-lifecycle" : "operation";
}

function daemonAutostartOptions(
  command: ThinCommand,
  autostart: boolean,
  env: NodeJS.ProcessEnv,
  userRoot: string,
  daemonId: string,
  commandCategory = daemonCommandCategory(command.method),
): Parameters<typeof withAutostart>[3] {
  return { autostart, env, invokingRoot: command.rootDir, userRoot, daemonId, commandCategory };
}

function daemonRequestPayload(command: ThinCommand, env: NodeJS.ProcessEnv): Readonly<Record<string, unknown>> {
  const { kind: _kind, ...actionPayload } = command.action,
    payload =
      command.method === "repo.script.run"
        ? Object.fromEntries(
            Object.entries(actionPayload).filter(
              ([field, value]) => field !== "schema" && (field !== "taskId" || value !== null),
            ),
          )
        : actionPayload,
    executor = declaredExecutor(env);
  // Task action methods carry the executor inside their open action envelope; every other method takes
  // payload.executor exactly where the daemon contract declares the field.
  return command.method === "repo.task.run" || command.method === "repo.task.read"
    ? { action: executor ? { ...command.action, executor } : command.action }
    : executor && daemonMethodAcceptsPayloadExecutor(command.method)
      ? { ...payload, executor }
      : payload;
}
function materializeScheduleMission(command: ThinCommand): ThinCommand {
  if (
    !["schedule-create", "schedule-update"].includes(command.action.kind) ||
    typeof command.action.missionFile !== "string"
  )
    return command;
  const missionPath = path.resolve(command.rootDir, command.action.missionFile),
    relative = path.relative(command.rootDir, missionPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("--mission-file must stay within the selected repository."), {
      code: "invalid_field",
    });
  const { missionFile: _missionFile, ...action } = command.action;
  return { ...command, action: { ...action, mission: readFileSync(missionPath, "utf8") } };
}

/** `--note-file <path>` (task adjudication) is read client-side and inlined as the note text. */
function inlineAdjudicationNote(command: ThinCommand): ThinCommand {
  const action = command.action as Readonly<Record<string, unknown>> & { readonly kind: string };
  if (action.kind !== "task-adjudicate" || typeof action.noteFile !== "string") return command;
  const notePath = path.resolve(command.rootDir, action.noteFile),
    relative = path.relative(command.rootDir, notePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("--note-file must stay within the selected repository."), {
      code: "invalid_field",
    });
  const { noteFile: _noteFile, ...rest } = action;
  return { ...command, action: { ...rest, reason: readFileSync(notePath, "utf8") } };
}
async function settleRepoWarming(
  initial: JsonObject,
  openReader: () => ReturnType<typeof openLocalDaemonReader>,
  userRoot: string,
  daemonId: string,
): Promise<JsonObject> {
  if (!isRepoWarming(initial)) return initial;
  const { readDaemonStartProgress } = await import("../../../daemon/src/client/daemon-autostart.ts"),
    launch = cliDaemonServeLaunch(userRoot, daemonId),
    startedAt = Date.now(),
    deadline = startedAt + 60_000;
  let result = initial,
    reader: Awaited<ReturnType<typeof openLocalDaemonReader>> | undefined,
    reported = "";
  try {
    while (isRepoWarming(result) && Date.now() < deadline) {
      const progress = readDaemonStartProgress(launch, Date.now() - startedAt);
      if (progress) {
        const key = `${progress.fingerprint}:${Math.floor((Date.now() - startedAt) / 1_000)}`;
        if (key !== reported) {
          reported = key;
          process.stderr.write(`${progress.message}\n`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      reader ??= await openReader();
      result = await reader.read();
    }
    return result;
  } finally {
    reader?.close();
  }
}
function isRepoWarming(result: JsonObject): boolean {
  const error =
    result.error && typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as JsonObject)
      : null;
  return result.code === "repo_warming" || error?.code === "repo_warming";
}
export async function streamRuntimeThroughDaemon(
  command: ThinCommand,
  runtimeSessionId: string,
  onValue: (value: unknown) => void,
  onClosed?: (failure: import("../../../daemon/src/client/local-json-rpc-stream.ts").DaemonStreamLost) => void,
): Promise<() => void> {
  const target = await resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }),
    { streamAgentRuntimeAt } = await import("../../../daemon/src/client/local-json-rpc-stream.ts");
  return streamAgentRuntimeAt({
    socketPath: target.socketPath,
    repoId: target.repoId,
    payload: { runtimeSessionId, afterCursor: "stream:0" },
    onValue,
    timeoutMs: 2_000,
    ...(onClosed ? { onClosed } : {}),
  });
}
export async function openRuntimeStatusReader(
  command: ThinCommand,
  runtimeSessionId: string,
  waitTarget?: { readonly taskId: string; readonly dispatchId: string },
): Promise<{ readonly read: () => Promise<JsonObject>; readonly close: () => void }> {
  const fleetCommand = {
    ...command,
    method: "repo.agentRuntime.sessions.read",
    action: { kind: "runtime-status", ...(waitTarget ?? { runtimeSessionId }) },
  } as ThinCommand;
  if (await fleetRuntimeRoute(fleetCommand))
    return {
      read: () => runCommandThroughDaemon(fleetCommand, () => undefined, { autostart: false }),
      close: () => undefined,
    };
  return openDaemonStatusReader(fleetCommand, "repo.agentRuntime.sessions.read", waitTarget ?? { runtimeSessionId });
}
async function openLocalDaemonReader(
  target: { readonly socketPath: string; readonly sessionEnvironment?: DaemonSessionEnvironment },
  method: string,
  params: JsonObject,
  connectTimeoutMs = 75,
  responseTimeoutMs?: number,
): Promise<{ readonly read: () => Promise<JsonObject>; readonly close: () => void }> {
  const { openDaemonJsonRpcReaderAt } = await import("../../../daemon/src/client/local-json-rpc-client.ts");
  return openDaemonJsonRpcReaderAt(
    target.socketPath,
    method,
    params,
    connectTimeoutMs,
    responseTimeoutMs,
    target.sessionEnvironment,
  );
}
// The sign-in relay stays lazy for the same reason the autostart seam does: the thin dist static
// import graph stays entry/parser/transport-only, and the tty bridge only loads for an
// interactive auth command.
export async function relayRuntimeAuthTerminal(
  command: ThinCommand,
  sessionId: string,
  onOutput: (text: string) => void,
): Promise<number> {
  const target = await resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }),
    { relayDaemonTerminal } = await import("../../../daemon/src/client/terminal-relay.ts");
  return relayDaemonTerminal({ socketPath: target.socketPath, repoId: target.repoId, sessionId, write: onOutput });
}
// Reads never mutate and every measured read answers in well under a second, so a read that is still unanswered after
// this long is queued behind a long write. Naming that deadline turns an open-ended silent socket into one classified
// failure; writes stay unbounded because their honest duration is not knowable from here.
const readResponseDeadlineMs = (kind: string): number | undefined => {
  // A parked await answers when a runtime settles — minutes or hours — not within a read budget.
  if (kind === "runtime-sessions-await") return undefined;
  try {
    return commandClassForAction(kind) === "repo-read" ? 30_000 : undefined;
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
};
function declaredExecutor(env: NodeJS.ProcessEnv = process.env): JsonObject | null {
  const raw = interactiveAgentActor(env);
  if (!raw) return null;
  const match = /^agent:([A-Za-z0-9][A-Za-z0-9._:-]*)$/u.exec(raw);
  if (!match)
    throw new Error(
      "HARNESS_ACTOR must use agent:<id> with an alphanumeric id containing only letters, numbers, dot, underscore, colon, or dash.",
    );
  return { kind: "agent", id: match[1]! };
}
function interactiveSessionEnvironment(env: NodeJS.ProcessEnv): DaemonSessionEnvironment {
  const claudeSessionId = env.CLAUDE_CODE_SESSION_ID?.trim(),
    codexThreadId = env.CODEX_THREAD_ID?.trim(),
    codexSessionId = env.CODEX_SESSION_ID?.trim(),
    harnessActor = interactiveAgentActor(env);
  return {
    ...(claudeSessionId ? { CLAUDE_CODE_SESSION_ID: claudeSessionId } : {}),
    ...(codexThreadId ? { CODEX_THREAD_ID: codexThreadId } : {}),
    ...(codexSessionId ? { CODEX_SESSION_ID: codexSessionId } : {}),
    ...(harnessActor ? { HARNESS_ACTOR: harnessActor } : {}),
  };
}
function interactiveAgentActor(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.HARNESS_ACTOR?.trim();
  if (explicit) return explicit;
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim(),
    thread = env.CODEX_THREAD_ID?.trim(),
    session = env.CODEX_SESSION_ID?.trim();
  if (claude && (thread || session)) return null;
  if (thread && session && thread !== session) return null;
  if (claude) return `agent:claude-session:${claude}`;
  const codex = thread ?? session;
  return codex ? `agent:codex-session:${codex}` : null;
}
export function consumeKnownError(error: unknown): void {
  void error;
}
