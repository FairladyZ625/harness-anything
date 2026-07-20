import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  makeEnvironmentCurrentSessionProbe,
  taskHolderExecutorFromJournalActor,
  type TaskHolderExecutor
} from "@harness-anything/application";
import {
  daemonIdFromEnv,
  daemonUserRootForRepo,
  DaemonJsonRpcResponseError,
  defaultDaemonAutostartTimeoutMs,
  defaultDaemonIdleExitMs,
  JsonRpcLineClient,
  currentDaemonProtocolVersion,
  resolveCanonicalHarnessRoot,
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget as resolveDaemonTarget,
  type JsonObject,
  type LocalDaemonTarget
} from "@harness-anything/daemon";
import {
  createHarnessRuntimeContext,
  resolveHarnessLayout,
  type CurrentSessionRef,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { CliActorAttributionError, readCliJournalActorFromEnv, readCliJournalActorFromFlag } from "../composition/actor-attribution.ts";
import { parsePositiveIntegerOr } from "../cli/value-utils.ts";
import { buildDocSyncSubmitRequest } from "./doc-sync-service.ts";
import { readProjectHarnessSettings } from "../commands/settings.ts";
import { isDeclaredLocalMigrationCommand } from "../composition/local-write-scope.ts";

export {
  daemonIdForRoot,
  daemonIdForUserRoot,
  daemonIdFromEnv,
  daemonUserRoot,
  localDaemonSocketPath,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath,
  requestLocalDaemonJsonRpc,
  requestLocalDaemonJsonRpcForTarget,
  type LocalDaemonTarget
} from "@harness-anything/daemon";

export type DaemonClientMode = "direct" | "local" | "remote";

export interface DaemonClientConfig {
  readonly mode: DaemonClientMode;
  readonly modeExplicit: boolean;
  readonly idleExitMs: number;
  readonly autostartTimeoutMs: number;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly directWriteReason?: "recovery";
  readonly remote?: RemoteDaemonConfig;
}

export interface RemoteDaemonConfig {
  readonly host: string;
  readonly remoteHaPath: string;
  readonly remoteRoot: string;
  readonly repoId: string;
}

type TaskHolderParsedCommand = ParsedCommand & {
  readonly action: { readonly kind: "task-holder"; readonly taskId: string };
};

export function readDaemonClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
  modeOverride?: DaemonClientMode,
  profileOverride?: "default" | "isolated",
  layoutOverrides?: HarnessLayoutOverrides
): DaemonClientConfig {
  env = {
    ...env,
    ...(modeOverride ? { HARNESS_DAEMON_MODE: modeOverride } : {}),
    ...(profileOverride ? { HARNESS_DAEMON_PROFILE: profileOverride } : {})
  };
  const projectSettings = readProjectDaemonSettings(rootDir, layoutOverrides);
  const projectMode = projectSettings?.identity?.mode;
  const mode = readMode(env.HARNESS_DAEMON_MODE ?? projectMode);
  const userRoot = resolveDaemonUserRoot(env, rootDir, projectSettings, layoutOverrides);
  const directWriteReason = readDirectWriteReason(env.HARNESS_DIRECT_WRITE_REASON);
  return {
    mode,
    modeExplicit: (typeof env.HARNESS_DAEMON_MODE === "string" && env.HARNESS_DAEMON_MODE.trim().length > 0) || projectMode !== undefined,
    idleExitMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_IDLE_MS, defaultDaemonIdleExitMs),
    autostartTimeoutMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS, defaultDaemonAutostartTimeoutMs),
    userRoot,
    daemonId: daemonIdFromEnv(env),
    ...(directWriteReason ? { directWriteReason } : {}),
    ...(mode === "remote" ? { remote: readRemoteConfig(env) } : {})
  };
}

export function readDaemonUserRoot(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
  layoutOverrides?: HarnessLayoutOverrides
): string {
  return resolveDaemonUserRoot(env, rootDir, readProjectDaemonSettings(rootDir, layoutOverrides), layoutOverrides);
}

