import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureTestHarnessIdentity } from "./git-fixtures.ts";

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
    await stopDaemonForRoot(rootDir);
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

export function stopDaemonQuietly(rootDir: string, userRoot: string): void {
  try {
    runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "1000", "--user-root", userRoot, "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
  } catch {
    // Best-effort cleanup for assertions that keep the daemon alive.
  }
}

export function defaultDaemonUserRoot(rootDir: string): string {
  return path.join(rootDir, ".daemon-user");
}

export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopDaemonForRoot(rootDir: string): Promise<void> {
  const pid = daemonPidFromStatus(rootDir);
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
  await waitForProcessExit(pid, 3_000);
}

function daemonPidFromStatus(rootDir: string): number | undefined {
  let status: Record<string, unknown>;
  try {
    status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
  } catch {
    return undefined;
  }
  if (typeof status.pid === "number" && Number.isSafeInteger(status.pid) && status.pid > 0) return status.pid;
  const daemonId = status.daemonId;
  if (typeof daemonId !== "string") return undefined;
  const match = /^ha-(\d+)$/u.exec(daemonId);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (isNoSuchProcess(error)) {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`daemon process ${pid} did not exit within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
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
      sleep(25 * (attempt + 1));
    }
  }
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
