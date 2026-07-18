// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const execFileAsync = promisify(execFile);

test("CLI waits through transient global write lock conflicts", async () => {
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

    const pending = runJsonAsync(rootDir, ["task", "progress", "append", taskId, "--text", "after transient lock"])
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    await delay(2_500);
    rmSync(path.join(lockDir, "global.lock"), { force: true });

    const settled = await pending;
    if (!settled.ok) throw settled.error;
    assert.equal(settled.value.ok, true);
    assert.equal(settled.value.path, "progress.md");
    assert.equal(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), "# Progress\n\n## Entries\n\nafter transient lock\n");
  });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
