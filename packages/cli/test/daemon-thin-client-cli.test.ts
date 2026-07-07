import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const execFileAsync = promisify(execFile);

test("daemon client mode preserves command receipt output shape against direct mode", () => {
  withTempRoot((rootDir) => {
    const direct = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "direct" }));
    const daemon = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" }));

    assert.deepEqual(daemon, direct);
  });
});

test("daemon client auto-starts, durably writes, and exits after idle", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });
    const created = runRawJson(rootDir, ["new-task", "--title", "Daemon Client Write"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });

    assert.equal(created.ok, true);
    assert.equal(created.schema, "command-receipt/v2");
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), true);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/u);

    sleep(700);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, false);
  });
});

test("concurrent daemon client startup converges on one lock owner and both clients continue", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" });

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" }),
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, true);
    assert.equal(typeof status.pid, "number");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withTempRootAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-"));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runRawJson(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runRawJsonAsync(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runDaemonCommand(rootDir: string, args: ReadonlyArray<string>): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_DAEMON_MODE: "direct" }
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function normalizeVolatileReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(receipt.meta) ? { ...receipt.meta } : undefined;
  if (meta) delete meta.generatedAt;
  return {
    ...receipt,
    ...(meta ? { meta } : {})
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
