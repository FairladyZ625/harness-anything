import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const testActorEnv = { HARNESS_ACTOR: "agent:session-cli-test" } as const;

test("CLI session export binds CODEX_THREAD_ID and writes managed session markdown through the journal", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const transcriptFile = path.join(rootDir, "desktop-thread.jsonl");
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);
    writeFileSync(transcriptFile, [
      JSON.stringify({
        timestamp: "2026-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Desktop transcript passed explicitly." }
      }),
      ""
    ].join("\n"));

    const exported = runJson(rootDir, ["session", "export", "--transcript-file", transcriptFile], true, {
      CODEX_THREAD_ID: "019f28de-f7f6-7223-a2a8-b2968686fe21",
      CODEX_SESSION_ID: "legacy-session-id"
    });

    assert.equal(exported.ok, true);
    assert.equal(exported.command, "session-export");
    assert.equal(exported.paths.primary, "harness/sessions/019f28de-f7f6-7223-a2a8-b2968686fe21.md");
    assert.equal(exported.report.session.sessionId, "019f28de-f7f6-7223-a2a8-b2968686fe21");
    assert.equal(exported.report.git.committed, true);
    assert.equal(exported.report.git.coordinator, "write-journal");
    const body = readFileSync(path.join(rootDir, exported.paths.primary), "utf8");
    assert.match(body, /sessionId: 019f28de-f7f6-7223-a2a8-b2968686fe21/u);
    assert.match(body, /Desktop transcript passed explicitly\./u);
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-export-019f28de-f7f6-7223-a2a8-b2968686fe21/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session export fails closed without writing when a runtime transcript is unavailable", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);

    const exported = runJson(rootDir, [
      "session", "export",
      "--session", "missing-desktop-thread",
      "--runtime", "codex",
      "--source", "runtime"
    ], false);

    assert.equal(exported.ok, false);
    assert.equal(exported.error?.code, "session_export_failed");
    assert.match(exported.error?.hint ?? "", /No runtime JSONL log found for codex session missing-desktop-thread/u);
    assert.equal(existsSync(path.join(harnessRoot, "sessions", "missing-desktop-thread.md")), false);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session sync writes existing untracked session exports through the journal", () => {
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
    assert.equal(synced.report.git.coordinator, "write-journal");
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-sync-0/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session backfill discovers Codex runtime logs and writes exports through the journal", () => {
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
    assert.equal(backfilled.report.git.coordinator, "write-journal");
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "codex-thread-backfill.md"), "utf8"), /Backfill this Codex thread/u);
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-export-codex-thread-backfill/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session backfill discovers ZCode runtime logs and writes exports through the journal", () => {
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
    assert.equal(backfilled.report.git.coordinator, "write-journal");
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "sess_zcode-thread-backfill.md"), "utf8"), /Backfill this ZCode thread/u);
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "sess_zcode-thread-backfill.md"), "utf8"), /ZCode backfill response/u);
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-export-sess_zcode-thread-backfill/u);
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
      env: { ...process.env, ...cleanRuntimeEnv, ...testActorEnv, ...env }
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

function writeWatermarkBody(rootDir: string): string {
  return readFileSync(path.join(rootDir, ".harness", "write-journal", "watermark.json"), "utf8");
}
