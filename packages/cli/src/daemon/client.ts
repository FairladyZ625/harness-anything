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
  DaemonJsonRpcRequestTimeoutError,
  DaemonRepoRootResolutionError,
  DaemonJsonRpcResponseError,
  defaultDaemonAutostartTimeoutMs,
  defaultDaemonIdleExitMs,
  defaultDaemonJsonRpcRequestTimeoutMs,
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
import {
  classifyLocalDaemonLifecycle,
  daemonUnavailableReceipt,
  directRecoveryCommandLine
} from "./daemon-lifecycle-classification.ts";

export { classifyLocalDaemonLifecycle, directRecoveryCommandLine };
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { CliActorAttributionError, readCliJournalActorFromEnv, readCliJournalActorFromFlag } from "../composition/actor-attribution.ts";
import { configuredLocalPrincipalIdForActorHint } from "../composition/local-principal.ts";
import { parsePositiveIntegerOr } from "../cli/value-utils.ts";
import { buildDocSyncSubmitRequest } from "@harness-anything/daemon";
import {
  artifactAddSuccess,
  artifactIngestPreviewRejected,
  buildArtifactIngestPlan,
  normalizeArtifactSubmitFailure,
  normalizeProgressAfterArtifact,
  remoteArtifactSafetyReceipt,
  type ArtifactIngestPlan
} from "./artifact-ingest.ts";
import {
  resolveDeclaredManagedSectionPolicy,
  resolveManagedSectionPolicy
} from "../commands/extensions/managed-section-policy.ts";

const docSyncHostServices = { resolveDeclaredManagedSectionPolicy, resolveManagedSectionPolicy };
import { readProjectHarnessSettings } from "../commands/settings.ts";
import { readRemoteConfig, remoteDaemonSshArgs, type RemoteDaemonConfig } from "./remote-config.ts";
import { isDeclaredLocalMigrationCommand } from "../composition/local-write-scope.ts";
import { startCliTimingPhase } from "../cli/timing.ts";
import { daemonRequestTimeoutReceipt } from "./request-outcome.ts";
import { daemonAutostartOptions, daemonTimingObserver } from "./client-timing.ts";
import {
  CliRootResolutionError,
  commandForRootResolution,
  resolveCommandRoot,
  withRootResolution
} from "./root-resolution.ts";
import { rootResolutionUnavailableReceipt } from "./root-resolution-receipt.ts";
import { normalizeDocSyncSubmitReceipt } from "../composition/doc-sync-submit-receipt.ts";

export { normalizeDocSyncSubmitReceipt } from "../composition/doc-sync-submit-receipt.ts";

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

export {
  remoteDaemonSshArgs,
  remoteDaemonUnavailableHint,
  type RemoteDaemonConfig
} from "./remote-config.ts";

export type DaemonClientMode = "direct" | "local" | "remote";

