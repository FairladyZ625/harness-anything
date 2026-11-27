import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cliOperationalPolicy,
  daemonRuntimePolicy,
} from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { writeFileDurably } from "../../../../storage/src/durable-file.ts";
import { readDistBuildId } from "../build-identity.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { ensureLocalDaemonRunning, type DaemonAutostartResult, type DaemonLaunchSpec } from "./daemon-autostart.ts";
import { requestDaemonJsonRpcAt } from "./local-json-rpc-client.ts";

const execFileAsync = promisify(execFile);

export const EDGE_UPGRADE_COMMAND = "ha edge upgrade" as const;
export const EDGE_UPGRADE_STATE_SCHEMA = "edge-upgrade-state/v1" as const;
export const EDGE_UPGRADE_RECEIPT_SCHEMA = "edge-upgrade-receipt/v1" as const;
export const DEFAULT_HANDOFF_TIMEOUT_MS: number = cliOperationalPolicy.defaultValue.waitMaximumMs;
export const DEFAULT_POLL_INTERVAL_MS: number = 200;
export const DEFAULT_SYNC_TIMEOUT_MS: number = cliOperationalPolicy.defaultValue.waitMaximumMs;
export const DEFAULT_RPC_CONNECT_TIMEOUT_MS: number = cliOperationalPolicy.defaultValue.daemon.streamTimeoutMs;
export const DEFAULT_RPC_RESPONSE_TIMEOUT_MS: number = daemonRuntimePolicy.defaultValue.daemon.shutdownDeadlineMs;
export const SUPERVISED_RESPAWN_GRACE_MS: number = cliOperationalPolicy.defaultValue.daemon.warmingPollMs * 10;
const MAX_INSTALLER_OUTPUT_CHARS = 8_192;
const COMMIT_HEX_PATTERN = /^[0-9a-f]{7,40}$/iu;
const DAEMON_RUNTIME_SCOPED_ENV_KEYS = [
  "HARNESS_ACTOR",
  "HARNESS_EXECUTION_CREDENTIAL",
  "HARNESS_EXECUTION_EXPIRES_AT",
  "HARNESS_DAEMON_ENDPOINT",
  "HARNESS_DAEMON_RELAY",
  "HARNESS_DAEMON_REMOTE_EDGE",
  "HARNESS_DAEMON_ID",
  "HARNESS_DAEMON_REPO_ID",
  "HARNESS_DAEMON_USER_ROOT",
] as const;

export type EdgeUpgradeStage =
  | "preflight"
  | "installing"
  | "handing_off"
  | "syncing"
  | "rolling_back"
  | "completed"
  | "rolled_back"
  | "failed";

export type EdgeUpgradeOutcome = OperationalStatus.EdgeUpgradeOutcome;

export interface EdgeUpgradeState {
  readonly schema: typeof EDGE_UPGRADE_STATE_SCHEMA;
  readonly installRoot: string;
  readonly previousCommit: string;
  readonly previousBranch: string | null;
  readonly targetCommit: string;
  readonly repoId: string | null;
  readonly updatedAt: string;
  readonly outcome: OperationalStatus.EdgeUpgradeStateOutcome;
}

export interface EdgeUpgradeProgress {
  readonly stage: EdgeUpgradeStage;
  readonly message: string;
  readonly fromCommit?: string | null;
  readonly targetCommit?: string | null;
}

export interface EdgeUpgradeRepoSyncResult {
  readonly repoId: string;
  readonly revision: number | null;
  readonly lagRevisions: number | null;
  readonly mirrorOutcome: string | null;
}

export interface EdgeUpgradeReceipt {
  readonly schema: typeof EDGE_UPGRADE_RECEIPT_SCHEMA;
  readonly ok: boolean;
  readonly command: "edge-upgrade";
  readonly outcome: EdgeUpgradeOutcome;
  readonly code?: string;
  readonly installRoot: string | null;
  readonly repoId: string | null;
  readonly fromCommit: string | null;
  readonly toCommit: string | null;
  readonly targetCommit: string | null;
  readonly daemonPid: number | null;
  readonly daemonBuildId: string | null;
  readonly daemonRestarted: boolean;
  readonly syncedRepos: readonly EdgeUpgradeRepoSyncResult[];
  readonly syncSkippedReason?: string;
  readonly rolledBack: boolean;
  readonly rollbackSyncOk?: boolean;
  readonly rollbackError?: string;
  readonly guiRestartRequired: boolean;
  readonly error?: { readonly code: string; readonly hint: string };
  readonly nextAction?: string;
}

export interface EdgeUpgradeStatusReport {
  readonly ok: boolean;
  readonly channel: "source";
  readonly installRoot: string | null;
  readonly repoId: string | null;
  readonly localCommit: string | null;
  readonly daemonCommit: string | null;
  readonly centerCommit: string | null;
  readonly centerCommitSource: string | null;
  readonly updateAvailable: boolean;
  readonly canRollback: boolean;
  readonly previousCommit: string | null;
  readonly reason?: string;
}

