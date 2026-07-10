import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { bindCreateProvenance, makeHumanFallbackSessionProbe, makeProvenanceSessionExporter } from "../src/index.ts";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore, moduleEntityId, type CurrentSessionRef, type WriteCoordinator, type WriteError } from "../../kernel/src/index.ts";
import type { ProvenanceSessionExporterOptions } from "../src/index.ts";
import { runEffect, runEffectExit } from "./effect-test-helpers.ts";

test("provenance session exporter writes human fallback markdown and reads it by id", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

    const payload = readOnlyJournalPayload(rootDir);
    assert.equal(payload.boundary, "provenance-session");
    assert.equal(payload.path, "harness/sessions/codex-session-1.md");
    assert.equal("body" in payload, false);
    assert.equal(JSON.stringify(payload).includes("Codex user original line"), false);
    const bodyRef = assertContentAddressedBlobRef(payload.bodyRef);
    assert.equal(bodyRef.mediaType, "text/markdown; charset=utf-8");
    assert.equal(readFileSync(path.join(rootDir, bodyRef.ref), "utf8"), body);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter accepts an explicit runtime transcript file", async () => {
  const rootDir = createHarnessRoot();
  try {
    const transcriptFile = path.join(rootDir, "desktop-thread.jsonl");
    writeFileSync(transcriptFile, [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Export this Desktop transcript explicitly." }
      }),
      JSON.stringify({
        timestamp: "2026-07-03T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The explicit transcript was archived." }]
        }
      }),
      ""
    ].join("\n"));
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "desktop-thread-explicit",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [path.join(rootDir, "missing-runtime-logs")] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffect(exporter.exportCurrentSession({ transcriptFile }));
    const body = readFileSync(path.join(rootDir, "harness", exported.path), "utf8");
    assert.match(body, /Export this Desktop transcript explicitly\./u);
    assert.match(body, /The explicit transcript was archived\./u);
    assert.match(body, new RegExp(`Runtime log: ${transcriptFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter rejects an explicit transcript file for a human fallback session", async () => {
  const rootDir = createHarnessRoot();
  try {
    const transcriptFile = path.join(rootDir, "unbound-transcript.jsonl");
    writeFileSync(transcriptFile, `${JSON.stringify({ role: "user", text: "Do not ignore this file." })}\n`);
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe: makeHumanFallbackSessionProbe({
        now: () => "2026-07-03T00:00:00.000Z"
      })
    });

    const result = await runEffectExit(exporter.exportCurrentSession({ transcriptFile }));
    assert.equal(result._tag, "Failure");
    assert.match(String(result.cause), /explicit transcript file requires a non-human runtime session/u);
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", "human-cli-1783036800000.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter dedupes identical claim-check blobs and verifies corruption", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "codex");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "rollout-2026-07-03T00-00-00-codex-session-1.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Deduped Codex user line" }
      })
    ].join("\n"), "utf8");

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "codex-session-1",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    await runEffect(exporter.exportCurrentSession());
    await runEffect(exporter.exportCurrentSession());

    const payload = readOnlyJournalPayload(rootDir);
    const bodyRef = assertContentAddressedBlobRef(payload.bodyRef);
    assert.deepEqual(listObjectFiles(rootDir), [bodyRef.ref]);
    assert.match(readFileSync(path.join(rootDir, bodyRef.ref), "utf8"), /Deduped Codex user line/u);

    writeFileSync(path.join(rootDir, bodyRef.ref), "corrupted blob", "utf8");
    const corruptCoordinator = makeJournaledWriteCoordinator({ rootDir });
    const corruptResult = await runEffect(Effect.either(Effect.gen(function* () {
      yield* corruptCoordinator.enqueue({
        opId: "session-export-corrupt-blob",
        entityId: moduleEntityId("provenance-session"),
        kind: "machine_artifact_write",
        payload: {
          boundary: "provenance-session",
          path: "harness/sessions/corrupt.md",
          bodyRef
        }
      });
      yield* corruptCoordinator.flush("explicit");
    })));
    assert.equal(corruptResult._tag, "Left");
    if (corruptResult._tag === "Left") {
      assert.equal(corruptResult.left._tag, "JournalUnavailable");
      assert.match(corruptResult.left.cause instanceof Error ? corruptResult.left.cause.message : String(corruptResult.left.cause), /content-addressed blob sha256 mismatch/u);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter preserves daemon lock owner guidance", async () => {
  const rootDir = createHarnessRoot();
  try {
    const logsRoot = path.join(rootDir, "runtime-logs", "codex");
    mkdirSync(logsRoot, { recursive: true });
    writeFileSync(path.join(logsRoot, "rollout-codex-session-locked.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Preserve the write conflict owner." }
      }),
      ""
    ].join("\n"));
    const owner = ".harness/locks/global.lock (held by daemon pid 123; write through daemon via the daemon-backed ha client/API instead of direct WriteCoordinator writes)";
    const error = { _tag: "GlobalWriteConflict", owner } satisfies WriteError;
    const coordinator = failingCoordinator(error);
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      coordinator,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "codex-session-locked",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [logsRoot] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const result = await runEffect(Effect.either(exporter.exportCurrentSession()));

    assert.equal(result._tag, "Left");
    if (result._tag !== "Left") return;
    assert.equal(result.left.sessionId, "codex-session-locked");
    assert.match(result.left.reason, /global write conflict/u);
    assert.match(result.left.reason, /write through daemon/u);
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

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

test("provenance session exporter fails closed without writing when runtime log is missing", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe: fixedSessionProbe({
        runtime: "codex",
        sessionId: "missing-codex-session",
        source: "runtime",
        detectedAt: "2026-07-03T00:00:00.000Z"
      }),
      runtimeLogRoots: { codex: [path.join(rootDir, "missing-runtime-logs")] },
      now: () => "2026-07-03T00:01:00.000Z"
    });

    const exported = await runEffectExit(exporter.exportCurrentSession());
    assert.equal(exported._tag, "Failure");
    assert.match(String(exported.cause), /No runtime JSONL log found for codex session missing-codex-session/u);
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", "missing-codex-session.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance session exporter fails visibly for missing or unsafe session ids", async () => {
  const rootDir = createHarnessRoot();
  try {
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
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

test("provenance session exporter rejects an existing runtime session without conversation text", async () => {
  const rootDir = createHarnessRoot();
  try {
    const sessionsRoot = path.join(rootDir, "harness", "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(sessionsRoot, "empty-runtime-session.md"), [
      "---",
      "schema: provenance-session/v1",
      "sessionId: empty-runtime-session",
      "runtime: codex",
      "source: runtime",
      "detectedAt: 2026-07-03T00:00:00.000Z",
      "exportedAt: 2026-07-03T00:01:00.000Z",
      "---",
      "",
      "# Session empty-runtime-session",
      "",
      "## Conversation",
      "",
      "_No conversation text extracted._",
      ""
    ].join("\n"));
    const exporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe: makeHumanFallbackSessionProbe()
    });

    const result = await runEffectExit(exporter.readById("empty-runtime-session"));
    assert.equal(result._tag, "Failure");
    assert.match(String(result.cause), /session transcript unavailable: empty-runtime-session/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("automatic provenance binding keeps the session pointer when the transcript is unavailable", async () => {
  const rootDir = createHarnessRoot();
  try {
    const currentSessionProbe = fixedSessionProbe({
      runtime: "codex",
      sessionId: "desktop-ephemeral-session",
      source: "runtime",
      detectedAt: "2026-07-03T00:00:00.000Z"
    });
    const provenanceSessionExporter = makeTestProvenanceSessionExporter(rootDir, {
      currentSessionProbe,
      runtimeLogRoots: { codex: [path.join(rootDir, "missing-runtime-logs")] }
    });

    const provenance = await runEffect(bindCreateProvenance({
      currentSessionProbe,
      provenanceSessionExporter
    }, "2026-07-03T00:01:00.000Z"));

    assert.deepEqual(provenance, {
      runtime: "codex",
      sessionId: "desktop-ephemeral-session",
      boundAt: "2026-07-03T00:01:00.000Z"
    });
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", "desktop-ephemeral-session.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function fixedSessionProbe(session: CurrentSessionRef) {
  return {
    currentSession: Effect.succeed(session)
  };
}

function makeTestProvenanceSessionExporter(
  rootDir: string,
  options: Omit<ProvenanceSessionExporterOptions, "rootInput" | "coordinator" | "artifactStore">
) {
  return makeProvenanceSessionExporter({
    rootInput: rootDir,
    coordinator: makeJournaledWriteCoordinator({ rootDir }),
    artifactStore: makeMarkdownArtifactStore({ rootDir }),
    ...options
  });
}

function failingCoordinator(error: WriteError): WriteCoordinator {
  return {
    enqueue: () => Effect.fail(error),
    flush: () => Effect.fail(error),
    recover: Effect.fail(error)
  };
}

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-provenance-session-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}

function readOnlyJournalPayload(rootDir: string): Record<string, unknown> {
  const payloadRoot = path.join(rootDir, ".harness", "write-journal", "payloads");
  const payloadFiles = readdirSync(payloadRoot).filter((entry) => entry.endsWith(".json"));
  assert.equal(payloadFiles.length, 1);
  return JSON.parse(readFileSync(path.join(payloadRoot, payloadFiles[0]!), "utf8")) as Record<string, unknown>;
}

interface TestContentAddressedBlobRef {
  readonly ref: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

function assertContentAddressedBlobRef(value: unknown): TestContentAddressedBlobRef {
  assert.equal(Boolean(value && typeof value === "object"), true);
  const candidate = value as Partial<TestContentAddressedBlobRef>;
  assert.equal(typeof candidate.ref, "string");
  assert.equal(typeof candidate.sha256, "string");
  assert.equal(typeof candidate.size, "number");
  assert.equal(typeof candidate.mediaType, "string");
  assert.match(candidate.sha256!, /^[0-9a-f]{64}$/u);
  assert.equal(candidate.ref, `harness/objects/sha256/${candidate.sha256!.slice(0, 2)}/${candidate.sha256!.slice(2)}`);
  return candidate as TestContentAddressedBlobRef;
}

function listObjectFiles(rootDir: string): ReadonlyArray<string> {
  const objectRoot = path.join(rootDir, "harness", "objects");
  const files: string[] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        files.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
      }
    }
  }
  visit(objectRoot);
  return files.sort();
}