export interface DaemonClientConfig {
  readonly mode: DaemonClientMode;
  readonly modeExplicit: boolean;
  readonly idleExitMs: number;
  readonly autostartTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly directWriteReason?: "recovery";
  readonly remote?: RemoteDaemonConfig;
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
    requestTimeoutMs: parsePositiveIntegerOr(env.HARNESS_DAEMON_REQUEST_TIMEOUT_MS, defaultDaemonJsonRpcRequestTimeoutMs),
    userRoot,
    daemonId: daemonIdFromEnv(env),
    ...(directWriteReason ? { directWriteReason } : {}),
    ...(mode === "remote" ? { remote: readRemoteConfig(env, rootDir, projectSettings, layoutOverrides) } : {})
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
  const finishConfig = startCliTimingPhase("daemon_config");
  try {
    const configRoot = resolveCommandRoot(command).root;
    config ??= readDaemonClientConfig(process.env, configRoot, command.daemonModeOverride, command.daemonProfileOverride, command.layoutOverrides);
  } catch (error) {
    return daemonUnavailableReceipt(command, error);
  } finally {
    finishConfig();
  }
  if (config.mode !== "remote" && command.action.kind === "init" && !isInitializedHarness(command)) return undefined;
  if (config.mode !== "remote" && isDeclaredLocalMigrationCommand(command.action)) return undefined;
  if (config.mode === "direct") {
    if (config.directWriteReason === "recovery") return undefined;
    return directModeRejection(command);
  }
  if (config.mode === "remote" && config.remote) {
    const artifactSafety = remoteArtifactSafetyReceipt(command, config.remote.repoId);
    if (artifactSafety) return artifactSafety;
  }
  try {
    return config.mode === "remote" && config.remote
      ? await runTimedRemoteCommand(command, config.remote)
      : await runLocalCommand(command, config);
  } catch (error) {
    if (command.action.kind === "materializer-run" && config.mode === "local" && !(error instanceof DaemonJsonRpcResponseError)) {
      return undefined;
    }
    if (error instanceof DaemonJsonRpcRequestTimeoutError) {
      return daemonRequestTimeoutReceipt(command, error);
    }
    if (error instanceof CliActorAttributionError) {
      return daemonActorAttributionReceipt(command, error);
    }
    if (error instanceof DaemonJsonRpcResponseError) {
      return daemonRequestFailureReceipt(command, error);
    }
    if (error instanceof CliRootResolutionError) {
      return rootResolutionUnavailableReceipt(command, error);
    }
    return daemonUnavailableReceipt(command, error, config.mode === "remote" ? config.remote : undefined);
  }
}

async function runLocalCommand(command: ParsedCommand, config: DaemonClientConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const finishTarget = startCliTimingPhase("daemon_target");
  let rootResolution = resolveCommandRoot(command);
  command = commandForRootResolution(command, rootResolution);
  let target: LocalDaemonTarget;
  try {
    target = resolveLocalDaemonTarget({
      rootDir: command.rootDir,
      repoIdOverride: command.daemonRepoId,
      userRoot: config.userRoot,
      daemonId: config.daemonId,
      autoRegisterSingleRepo: true,
      layoutOverrides: command.layoutOverrides
    });
  } catch (error) {
    if (error instanceof DaemonRepoRootResolutionError) throw new CliRootResolutionError(rootResolution, error);
    throw error;
  }
  rootResolution = {
    ...rootResolution,
    root: target.canonicalRoot,
    ...(command.daemonRepoId ? { source: "explicit-override" as const } : {})
  };
  finishTarget();
  const timing = daemonTimingObserver();
  const autostart = daemonAutostartOptions(command, config, timing.observe, daemonClientCliEntrypointPath());
  try {
    let artifactPlan: ArtifactIngestPlan | null;
    try {
      artifactPlan = buildArtifactIngestPlan({
        command,
        repoId: target.repoId,
        executor: commandExecutor(command),
        session: Effect.runSync(makeEnvironmentCurrentSessionProbe().currentSession)
      });
    } catch (error) {
      return withRootResolution(artifactIngestPreviewRejected(command, error), rootResolution);
    }
    let artifactReport: unknown;
    if (artifactPlan?.request) {
      const artifactResponse = await requestLocalDaemonJsonRpcForTarget(target, "repo.doc.sync.submit", artifactPlan.request as unknown as JsonObject, 200, autostart);
      if (!isCommandReceipt(artifactResponse)) throw new Error("repo.doc.sync.submit did not return command-receipt/v2");
      if (!artifactResponse.ok) return withRootResolution(normalizeArtifactSubmitFailure(artifactResponse, artifactPlan), rootResolution);
      artifactReport = (artifactResponse as unknown as CommandReceipt).details?.data;
    }
    if (artifactPlan?.facade === "artifact-add") {
      return withRootResolution(artifactAddSuccess(artifactPlan, artifactReport), rootResolution);
    }
    if (artifactPlan?.progressCommand) command = artifactPlan.progressCommand;
    if (isDocSyncSubmitCommand(command)) {
      let request: ReturnType<typeof buildDocSyncSubmitRequest>;
      try {
        request = buildDocSyncSubmitRequest(
          { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides },
          target.repoId,
          docSyncSubmitPaths(command),
          commandExecutor(command),
          docSyncHostServices,
          Effect.runSync(makeEnvironmentCurrentSessionProbe().currentSession)
        );
      } catch (error) {
        return withRootResolution(docSyncSubmitPreviewRejected(error), rootResolution);
      }
      const response = await requestLocalDaemonJsonRpcForTarget(target, "repo.doc.sync.submit", request as unknown as JsonObject, 200, autostart);
      if (isCommandReceipt(response)) return withRootResolution(normalizeDocSyncSubmitReceipt(response), rootResolution);
      throw new Error("repo.doc.sync.submit did not return command-receipt/v2");
    }
    if (isTaskHolderCommand(command)) {
      const response = await requestLocalDaemonJsonRpcForTarget(target, taskHolderMethod(command), {
        repo: { repoId: target.repoId },
        payload: taskHolderPayload(command)
      }, 200, autostart);
      if (isCommandReceipt(response)) return withRootResolution(normalizeTaskHolderReceipt(response, command.action.kind), rootResolution);
      throw new Error(`${taskHolderMethod(command)} did not return command-receipt/v2`);
    }
    const response = await requestLocalDaemonJsonRpcForTarget(target, "repo.command.run", {
      repo: { repoId: target.repoId },
      payload: commandRunPayload(
        commandForTarget(command, target),
        Effect.runSync(makeEnvironmentCurrentSessionProbe().currentSession)
      )
    }, 200, command.action.kind === "materializer-run" ? undefined : autostart);
    if (isCommandReceipt(response)) {
      const receipt = response as unknown as CommandReceipt | CommandFailureReceipt;
      return withRootResolution(
        artifactPlan?.facade === "progress-append"
          ? normalizeProgressAfterArtifact(receipt, artifactPlan, artifactReport)
          : receipt,
        rootResolution
      );
    }
    throw new Error("daemon command.run did not return command-receipt/v2");
  } finally {
    timing.finish();
  }
}