export interface EdgeUpgradeInstallerInvocation {
  readonly installRoot: string;
  readonly ref: string;
  readonly offline: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export interface EdgeUpgradeInstallerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EdgeUpgradeOptions {
  readonly toRef?: string;
  readonly offline?: boolean;
  readonly rollback?: boolean;
  readonly installRoot?: string;
  readonly rootDir?: string;
  readonly repoId?: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly socketPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly handoffTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly syncTimeoutMs?: number;
  readonly supervisedRespawnGraceMs?: number;
  readonly onProgress?: (progress: EdgeUpgradeProgress) => void;
  readonly runInstaller?: (invocation: EdgeUpgradeInstallerInvocation) => Promise<EdgeUpgradeInstallerResult>;
  readonly requestDaemonRpc?: (
    socketPath: string,
    method: string,
    params: JsonObject,
    timeoutMs?: number,
    responseTimeoutMs?: number,
    reportStaleBuild?: boolean,
  ) => Promise<JsonObject>;
  readonly ensureDaemonRunning?: (input: {
    readonly socketPath: string;
    readonly invokingRoot: string;
    readonly userRoot: string;
    readonly daemonId: string;
    readonly installRoot: string;
  }) => Promise<DaemonAutostartResult>;
  readonly runGit?: (
    installRoot: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly readDiskBuildId?: (installRoot: string) => string | null;
}

export class EdgeUpgradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeUpgradeError";
    this.code = code;
  }
}

export function edgeUpgradeStatePath(userRoot: string): string {
  return path.join(path.resolve(userRoot), "edge-upgrade-state.json");
}

