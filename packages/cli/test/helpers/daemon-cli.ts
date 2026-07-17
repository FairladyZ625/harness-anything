import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { localUserDaemonEndpoint } from "../../../daemon/src/index.ts";
import { ensureTestHarnessIdentity } from "./git-fixtures.ts";
import { delay, pollUntil } from "./poll-until.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const execFileAsync = promisify(execFile);

export function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return fn(rootDir);
  } finally {
    removeTempRootSync(rootDir);
  }
}

export async function withTempRootAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return await fn(rootDir);
  } finally {
    await stopDaemon(rootDir);
    await removeTempRoot(rootDir);
  }
}

export function runRawJson(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  if (args[0] === "init") ensureTestHarnessIdentity(rootDir);
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: daemonTestEnv(rootDir, env)
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export function runRawJsonMaybeFail(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): { readonly status: number | null; readonly receipt: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: daemonTestEnv(rootDir, env)
  });
  assert.equal(result.stderr, "");
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as Record<string, unknown>
  };
}

export async function runRawJsonAsync(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: daemonTestEnv(rootDir, env)
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export function runDaemonCommand(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: daemonTestEnv(rootDir, { HARNESS_DAEMON_MODE: "direct", ...env })
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export function defaultDaemonUserRoot(rootDir: string): string {
  return path.join(rootDir, ".daemon-user");
}

export { delay, pollUntil } from "./poll-until.ts";

export async function stopDaemon(rootDir: string, userRoot = defaultDaemonUserRoot(rootDir)): Promise<void> {
  const endpoint = localUserDaemonEndpoint(userRoot);
  const ownerPath = daemonOwnerPath(endpoint);
  const before = daemonStatus(rootDir, userRoot);
  const pid = daemonPid(before) ?? daemonOwnerPid(ownerPath);
  if (pid === undefined && !existsSync(endpoint) && !existsSync(ownerPath)) return;

  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  } else {
    runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "5000", "--user-root", userRoot, "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
  }

  await pollUntil(
    () => ({
      processAlive: pid === undefined ? false : processIsAlive(pid),
      socketExists: process.platform === "win32" ? false : existsSync(endpoint),
      ownerExists: existsSync(ownerPath)
    }),
    (state) => !state.processAlive && !state.socketExists && !state.ownerExists,
    (state, error) => JSON.stringify({ pid, endpoint, ownerPath, state, error: errorMessage(error) }),
    { timeoutMs: 8_000 }
  );
}

function daemonStatus(rootDir: string, userRoot: string): Record<string, unknown> | undefined {
  try {
    return runDaemonCommand(rootDir, ["daemon", "status", "--user-root", userRoot, "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
  } catch {
    return undefined;
  }
}

function daemonPid(status: Record<string, unknown> | undefined): number | undefined {
  if (!status) return undefined;
  if (typeof status.pid === "number" && Number.isSafeInteger(status.pid) && status.pid > 0) return status.pid;
  const daemonId = status.daemonId;
  if (typeof daemonId !== "string") return undefined;
  const match = /^ha-(\d+)$/u.exec(daemonId);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function daemonOwnerPid(ownerPath: string): number | undefined {
  if (!existsSync(ownerPath)) return undefined;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { readonly pid?: unknown };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined;
  } catch {
    return undefined;
  }
}

function daemonOwnerPath(endpoint: string): string {
  if (process.platform !== "win32") return `${endpoint}.owner`;
  const endpointDigest = createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
  return path.join(tmpdir(), `harness-anything-daemon-${endpointDigest}.owner`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
}

async function removeTempRoot(rootDir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetriableRemoveError(error) || attempt === 7) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

function removeTempRootSync(rootDir: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetriableRemoveError(error) || attempt === 7) throw error;
      waitBeforeRemoveRetry(25 * (attempt + 1));
    }
  }
}

function waitBeforeRemoveRetry(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function daemonTestEnv(rootDir: string, env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const homeDir = path.join(rootDir, ".home");
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_ACTOR: "agent:daemon-cli-test",
    HARNESS_GIT_AUTHOR_NAME: "Harness Test",
    HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
    HARNESS_DAEMON_USER_ROOT: defaultDaemonUserRoot(rootDir),
    HARNESS_AUTHORITY_MANIFEST: "",
    CLAUDE_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
    ZCODE_SESSION_ID: "",
    ANTIGRAVITY_SESSION_ID: "",
    ...(env.HARNESS_DAEMON_MODE === "direct" ? { HARNESS_DIRECT_WRITE_REASON: "test" } : {}),
    ...env
  };
}

function isRetriableRemoveError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ["ENOTEMPTY", "EBUSY", "EPERM"].includes(String((error as { readonly code?: unknown }).code));
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ESRCH";
}

function errorMessage(error: unknown): string | undefined {
  return error === undefined ? undefined : error instanceof Error ? error.message : String(error);
}
