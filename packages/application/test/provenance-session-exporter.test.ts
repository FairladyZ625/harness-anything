import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeHumanFallbackSessionProbe, makeProvenanceSessionExporter } from "../src/index.ts";
import type { CurrentSessionRef } from "../../kernel/src/index.ts";
import { runEffect, runEffectExit } from "./effect-test-helpers.ts";

test("provenance session exporter writes human fallback markdown and reads it by id", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: makeHumanFallbackSessionProbe({
        now: () => "2026-07-03T00:00:00.000Z",
        user: () => "zeyu"
      }),
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession());
    assert.equal(exported.path, "sessions/human-cli-1783036800000.md");
    assert.deepEqual(exported.session, {
      schema: "provenance-session/v1",
      sessionId: "human-cli-1783036800000",
      runtime: "human",
      source: "manual",
      detectedAt: "2026-07-03T00:00:00.000Z",
      exportedAt: "2026-07-03T00:01:00.000Z",
      user: "zeyu"
    });

    const sessionPath = path.join(rootDir, "harness", exported.path);
    assert.equal(existsSync(sessionPath), true);
    const body = readFileSync(sessionPath, "utf8");
    assert.match(body, /^schema: provenance-session\/v1$/m);
    assert.match(body, /^sessionId: human-cli-1783036800000$/m);
    assert.match(body, /^runtime: human$/m);
    assert.match(body, /^source: manual$/m);

    const readBack = await runEffect(exporter.readById("human-cli-1783036800000"));
    assert.deepEqual(readBack, exported);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter renders Claude Code JSONL conversation text", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "claude", "project-a");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "claude-session-1.jsonl"), [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-03T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Claude user original line" }] }
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-03T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Claude assistant original line" }] }
      })
    ].join("\n"), "utf8");

    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "claude-code",
        sessionId: "claude-session-1",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { "claude-code": [path.join(rootDir, "runtime-logs", "claude")] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession());
    const body = readFileSync(path.join(rootDir, "harness", exported.path), "utf8");
    assert.match(body, /## Conversation/u);
    assert.match(body, /Claude user original line/u);
    assert.match(body, /Claude assistant original line/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter renders Codex JSONL conversation text", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "codex");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "rollout-2026-07-03T00-00-00-codex-session-1.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Codex user original line" }
      }),
      JSON.stringify({
        timestamp: "2026-07-03T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex assistant original line" }]
        }
      })
    ].join("\n"), "utf8");

    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "codex-session-1",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession());
    const body = readFileSync(path.join(rootDir, "harness", exported.path), "utf8");
    assert.match(body, /## Conversation/u);
    assert.match(body, /Codex user original line/u);
    assert.match(body, /Codex assistant original line/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter renders ZCode model I/O JSONL conversation text", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "zcode");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "model-io-sess_zcode-session-1.jsonl"), [
      JSON.stringify({
        startedAt: "2026-07-03T00:00:00.000Z",
        type: "model_io",
        querySource: "session_title",
        request: { body: { messages: [{ role: "user", content: [{ type: "text", text: "ZCode user original line" }] }] } },
        response: { text: "{\"title\":\"ZCode title\"}" }
      }),
      JSON.stringify({
        startedAt: "2026-07-03T00:00:01.000Z",
        type: "model_io",
        querySource: "main_turn",
        request: {
          body: {
            messages: [{
              role: "user",
              content: [{ type: "text", text: "<system-reminder>noise</system-reminder>ZCode user original line" }]
            }]
          }
        },
        response: { text: "ZCode assistant original line" }
      }),
      JSON.stringify({
        startedAt: "2026-07-03T00:00:02.000Z",
        type: "model_io",
        querySource: "main_turn",
        request: {
          body: {
            messages: [
              { role: "assistant", content: "ZCode assistant original line" },
              { role: "user", content: [{ type: "text", text: "<system-reminder>noise only</system-reminder>" }] }
            ]
          }
        },
        response: { text: "ZCode assistant follow-up line" }
      })
    ].join("\n"), "utf8");

    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "zcode",
        sessionId: "sess_zcode-session-1",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { zcode: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession());
    const body = readFileSync(path.join(rootDir, "harness", exported.path), "utf8");
    assert.match(body, /## Conversation/u);
    assert.match(body, /ZCode user original line/u);
    assert.match(body, /ZCode assistant original line/u);
    assert.match(body, /ZCode assistant follow-up line/u);
    assert.doesNotMatch(body, /ZCode title/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter backfills Codex runtime logs by discovered session id", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "codex");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "rollout-2026-07-03T00-00-00-codex-thread-1.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Backfilled Codex user line" }
      })
    ].join("\n"), "utf8");

    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "current-codex-thread",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const result = await runEffect(exporter.backfillRuntimeSessions({ runtime: "codex" }));

    assert.equal(result.schema, "provenance-session-backfill/v1");
    assert.deepEqual(result.exported.map((entry) => entry.session.sessionId), ["codex-thread-1"]);
    const body = readFileSync(path.join(rootDir, "harness", "sessions", "codex-thread-1.md"), "utf8");
    assert.match(body, /Backfilled Codex user line/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter backfills ZCode runtime logs by discovered session id", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "zcode");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "model-io-sess_zcode-thread-1.jsonl"), [
      JSON.stringify({
        startedAt: "2026-07-03T00:00:01.000Z",
        type: "model_io",
        querySource: "main_turn",
        request: { body: { messages: [{ role: "user", content: [{ type: "text", text: "Backfilled ZCode user line" }] }] } },
        response: { text: "Backfilled ZCode assistant line" }
      })
    ].join("\n"), "utf8");

    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "zcode",
        sessionId: "current-zcode-thread",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { zcode: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const result = await runEffect(exporter.backfillRuntimeSessions({ runtime: "zcode" }));

    assert.equal(result.schema, "provenance-session-backfill/v1");
    assert.deepEqual(result.exported.map((entry) => entry.session.sessionId), ["sess_zcode-thread-1"]);
    const body = readFileSync(path.join(rootDir, "harness", "sessions", "sess_zcode-thread-1.md"), "utf8");
    assert.match(body, /Backfilled ZCode user line/u);
    assert.match(body, /Backfilled ZCode assistant line/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter writes visible warning when runtime log is missing", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "missing-codex-session",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [path.join(rootDir, "missing-runtime-logs")] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession());
    const body = readFileSync(path.join(rootDir, "harness", exported.path), "utf8");
    assert.match(body, /## Export Warnings/u);
    assert.match(body, /No runtime JSONL log found for codex session missing-codex-session/u);
    assert.match(body, /_No conversation text extracted\._/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter fails visibly for missing or unsafe session ids", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: makeHumanFallbackSessionProbe()
    });

    const missing = await runEffectExit(exporter.readById("missing-session"));
    assert.equal(missing._tag, "Failure");
    assert.equal(String(missing.cause).includes("session not found: missing-session"), true);

    const unsafe = await runEffectExit(exporter.readById("../escape"));
    assert.equal(unsafe._tag, "Failure");
    assert.equal(String(unsafe.cause).includes("invalid session id: ../escape"), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function fixedSessionProbe(session: CurrentSessionRef) {
  return {
    currentSession: Effect.succeed(session)
  };
}

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-provenance-session-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}
