import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget
} from "../../../daemon/src/client/local-json-rpc-client.ts";

export async function withGuiDaemonEnv<T>(
  rootDir: string,
  run: () => Promise<T>,
  options: { readonly idleMs?: string } = {}
): Promise<T> {
  const previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT;
  const previousIdleMs = process.env.HARNESS_DAEMON_IDLE_MS;
  const previousAutostartTimeout = process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS;
  process.env.HARNESS_DAEMON_USER_ROOT = path.join(rootDir, "user-daemon");
  process.env.HARNESS_DAEMON_IDLE_MS = options.idleMs ?? "250";
  // Cold daemon spawn on a loaded CI runner regularly exceeds the 6s
  // interactive default; the hermetic tests care about correctness, not
  // interactive latency.
  process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS ||= "30000";
  try {
    return await run();
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousUserRoot);
    restoreEnv("HARNESS_DAEMON_IDLE_MS", previousIdleMs);
    restoreEnv("HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS", previousAutostartTimeout);
  }
}

export function writeExecutionEvidence(
  rootDir: string,
  title: string,
  writeTaskIndex: (rootDir: string, taskId: string, title: string, status: string) => void
): void {
  const taskId = "task_01KXDG00000000000000000002";
  const executionId = "exe_01KXDG00000000000000000002";
  writeTaskIndex(rootDir, taskId, title, "in_review");
  const executionRoot = path.join(rootDir, "harness/tasks", taskId, "executions");
  mkdirSync(executionRoot, { recursive: true });
  writeFileSync(path.join(executionRoot, `${executionId}.md`), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person_test" },
      executor: { kind: "agent", id: "codex" },
      responsibleHuman: "person_test"
    },
    claimed_at: "2026-07-13T00:00:00.000Z",
    submitted_at: "2026-07-13T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [{
      evidence_id: "ev_gui_generation",
      execution_ref: `execution/${taskId}/${executionId}`,
      locator: { substrate: "inline", text: "GUI evidence" }
    }],
    submission: null
  }, null, 2)}\n`, "utf8");
}

export function initAuthoredGit(rootDir: string): void {
  const authoredRoot = path.join(rootDir, "harness");
  execFileSync("git", ["-C", authoredRoot, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", authoredRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", authoredRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", authoredRoot, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", authoredRoot, "commit", "-m", "fixture"], { stdio: "ignore" });
}

export async function readDaemonStatus(rootDir: string): Promise<Record<string, unknown>> {
  const target = resolveLocalDaemonTarget({
    rootDir,
    userRoot: daemonUserRoot(),
    daemonId: daemonIdFromEnv(),
    autoRegisterSingleRepo: false
  });
  return await requestLocalDaemonJsonRpcForTarget(target, "repo.daemon.status", {
    repo: { repoId: target.repoId }
  }, 1_000);
}

export function daemonPidFromStatus(status: Record<string, unknown>): number | undefined {
  const daemonId = status.daemonId;
  if (typeof daemonId !== "string") return undefined;
  const match = /^ha-(\d+)$/u.exec(daemonId);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function daemonStatusData(receipt: Record<string, unknown>): Record<string, unknown> {
  const details = receipt.details;
  const data = details && typeof details === "object" && "data" in details
    ? (details as { readonly data?: unknown }).data
    : undefined;
  assert.equal(receipt.ok, true);
  assert.equal(typeof data, "object");
  assert.notEqual(data, null);
  assert.equal(Array.isArray(data), false);
  return data as Record<string, unknown>;
}

export async function stopDaemonProcess(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    throw error;
  }
  await waitForProcessExit(pid, 2_000);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ESRCH";
}