export type CapturedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export function captureSync<T>(fn: () => T): CapturedResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function captureAsync<T>(fn: () => Promise<T>): Promise<CapturedResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function readEdgeUpgradeState(userRoot: string): EdgeUpgradeState | null {
  const file = edgeUpgradeStatePath(userRoot);
  if (!existsSync(file)) return null;
  const loaded = captureSync(() => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  if (!loaded.ok) return null;
  const parsed = loaded.value;
  if (
    parsed.schema !== EDGE_UPGRADE_STATE_SCHEMA ||
    typeof parsed.installRoot !== "string" ||
    typeof parsed.previousCommit !== "string" ||
    typeof parsed.targetCommit !== "string" ||
    typeof parsed.updatedAt !== "string"
  )
    return null;
  const outcome = parsed.outcome;
  if (outcome !== "in_progress" && outcome !== "upgraded" && outcome !== "rolled_back" && outcome !== "failed")
    return null;
  return {
    schema: EDGE_UPGRADE_STATE_SCHEMA,
    installRoot: parsed.installRoot,
    previousCommit: parsed.previousCommit,
    previousBranch: typeof parsed.previousBranch === "string" ? parsed.previousBranch : null,
    targetCommit: parsed.targetCommit,
    repoId: typeof parsed.repoId === "string" ? parsed.repoId : null,
    updatedAt: parsed.updatedAt,
    outcome,
  };
}

export function writeEdgeUpgradeState(userRoot: string, state: EdgeUpgradeState): void {
  writeFileDurably(edgeUpgradeStatePath(userRoot), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function isSourceInstallRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return (
    existsSync(path.join(resolved, ".git")) &&
    existsSync(path.join(resolved, "scripts", "install-source.sh")) &&
    existsSync(path.join(resolved, "scripts", "install-source.ps1"))
  );
}

export function resolveEdgeInstallRoot(options?: {
  readonly installRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly moduleUrl?: string;
  readonly homeDir?: string;
}): string | null {
  if (options?.installRoot?.trim()) {
    const explicit = path.resolve(options.installRoot.trim());
    return isSourceInstallRoot(explicit) ? explicit : null;
  }
  const env = options?.env ?? process.env;
  if (env.HARNESS_INSTALL_ROOT?.trim()) {
    const fromEnv = path.resolve(env.HARNESS_INSTALL_ROOT.trim());
    return isSourceInstallRoot(fromEnv) ? fromEnv : null;
  }
  const modulePath = fileURLToPath(options?.moduleUrl ?? import.meta.url);
  let cursor = path.dirname(modulePath);
  for (;;) {
    if (isSourceInstallRoot(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const home = options?.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const fallback = path.join(home, ".local", "share", "harness-anything");
  return isSourceInstallRoot(fallback) ? fallback : null;
}

export function parseCenterBuildCommitFromText(text: string): string | null {
  for (const pattern of [
    /\bcenter\s+build=([0-9a-f]{7,40})\b/iu,
    /\bcenter\s+build\s+([0-9a-f]{7,40})\b/iu,
    /\bcenter=([0-9a-f]{7,40})\b/iu,
  ]) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function commitsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const a = left.trim().toLowerCase(),
    b = right.trim().toLowerCase();
  if (a === b) return true;
  if (!COMMIT_HEX_PATTERN.test(a) || !COMMIT_HEX_PATTERN.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export function defaultReadDiskBuildId(installRoot: string): string | null {
  return readDistBuildId(path.join(installRoot, "packages", "daemon"));
}

export async function defaultRequestDaemonRpc(
  socketPath: string,
  method: string,
  params: JsonObject,
  timeoutMs: number = DEFAULT_RPC_CONNECT_TIMEOUT_MS,
  responseTimeoutMs: number = DEFAULT_RPC_RESPONSE_TIMEOUT_MS,
  reportStaleBuild = false,
): Promise<JsonObject> {
  return requestDaemonJsonRpcAt(
    socketPath,
    method,
    params,
    timeoutMs,
    responseTimeoutMs,
    undefined,
    reportStaleBuild,
    "edge-upgrade",
  );
}

export async function defaultEnsureDaemonRunning(
  input: {
    readonly socketPath: string;
    readonly invokingRoot: string;
    readonly userRoot: string;
    readonly daemonId: string;
    readonly installRoot: string;
  },
  env: NodeJS.ProcessEnv,
): Promise<DaemonAutostartResult> {
  const daemonEntry = path.join(input.installRoot, "packages", "daemon", "dist", "index.js");
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of DAEMON_RUNTIME_SCOPED_ENV_KEYS) delete childEnv[key];
  const launchSpec: DaemonLaunchSpec = {
    command: process.execPath,
    args: [daemonEntry, "serve", "--user-root", input.userRoot, "--daemon-id", input.daemonId],
    env: childEnv,
  };
  return ensureLocalDaemonRunning({
    socketPath: input.socketPath,
    invokingRoot: input.invokingRoot,
    launch: () => launchSpec,
  });
}

export async function defaultRunGit(
  installRoot: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync("git", ["-C", installRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function defaultRunSourceInstaller(
  invocation: EdgeUpgradeInstallerInvocation,
): Promise<EdgeUpgradeInstallerResult> {
  const scriptArgs = [...(invocation.offline ? ["--offline"] : []), "--ref", invocation.ref];
  const isWindows = process.platform === "win32";
  const command = isWindows ? "powershell.exe" : "bash";
  const args = isWindows
    ? [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(invocation.installRoot, "scripts", "install-source.ps1"),
        ...scriptArgs,
      ]
    : [path.join(invocation.installRoot, "scripts", "install-source.sh"), ...scriptArgs];
  const env: NodeJS.ProcessEnv = { ...invocation.env, HARNESS_INSTALL_ROOT: invocation.installRoot };
  return new Promise<EdgeUpgradeInstallerResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: invocation.installRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, String(chunk), MAX_INSTALLER_OUTPUT_CHARS);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, String(chunk), MAX_INSTALLER_OUTPUT_CHARS);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

export function extractDaemonBuildId(status: JsonObject | null): string | null {
  if (!status || !isRecord(status.build)) return null;
  if (typeof status.build.loadedBuildId === "string" && status.build.loadedBuildId) return status.build.loadedBuildId;
  if (typeof status.build.commit === "string" && status.build.commit) return status.build.commit;
  return null;
}

export function isDaemonDrifted(status: JsonObject | null): boolean {
  return Boolean(status && isRecord(status.build) && status.build.drifted === true);
}

export function failureReceipt(input: {
  readonly code: string;
  readonly hint: string;
  readonly installRoot: string | null;
  readonly repoId: string | null;
  readonly fromCommit?: string | null;
  readonly targetCommit?: string | null;
}): EdgeUpgradeReceipt {
  return {
    schema: EDGE_UPGRADE_RECEIPT_SCHEMA,
    ok: false,
    command: "edge-upgrade",
    outcome: "failed",
    code: input.code,
    installRoot: input.installRoot,
    repoId: input.repoId,
    fromCommit: input.fromCommit ?? null,
    toCommit: null,
    targetCommit: input.targetCommit ?? null,
    daemonPid: null,
    daemonBuildId: null,
    daemonRestarted: false,
    syncedRepos: [],
    rolledBack: false,
    guiRestartRequired: false,
    error: { code: input.code, hint: input.hint },
    nextAction: input.hint,
  };
}

export function asUpgradeError(error: unknown, fallbackCode: string): EdgeUpgradeError {
  if (error instanceof EdgeUpgradeError) return error;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : fallbackCode;
  return new EdgeUpgradeError(code, error instanceof Error ? error.message : String(error));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function tailText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}