function resolveDaemonUserRoot(
  env: NodeJS.ProcessEnv,
  rootDir: string,
  projectSettings: ReturnType<typeof readProjectDaemonSettings>,
  layoutOverrides?: HarnessLayoutOverrides
): string {
  const projectUserRoot = projectSettings?.daemon?.userRoot;
  const projectRoot = resolveHarnessLayout(createHarnessRuntimeContext(rootDir, layoutOverrides)).rootDir;
  return daemonUserRootForRepo(
    projectRoot,
    env,
    projectUserRoot ? resolveProjectDaemonUserRoot(projectRoot, projectUserRoot, env) : undefined
  );
}

function readProjectDaemonSettings(rootDir: string, layoutOverrides?: HarnessLayoutOverrides) {
  const settings = readProjectHarnessSettings(
    createHarnessRuntimeContext(rootDir, layoutOverrides),
    "daemon-client-mode",
    { preferAuthoredRootConfig: layoutOverrides?.authoredRoot !== undefined }
  );
  if (!settings.ok) {
    const hint = settings.result.error?.hint ?? "Project daemon settings are invalid.";
    if (/\bsettings\.daemon\b/u.test(hint)) throw new Error(hint);
    return undefined;
  }
  return settings.settings;
}

function resolveProjectDaemonUserRoot(rootDir: string, configured: string, env: NodeJS.ProcessEnv): string {
  if (configured === "~" || /^~[\\/]/u.test(configured)) {
    const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : os.homedir();
    return path.resolve(home, configured.slice(1).replace(/^[\\/]+/u, ""));
  }
  return path.resolve(rootDir, configured);
}

export function resolveLocalDaemonTarget(input: {
  readonly rootDir: string;
  readonly repoIdOverride?: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly autoRegisterSingleRepo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}): LocalDaemonTarget {
  const env = input.env ?? process.env;
  return resolveDaemonTarget({
    ...input,
    userRoot: input.userRoot ?? readDaemonUserRoot(env, input.rootDir, input.layoutOverrides),
    env
  });
}

export async function runCommandThroughDaemon(
  command: ParsedCommand,
  config?: DaemonClientConfig
): Promise<CommandReceipt | CommandFailureReceipt | undefined> {
  try {
    config ??= readDaemonClientConfig(process.env, command.rootDir, command.daemonModeOverride, command.daemonProfileOverride, command.layoutOverrides);
  } catch (error) {
    return daemonUnavailableReceipt(command, error);
  }
  if (config.mode !== "remote" && command.action.kind === "init" && !isInitializedHarness(command)) return undefined;
  if (config.mode !== "remote" && isDeclaredLocalMigrationCommand(command.action)) return undefined;
  if (config.mode === "direct") {
    if (config.directWriteReason === "recovery") return undefined;
    return directModeRejection(command);
  }
  try {
    return config.mode === "remote" && config.remote
      ? await runRemoteCommand(command, config.remote)
      : await runLocalCommand(command, config);
  } catch (error) {
    if (command.action.kind === "materializer-run" && config.mode === "local" && !(error instanceof DaemonJsonRpcResponseError)) {
      return undefined;
    }
    if (error instanceof CliActorAttributionError) {
      return daemonActorAttributionReceipt(command, error);
    }
    if (error instanceof DaemonJsonRpcResponseError) {
      return daemonRequestFailureReceipt(command, error);
    }
    return daemonUnavailableReceipt(command, error, config.mode === "remote" ? config.remote : undefined);
  }
}