async function runTimedRemoteCommand(command: ParsedCommand, remote: RemoteDaemonConfig): Promise<CommandReceipt | CommandFailureReceipt> {
  const finish = startCliTimingPhase("command_execute");
  try {
    return await runRemoteCommand(command, remote);
  } finally {
    finish();
  }
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
        request = buildDocSyncSubmitRequest(
          command.rootDir,
          repoId,
          docSyncSubmitPaths(command),
          commandExecutor(command),
          docSyncHostServices,
          Effect.runSync(makeEnvironmentCurrentSessionProbe().currentSession)
        );
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
      CliErrorCode.DaemonBackedPathRequired,
      `Direct CLI execution is reserved for operator recovery when the daemon is unavailable or stuck. For the normal single-writer path, remove HARNESS_DAEMON_MODE=direct. To run this command through the recovery escape hatch, use '${directRecoveryCommandLine()}'.`
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

function commandForTarget(command: ParsedCommand, target: LocalDaemonTarget): ParsedCommand {
  return path.resolve(command.rootDir) === path.resolve(target.canonicalRoot)
    ? command
    : { ...command, rootDir: target.canonicalRoot };
}

export function daemonClientCliEntrypointPath(moduleUrl: string | URL = import.meta.url): string {
  const clientUrl = new URL(moduleUrl);
  const extension = path.posix.extname(clientUrl.pathname);
  if (extension !== ".ts" && extension !== ".js") {
    throw new Error(`unsupported daemon client module extension: ${extension || "<none>"}`);
  }
  return fileURLToPath(new URL(`../index${extension}`, clientUrl));
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
  const { actor: _localActorFlag, rootResolutionSource: _localRootResolutionSource, ...transportCommand } = command;
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
    ? readCliJournalActorFromFlag(command.actor, configuredLocalPrincipalIdForActorHint({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides
    }, process.env))
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


function docSyncSubmitPreviewRejected(error: unknown): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: "doc-sync-submit",
    error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
  });
  if (receipt.ok) throw new Error("doc sync preview rejection unexpectedly succeeded");
  return receipt;
}
