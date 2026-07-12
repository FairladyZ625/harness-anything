// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeContentAddressedBlob } from "../../kernel/src/index.ts";
import { readSessionEntity } from "../../application/src/index.ts";

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
    const stored = readSessionEntity(rootDir, "019f28de-f7f6-7223-a2a8-b2968686fe21");
    assert.equal(stored.format, "manifest");
    assert.match(stored.body, /Desktop transcript passed explicitly\./u);
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

test("CLI session sync dry-runs and idempotently converts legacy exports to Session Entity manifests", () => {
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

    const planned = runJson(rootDir, ["session", "sync"]);
    assert.equal(planned.ok, true);
    assert.equal(planned.report.mode, "dry-run");
    assert.equal(planned.report.sessions.needsBackfill, 1);
    assert.match(readFileSync(path.join(harnessRoot, "sessions", "manual-session.md"), "utf8"), /provenance-session\/v1/u);

    const synced = runJson(rootDir, ["session", "sync", "--apply"]);
    assert.equal(synced.ok, true);
    assert.equal(synced.command, "session-sync");
    assert.equal(synced.rows, 1);
    assert.equal(synced.report.mode, "apply");
    assert.equal(synced.report.sessions.applied, 1);
    const firstManifest = readFileSync(path.join(harnessRoot, "sessions", "manual-session.md"), "utf8");
    assert.doesNotMatch(firstManifest, /provenance-session\/v1/u);
    assert.equal(readSessionEntity(rootDir, "manual-session").body.includes("# Session manual-session"), true);
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-sync-0/u);

    const repeated = runJson(rootDir, ["session", "sync", "--apply"]);
    assert.equal(repeated.report.sessions.applied, 0);
    assert.equal(readFileSync(path.join(harnessRoot, "sessions", "manual-session.md"), "utf8"), firstManifest);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

test("CLI session sync leaves existing Session Entity manifests untouched", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "sessions"), { recursive: true });
    initHarnessGit(harnessRoot);
    const bodyRef = {
      store: "authored-cas/v1",
      ...writeContentAddressedBlob(rootDir, "# Session synced-manifest\n", "text/markdown; charset=utf-8")
    };
    writeFileSync(path.join(harnessRoot, "sessions", "synced-manifest.md"), `${JSON.stringify({
      schema: "session-entity/v1",
      sessionId: "synced-manifest",
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-04T00:00:00.000Z",
      exportedAt: "2026-07-04T00:01:00.000Z",
      bodyRef,
      snapshot: {
        capturedAt: "2026-07-04T00:01:00.000Z",
        completeness: "complete",
        captureRange: { messageCount: 1 },
        privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
      }
    }, null, 2)}\n`);

    const before = readFileSync(path.join(harnessRoot, "sessions", "synced-manifest.md"), "utf8");
    const synced = runJson(rootDir, ["session", "sync", "--apply"]);

    assert.equal(synced.ok, true);
    assert.equal(synced.report.sessions.needsBackfill, 0);
    assert.equal(synced.report.sessions.alreadyPresent, 1);
    assert.equal(synced.report.sessions.applied, 0);
    assert.equal(readFileSync(path.join(harnessRoot, "sessions", "synced-manifest.md"), "utf8"), before);
    assert.match(gitStatus(harnessRoot), /\?\? (?:objects|sessions)\//u);
  });
});

test("CLI session sync keeps uncertain Runtime Event associations as candidates", () => {
  withTempRoot((rootDir) => {
    const eventsRoot = path.join(rootDir, ".harness", "generated", "runtime-events");
    mkdirSync(eventsRoot, { recursive: true });
    writeFileSync(path.join(eventsRoot, "runtime-session.jsonl"), [
      JSON.stringify(runtimeEvent("evt-task", { taskId: "task_01KX7H00000000000000000000" })),
      JSON.stringify(runtimeEvent("evt-unknown", {})),
      ""
    ].join("\n"));

    const planned = runJson(rootDir, ["session", "sync"]);

    assert.equal(planned.report.executionCandidates.length, 2);
    assert.deepEqual(planned.report.executionCandidates.map((candidate: Record<string, unknown>) => ({
      taskId: candidate.taskId,
      confidence: candidate.confidence,
      disposition: candidate.disposition
    })), [
      { taskId: "task_01KX7H00000000000000000000", confidence: "medium", disposition: "candidate" },
      { taskId: null, confidence: "low", disposition: "candidate" }
    ]);
    assert.equal(existsSync(path.join(rootDir, "harness", "tasks", "task_01KX7H00000000000000000000", "executions")), false);
  });
});