async function runLocalCommand(command: ParsedCommand, config: DaemonClientConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  command = commandForCanonicalHarness(command);
  const target = resolveLocalDaemonTarget({
    rootDir: command.rootDir,
    repoIdOverride: command.daemonRepoId,
    userRoot: config.userRoot,
    daemonId: config.daemonId,
    autoRegisterSingleRepo: true,
    layoutOverrides: command.layoutOverrides
  });
  if (isDocSyncSubmitCommand(command)) {
    let request: ReturnType<typeof buildDocSyncSubmitRequest>;
    try {
      request = buildDocSyncSubmitRequest(
        { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides },
        target.repoId,
        docSyncSubmitPaths(command),
        commandExecutor(command)
      );
    } catch (error) {
      return docSyncSubmitPreviewRejected(error);
    }
    const response = await requestLocalDaemonJsonRpcForTarget(target, "repo.doc.sync.submit", request as unknown as JsonObject, 200, {
      entryPath: daemonClientCliEntrypointPath(),
      idleExitMs: config.idleExitMs,
      timeoutMs: config.autostartTimeoutMs,
      layoutOverrides: command.layoutOverrides
    });
    if (isCommandReceipt(response)) return normalizeDocSyncSubmitReceipt(response);
    throw new Error("repo.doc.sync.submit did not return command-receipt/v2");
  }
  if (isTaskHolderCommand(command)) {
    const response = await requestLocalDaemonJsonRpcForTarget(target, taskHolderMethod(command), {
      repo: { repoId: target.repoId },
      payload: taskHolderPayload(command)
    }, 200, {
      entryPath: daemonClientCliEntrypointPath(),
      idleExitMs: config.idleExitMs,
      timeoutMs: config.autostartTimeoutMs,
      layoutOverrides: command.layoutOverrides
    });
    if (isCommandReceipt(response)) return normalizeTaskHolderReceipt(response, command.action.kind);
    throw new Error(`${taskHolderMethod(command)} did not return command-receipt/v2`);
  }
  const response = await requestLocalDaemonJsonRpcForTarget(target, "repo.command.run", {
    repo: { repoId: target.repoId },
    payload: commandRunPayload(
      commandForTarget(command, target),
      Effect.runSync(makeEnvironmentCurrentSessionProbe().currentSession)
    )
  }, 200, command.action.kind === "materializer-run" ? undefined : {
    entryPath: daemonClientCliEntrypointPath(),
    idleExitMs: config.idleExitMs,
    timeoutMs: config.autostartTimeoutMs,
    layoutOverrides: command.layoutOverrides
  });
  if (isCommandReceipt(response)) return response as unknown as CommandReceipt | CommandFailureReceipt;
  throw new Error("daemon command.run did not return command-receipt/v2");
}

async function runRemoteCommand(command: ParsedCommand, remote: RemoteDaemonConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const child = spawn("ssh", remoteDaemonSshArgs(remote), {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const remoteCommand = {
    ...command,
    rootDir: remote.remoteRoot
  } satisfies ParsedCommand;
  return runWithLineClient(new JsonRpcLineClient(child.stdout, child.stdin, child), remoteCommand, remote.repoId);
}

async function runWithLineClient(
  client: JsonRpcLineClient,
  command: ParsedCommand,
  repoId: string
): Promise<CommandReceipt | CommandFailureReceipt> {
  try {
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
    if (isDocSyncSubmitCommand(command)) {
      let request: ReturnType<typeof buildDocSyncSubmitRequest>;
      try {
        request = buildDocSyncSubmitRequest(command.rootDir, repoId, docSyncSubmitPaths(command), commandExecutor(command));
      } catch (error) {
        return docSyncSubmitPreviewRejected(error);
      }
      const response = await client.request("repo.doc.sync.submit", request as unknown as JsonObject);
      if (isCommandReceipt(response)) return normalizeDocSyncSubmitReceipt(response);
      throw new Error("repo.doc.sync.submit did not return command-receipt/v2");
    }
    if (isTaskHolderCommand(command)) {
      const response = await client.request(taskHolderMethod(command), {
        repo: { repoId, canonicalRoot: command.rootDir },
        payload: taskHolderPayload(command)
      });
      if (isCommandReceipt(response)) return normalizeTaskHolderReceipt(response, command.action.kind);
      throw new Error(`${taskHolderMethod(command)} did not return command-receipt/v2`);
    }
    const response = await client.request("repo.command.run", {
      repo: { repoId, canonicalRoot: command.rootDir },
      payload: commandRunPayload(command)
    });
    if (isCommandReceipt(response)) return response as unknown as CommandReceipt | CommandFailureReceipt;
    throw new Error("daemon command.run did not return command-receipt/v2");
  } finally {
    client.close();
  }
}

function daemonUnavailableReceipt(command: ParsedCommand, error: unknown, remote?: RemoteDaemonConfig): CommandFailureReceipt {
  const unavailableHint = remote
    ? remoteDaemonUnavailableHint(remote)
    : "Daemon unavailable. Start the daemon with 'ha daemon start --service' or check 'ha daemon status'.";
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(
      CliErrorCode.JournalUnavailable,
      `${unavailableHint} Cause: ${error instanceof Error ? error.message : String(error)}`
    )
  });
  if (receipt.ok) throw new Error("daemon unavailable receipt unexpectedly succeeded");
  return receipt;
}

