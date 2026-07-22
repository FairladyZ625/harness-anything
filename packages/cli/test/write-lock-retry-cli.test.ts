// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const execFileAsync = promisify(execFile);
const WRITE_LOCK_TEST_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_WRITE_LOCK_TIMEOUT_MS", 60_000);
const LOCK_WAIT_BARRIER_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_LOCK_WAIT_BARRIER_TIMEOUT_MS", 15_000);

test("CLI waits through transient global write lock conflicts", { timeout: WRITE_LOCK_TEST_TIMEOUT_MS }, async (t) => {
  await withTempRoot(async (rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const lockDir = path.join(rootDir, ".harness/locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "global.lock"), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "fixture-live-writer"
    }), "utf8");
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    const journalBefore = readIfPresent(journalPath);

    const pending = runJsonAsync(rootDir, ["task", "progress", "append", taskId, "--text", "after transient lock"])
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    await waitForEvent(
      () => readIfPresent(journalPath) !== journalBefore && existsSync(path.join(lockDir, "global.lock")),
      LOCK_WAIT_BARRIER_TIMEOUT_MS,
      "request to enter global lock wait"
    );
    assert.doesNotMatch(
      readIfPresent(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`)),
      /after transient lock/u
    );
    t.diagnostic("lock-wait barrier reached; releasing fixture lock");
    rmSync(path.join(lockDir, "global.lock"), { force: true });

    const settled = await pending;
    if (!settled.ok) throw settled.error;
    assert.equal(settled.value.ok, true);
    assert.equal(settled.value.path, "progress.md");
    assert.equal(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), "# Progress\n\n## Entries\n\nafter transient lock\n");
  });
});

test("lock-wait barrier fails closed when the event never occurs", { timeout: WRITE_LOCK_TEST_TIMEOUT_MS }, async (t) => {
  await assert.rejects(
    waitForEvent(() => false, 100, "injected lock-wait event"),
    /timed out waiting for injected lock-wait event/u
  );
  t.diagnostic("negative control: injected lock-wait event timed out instead of hanging");
});

async function withTempRoot<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-lock-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

async function runJsonAsync(rootDir: string, args: ReadonlyArray<string>): Promise<Record<string, any>> {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function readIfPresent(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function waitForEvent(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
