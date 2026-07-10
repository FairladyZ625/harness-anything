import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  taskHolderExecutorFromJournalActor,
  type TaskHolderExecutor
} from "../../../application/src/index.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  defaultDaemonAutostartTimeoutMs,
  defaultDaemonIdleExitMs,
  JsonRpcLineClient,
  currentDaemonProtocolVersion,
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget,
  type JsonObject,
  type LocalDaemonTarget
} from "../../../daemon/src/index.ts";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { CliActorAttributionError, readCliJournalActorFromEnv } from "../composition/actor-attribution.ts";
import { parsePositiveIntegerOr } from "../cli/value-utils.ts";

export {
  daemonIdForRoot,
  daemonIdForUserRoot,
  daemonIdFromEnv,
  daemonUserRoot,
  localDaemonSocketPath,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath,
  requestLocalDaemonJsonRpc,
  resolveLocalDaemonTarget,
  type LocalDaemonTarget
} from "../../../daemon/src/index.ts";

export type DaemonClientMode = "direct" | "local" | "remote";

export interface DaemonClientConfig {
  readonly mode: DaemonClientMode;
  readonly idleExitMs: number;
  readonly autostartTimeoutMs: number;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly remote?: RemoteDaemonConfig;
}

export interface RemoteDaemonConfig {
  readonly host: string;
  readonly remoteHaPath: string;
  readonly remoteRoot: string;
  readonly repoId: string;
}

type TaskHolderParsedCommand = ParsedCommand & {
  readonly action:
    | { readonly kind: "task-claim"; readonly taskId: string; readonly ttlMs?: number }
    | { readonly kind: "task-holder"; readonly taskId: string }
    | { readonly kind: "task-release"; readonly taskId: string };
};

export function readDaemonClientConfig(env: NodeJS.ProcessEnv = process.env): DaemonClientConfig {
  const mode = readMode(env.HARNESS_DAEMON_MODE);
  const userRoot = daemonUserRoot(env);
  return {
    mode,
    idleExitMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_IDLE_MS, defaultDaemonIdleExitMs),
    autostartTimeoutMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS, defaultDaemonAutostartTimeoutMs),
    userRoot,
    daemonId: daemonIdFromEnv(env),
    ...(mode === "remote" ? { remote: readRemoteConfig(env) } : {})
  };
}

export async function runCommandThroughDaemon(
  command: ParsedCommand,
  config: DaemonClientConfig = readDaemonClientConfig()
): Promise<CommandReceipt | CommandFailureReceipt | undefined> {
  if (config.mode === "direct") return undefined;
  try {
    return config.mode === "remote" && config.remote
      ? await runRemoteCommand(command, config.remote)
      : await runLocalCommand(command, config);
  } catch (error) {
    if (error instanceof CliActorAttributionError) {
      return daemonActorAttributionReceipt(command, error);
    }
    return daemonUnavailableReceipt(command, error, config.mode === "remote" ? config.remote : undefined);
  }
}

async function runLocalCommand(command: ParsedCommand, config: DaemonClientConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const target = resolveLocalDaemonTarget({
    rootDir: command.rootDir,
    repoIdOverride: command.daemonRepoId,
    userRoot: config.userRoot,
    daemonId: config.daemonId,
    autoRegisterSingleRepo: true
  });
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
    payload: commandRunPayload(commandForTarget(command, target))
  }, 200, {
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
    command: command.action.kind,
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
    command: command.action.kind,
    error: cliError(CliErrorCode.AuthMissing, error.message)
  });
  if (receipt.ok) throw new Error("daemon actor attribution receipt unexpectedly succeeded");
  return receipt;
}

function readMode(value: string | undefined): DaemonClientMode {
  if (value === "direct" || value === "local" || value === "remote") return value;
  return "direct";
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

function daemonClientCliEntrypointPath(): string {
  return fileURLToPath(import.meta.url).replace(/\/daemon\/client\.(ts|js)$/u, "/index.$1");
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
  return command.action.kind === "task-claim" || command.action.kind === "task-holder" || command.action.kind === "task-release";
}

function taskHolderMethod(command: TaskHolderParsedCommand): "repo.task.claim" | "repo.task.holder" | "repo.task.release" {
  if (command.action.kind === "task-claim") return "repo.task.claim";
  if (command.action.kind === "task-holder") return "repo.task.holder";
  return "repo.task.release";
}

function taskHolderPayload(command: TaskHolderParsedCommand): JsonObject {
  const executor = taskHolderExecutorPayload();
  return {
    taskId: command.action.taskId,
    ...(executor !== undefined ? { executor } : {}),
    ...(command.action.kind === "task-claim" && command.action.ttlMs ? { ttlMs: command.action.ttlMs } : {})
  };
}

function commandRunPayload(command: ParsedCommand): JsonObject {
  const executor = taskHolderExecutorPayload();
  return {
    command: command as unknown as JsonObject,
    ...(executor !== undefined ? { executor } : {})
  };
}

function taskHolderExecutorPayload(): JsonObject | null | undefined {
  const actor = readCliJournalActorFromEnv(process.env);
  if (!actor) return undefined;
  return taskHolderExecutorJson(taskHolderExecutorFromJournalActor(actor));
}

function taskHolderExecutorJson(executor: TaskHolderExecutor | null): JsonObject | null {
  return executor ? { kind: executor.kind, id: executor.id } : null;
}

function normalizeTaskHolderReceipt(response: JsonObject, commandKind: "task-claim" | "task-holder" | "task-release"): CommandReceipt | CommandFailureReceipt {
  return {
    ...(response as unknown as CommandReceipt | CommandFailureReceipt),
    command: commandKind,
    action: commandKind.replace(/^task-/u, "task.")
  };
}