function daemonActorAttributionReceipt(command: ParsedCommand, error: CliActorAttributionError): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(CliErrorCode.AuthMissing, error.message)
  });
  if (receipt.ok) throw new Error("daemon actor attribution receipt unexpectedly succeeded");
  return receipt;
}

function daemonRequestFailureReceipt(command: ParsedCommand, error: DaemonJsonRpcResponseError): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(CliErrorCode.WriteRejected, `Daemon JSON-RPC request failed (${error.code}): ${error.message}`)
  });
  if (receipt.ok) throw new Error("daemon request failure receipt unexpectedly succeeded");
  return receipt;
}

function readMode(value: string | undefined): DaemonClientMode {
  if (value === "direct" || value === "local" || value === "remote") return value;
  return "local";
}

function readDirectWriteReason(value: string | undefined): "recovery" | undefined {
  return value === "recovery" ? value : undefined;
}

function directModeRejection(command: ParsedCommand): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(
      CliErrorCode.JournalUnavailable,
      "Direct CLI execution is retired. Remove HARNESS_DAEMON_MODE=direct and use the daemon-backed CLI path. Only pre-initialization bootstrap and explicit operator recovery remain local; recovery requires HARNESS_DIRECT_WRITE_REASON=recovery."
    )
  });
  if (receipt.ok) throw new Error("direct-mode rejection unexpectedly succeeded");
  return receipt;
}

function isInitializedHarness(command: ParsedCommand): boolean {
  try {
    const canonicalRoot = resolveCanonicalHarnessRoot(createHarnessRuntimeContext(command.rootDir, command.layoutOverrides));
    const layout = resolveHarnessLayout(createHarnessRuntimeContext(canonicalRoot, command.layoutOverrides));
    return existsSync(path.join(layout.authoredRoot, "harness.yaml"));
  } catch {
    return false;
  }
}

export function remoteDaemonSshArgs(remote: RemoteDaemonConfig): ReadonlyArray<string> {
  return [remote.host, remote.remoteHaPath, "daemon", "connect", "--stdio"];
}

export function remoteDaemonUnavailableHint(remote: RemoteDaemonConfig): string {
  return `Remote daemon unavailable. Start the persistent daemon on ${remote.host} with '${remote.remoteHaPath} daemon start --service' and verify '${remote.remoteHaPath} daemon status'.`;
}

function commandForTarget(command: ParsedCommand, target: LocalDaemonTarget): ParsedCommand {
  return path.resolve(command.rootDir) === path.resolve(target.canonicalRoot)
    ? command
    : { ...command, rootDir: target.canonicalRoot };
}

function commandForCanonicalHarness(command: ParsedCommand): ParsedCommand {
  const canonicalRoot = resolveCanonicalHarnessRoot(createHarnessRuntimeContext(command.rootDir, command.layoutOverrides));
  return path.resolve(command.rootDir) === path.resolve(canonicalRoot)
    ? command
    : { ...command, rootDir: canonicalRoot };
}

