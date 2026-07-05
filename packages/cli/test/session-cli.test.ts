import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const cleanRuntimeEnv = {
  CLAUDE_CODE_SESSION_ID: "",
  CLAUDE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
} as const;

test("CLI session export binds CODEX_THREAD_ID and commits managed session markdown", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);

    const exported = runJson(rootDir, ["session", "export"], true, {
      CODEX_THREAD_ID: "019f28de-f7f6-7223-a2a8-b2968686fe21",
      CODEX_SESSION_ID: "legacy-session-id"
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.command, "session-export");
    assert.equal(exported.paths.primary, "harness/sessions/019f28de-f7f6-7223-a2a8-b2968686fe21.md");
    assert.equal(exported.report.session.sessionId, "019f28de-f7f6-7223-a2a8-b2968686fe21");
    assert.equal(exported.report.git.committed, true);
    assert.match(readFileSync(path.join(rootDir, exported.paths.primary), "utf8"), /sessionId: 019f28de-f7f6-7223-a2a8-b2968686fe21/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session sync commits existing untracked session exports", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "sessions"), { recursive: true });
    initHarnessGit(harnessRoot);
    writeFileSync(path.join(harnessRoot, "sessions", "manual-session.md"), [
      "---",
      "schema: provenance-session/v1",
      "sessionId: manual-session",
      "runtime: human",
      "source: manual",
      "detectedAt: 2026-07-04T00:00:00.000Z",
      "exportedAt: 2026-07-04T00:00:00.000Z",
      "---",
      "",
      "# Session manual-session",
      ""
    ].join("\n"));

    const synced = runJson(rootDir, ["session", "sync"]);

    assert.equal(synced.ok, true);
    assert.equal(synced.command, "session-sync");
    assert.equal(synced.rows, 1);
    assert.equal(synced.report.git.committed, true);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session backfill discovers Codex runtime logs and commits exports", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const homeDir = path.join(rootDir, "home");
    mkdirSync(path.join(homeDir, ".codex", "sessions"), { recursive: true });
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);
    writeFileSync(path.join(homeDir, ".codex", "sessions", "rollout-2026-07-04T00-00-00-codex-thread-backfill.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Backfill this Codex thread." }
      }),
      ""
    ].join("\n"));

    const backfilled = runJson(rootDir, ["session", "backfill", "--runtime", "codex", "--limit", "1"], true, {
      HOME: homeDir
    });

    assert.equal(backfilled.ok, true);
    assert.equal(backfilled.command, "session-backfill");
    assert.equal(backfilled.rows, 1);
    assert.equal(backfilled.report.exported[0].session.sessionId, "codex-thread-backfill");
    assert.equal(backfilled.report.git.committed, true);
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "codex-thread-backfill.md"), "utf8"), /Backfill this Codex thread/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session backfill discovers ZCode runtime logs and commits exports", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const homeDir = path.join(rootDir, "home");
    mkdirSync(path.join(homeDir, ".zcode", "cli", "rollout"), { recursive: true });
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);
    writeFileSync(path.join(homeDir, ".zcode", "cli", "rollout", "model-io-sess_zcode-thread-backfill.jsonl"), [
      JSON.stringify({
        startedAt: "2026-07-04T00:00:00.000Z",
        type: "model_io",
        querySource: "main_turn",
        request: { body: { messages: [{ role: "user", content: [{ type: "text", text: "Backfill this ZCode thread." }] }] } },
        response: { text: "ZCode backfill response." }
      }),
      ""
    ].join("\n"));

    const backfilled = runJson(rootDir, ["session", "backfill", "--runtime", "zcode", "--limit", "1"], true, {
      HOME: homeDir
    });

    assert.equal(backfilled.ok, true);
    assert.equal(backfilled.command, "session-backfill");
    assert.equal(backfilled.rows, 1);
    assert.equal(backfilled.report.exported[0].session.sessionId, "sess_zcode-thread-backfill");
    assert.equal(backfilled.report.git.committed, true);
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "sess_zcode-thread-backfill.md"), "utf8"), /Backfill this ZCode thread/u);
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "sess_zcode-thread-backfill.md"), "utf8"), /ZCode backfill response/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-session-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...cleanRuntimeEnv, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function initHarnessGit(harnessRoot: string): void {
  execFileSync("git", ["-C", harnessRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}