test("CLI session sync seeds only active Holder v1 evidence and keeps released history unknown", () => {
  withTempRoot((rootDir) => {
    const activeTask = "task_01KX7H00000000000000000000";
    const releasedTask = "task_01KX7H00000000000000000002";
    writeActiveTask(rootDir, activeTask);
    writeActiveTask(rootDir, releasedTask);
    const holdersRoot = path.join(rootDir, ".harness", "task-holders");
    mkdirSync(holdersRoot, { recursive: true });
    writeFileSync(path.join(holdersRoot, `${activeTask}.json`), JSON.stringify({
      schema: "task-holder/v1",
      taskId: activeTask,
      holder: {
        principal: { personId: "person_zeyu" },
        executor: { kind: "agent", id: "codex" },
        responsibleHuman: "person:person_zeyu"
      },
      acquiredVia: "claim",
      acquiredAt: "2026-07-04T00:00:00.000Z",
      leaseExpiresAt: "2099-07-04T01:00:00.000Z",
      releasedAt: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
      version: "v1"
    }));
    writeFileSync(path.join(holdersRoot, `${releasedTask}.json`), JSON.stringify({
      schema: "task-holder/v1",
      taskId: releasedTask,
      holder: null,
      acquiredVia: null,
      acquiredAt: null,
      leaseExpiresAt: null,
      releasedAt: "2026-07-04T02:00:00.000Z",
      updatedAt: "2026-07-04T02:00:00.000Z",
      version: "v2"
    }));

    const planned = runJson(rootDir, ["session", "sync"]);

    assert.deepEqual(planned.report.holderBackfill.map((entry: Record<string, unknown>) => ({
      taskId: entry.taskId,
      disposition: entry.disposition,
      confidence: entry.confidence,
      worker: entry.worker
    })), [
      { taskId: activeTask, disposition: "seed_active_execution", confidence: "high", worker: "codex" },
      { taskId: releasedTask, disposition: "unknown", confidence: "low", worker: null }
    ]);
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
    assert.match(readSessionEntity(rootDir, "codex-thread-backfill").body, /Backfill this Codex thread/u);
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
    assert.match(readSessionEntity(rootDir, "sess_zcode-thread-backfill").body, /Backfill this ZCode thread/u);
    assert.match(readSessionEntity(rootDir, "sess_zcode-thread-backfill").body, /ZCode backfill response/u);
    assert.match(writeWatermarkBody(rootDir), /"schema":"write-watermark\/v1"/u);
    assert.match(writeWatermarkBody(rootDir), /session-export-sess_zcode-thread-backfill/u);
    assert.equal(gitStatus(harnessRoot), "");
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-session-cli-"));
  ensureTestHarnessIdentity(rootDir);
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
  execFileSync("git", ["-C", harnessRoot, "add", "--", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}

function writeWatermarkBody(rootDir: string): string {
  return readFileSync(path.join(rootDir, ".harness", "write-journal", "watermark.json"), "utf8");
}

function runtimeEvent(eventId: string, linkage: { readonly taskId?: string }): Record<string, unknown> {
  return {
    schema: "runtime-event/v1",
    eventId,
    recordedAt: "2026-07-04T00:00:00.000Z",
    kind: "result",
    session: {
      sessionId: "runtime-session",
      runtime: "codex",
      ...linkage,
      executionId: null,
      reviewId: null
    },
    turn: null,
    step: null,
    tool: null,
    approval: null,
    interrupt: null,
    result: { status: "succeeded" },
    cost: null
  };
}

function writeActiveTask(rootDir: string, taskId: string): void {
  const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "lifecycle:",
    "  engine: local",
    "  status: active",
    "---",
    ""
  ].join("\n"));
}