export function daemonClientCliEntrypointPath(moduleUrl: string | URL = import.meta.url): string {
  const clientUrl = new URL(moduleUrl);
  const extension = path.posix.extname(clientUrl.pathname);
  if (extension !== ".ts" && extension !== ".js") {
    throw new Error(`unsupported daemon client module extension: ${extension || "<none>"}`);
  }
  return fileURLToPath(new URL(`../index${extension}`, clientUrl));
}

function readRemoteConfig(env: NodeJS.ProcessEnv): RemoteDaemonConfig {
  return {
    host: requiredEnv(env, "HARNESS_DAEMON_SSH_HOST"),
    remoteHaPath: env.HARNESS_DAEMON_REMOTE_HA ?? "ha",
    remoteRoot: requiredEnv(env, "HARNESS_DAEMON_REMOTE_ROOT"),
    repoId: env.HARNESS_DAEMON_REPO_ID ?? "canonical"
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} is required when HARNESS_DAEMON_MODE=remote`);
}

function isCommandReceipt(value: JsonObject): boolean {
  return value.schema === "command-receipt/v2" && typeof value.ok === "boolean" && typeof value.command === "string";
}

function isTaskHolderCommand(command: ParsedCommand): command is TaskHolderParsedCommand {
  return command.action.kind === "task-holder";
}

function isDocSyncSubmitCommand(command: ParsedCommand): boolean {
  return command.action.kind === "doc-sync" && command.action.mode === "submit";
}

function docSyncSubmitPaths(command: ParsedCommand): ReadonlyArray<string> {
  return command.action.kind === "doc-sync" && command.action.mode === "submit" ? command.action.paths : [];
}

function taskHolderMethod(_command: TaskHolderParsedCommand): "repo.task.holder" {
  return "repo.task.holder";
}

function taskHolderPayload(command: TaskHolderParsedCommand): JsonObject {
  const executor = taskHolderExecutorPayload(command);
  return {
    taskId: command.action.taskId,
    ...(executor !== undefined ? { executor } : {})
  };
}

export function commandRunPayload(command: ParsedCommand, session?: CurrentSessionRef): JsonObject {
  const executor = taskHolderExecutorPayload(command);
  const { actor: _localActorFlag, ...transportCommand } = command;
  return {
    command: transportCommand as unknown as JsonObject,
    ...(executor !== undefined ? { executor } : {}),
    ...(session !== undefined ? { session: session as unknown as JsonObject } : {})
  };
}

function taskHolderExecutorPayload(command: ParsedCommand): JsonObject | null | undefined {
  const executor = commandExecutor(command);
  return executor === undefined ? undefined : taskHolderExecutorJson(executor);
}

function commandExecutor(command: ParsedCommand): TaskHolderExecutor | null | undefined {
  const actor = command.actor
    ? readCliJournalActorFromFlag(command.actor)
    : readCliJournalActorFromEnv(process.env);
  if (!actor) return undefined;
  return taskHolderExecutorFromJournalActor(actor);
}

function taskHolderExecutorJson(executor: TaskHolderExecutor | null): JsonObject | null {
  return executor ? { kind: executor.kind, id: executor.id } : null;
}

function normalizeTaskHolderReceipt(response: JsonObject, commandKind: "task-holder"): CommandReceipt | CommandFailureReceipt {
  return {
    ...(response as unknown as CommandReceipt | CommandFailureReceipt),
    command: commandKind,
    action: commandKind.replace(/^task-/u, "task.")
  };
}

function normalizeDocSyncSubmitReceipt(response: JsonObject): CommandReceipt | CommandFailureReceipt {
  const receipt = response as unknown as CommandReceipt | CommandFailureReceipt;
  if (!receipt.ok) {
    return { ...receipt, command: "doc sync submit", action: "submit" };
  }
  const data = receipt.details?.data ?? {};
  return {
    ...receipt,
    command: "doc sync submit",
    action: "submit",
    details: {
      ...(receipt.details ?? {}),
      data: { report: data }
    }
  };
}

function docSyncSubmitPreviewRejected(error: unknown): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: "doc-sync-submit",
    error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
  });
  if (receipt.ok) throw new Error("doc sync preview rejection unexpectedly succeeded");
  return receipt;
}
