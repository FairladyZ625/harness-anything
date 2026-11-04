// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import {
  captureDispatchForensics,
  dispatchForensicsRequired,
  type DispatchForensicsInput,
} from "../src/runtime-dispatch-evidence.ts";

const dispatchId = "dispatch_0123456789abcdef01234567",
  runtimeSessionId = "runtime-forensics",
  providerSessionId = "provider-forensics";

function input(rootDir: string, overrides: Partial<DispatchForensicsInput> = {}): DispatchForensicsInput {
  return {
    rootDir,
    dispatchId,
    runtimeSessionId,
    taskId: "task-owner",
    executionId: "execution-owner",
    instanceId: "codex-forensics",
    kindId: "codex",
    providerSessionId,
    resolvedProviderDirectory: path.join(rootDir, "provider-home"),
    outcome: "failed",
    classification: "provider_fault",
    reason: "provider disconnected",
    endedAt: "2026-11-05T00:01:00.000Z",
    request: {
      dispatchOpId: dispatchId,
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local",
      permissionMode: "read-only",
      model: "gpt-test",
      reasoningEffort: null,
      cwd: rootDir,
      startedAt: "2026-11-05T00:00:00.000Z",
      promptSource: null,
      prompt: "investigate sk-live-secret and preserve the trace",
    },
    ...overrides,
  };
}

function writeStream(rootDir: string): void {
  const stream = openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId,
    taskId: "task-owner",
    executionId: "execution-owner",
    instanceId: "codex-forensics",
    startedAt: "2026-11-05T00:00:00.000Z",
    dispatchOpId: dispatchId,
    kindId: "codex",
    permissionMode: "read-only",
    cwd: rootDir,
    binding: {
      actor: {
        principal: { personId: "owner" },
        executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local",
    },
    prompt: "investigate sk-live-secret and preserve the trace",
    model: "gpt-test",
    reasoningEffort: null,
  });
  stream.appendProviderEvent(
    {
      type: "thread.started",
      thread_id: providerSessionId,
      turn_id: "turn-local",
      request_id: "request-1",
      authorization: "Bearer sk-live-secret",
    },
    "2026-11-05T00:00:01.000Z",
  );
  stream.appendProviderEvent(
    {
      type: "item.completed",
      item: { type: "agent_message", text: "used sk-live-secret while answering" },
      metadata: { internal_chat_message_metadata_passthrough: { turn_id: "turn-passthrough" } },
    },
    "2026-11-05T00:00:02.000Z",
  );
}

function writeRollout(rootDir: string): void {
  const file = path.join(
    rootDir,
    "provider-home",
    "sessions",
    "2026",
    "11",
    "05",
    `rollout-2026-11-05T00-00-00-${providerSessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session_meta", payload: { id: providerSessionId, token: "sk-live-secret" } }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-local", request_id: "request-1" },
        authorization: "Bearer sk-live-secret",
      }),
      "",
    ].join("\n"),
  );
}

test("an abnormal settlement snapshots the stream, provider rollout and correlation trace with credentials scrubbed", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-"));
  try {
    writeStream(rootDir);
    writeRollout(rootDir);
    const forensics = captureDispatchForensics(input(rootDir));
    assert.ok(forensics);
    assert.doesNotMatch(forensics.stream, /sk-live-secret/u, "the stream snapshot must not carry the provider secret");
    assert.match(forensics.stream, /\[REDACTED\]/u);
    assert.ok(forensics.providerRollout, "the codex rollout must be captured when exactly one matches");
    assert.doesNotMatch(forensics.providerRollout, /sk-live-secret/u);
    assert.doesNotMatch(forensics.requestTrace, /sk-live-secret/u);
    const trace = JSON.parse(forensics.requestTrace);
    assert.equal(trace.schema, "runtime-dispatch-evidence/v1");
    assert.equal(trace.request.prompt, "investigate [REDACTED] and preserve the trace");
    assert.deepEqual(trace.response.threadIds, [providerSessionId]);
    assert.deepEqual(trace.response.turnIds, ["turn-local"]);
    assert.deepEqual(trace.response.requestIds, ["request-1"]);
    assert.deepEqual(trace.response.passthroughTurnIds, ["turn-passthrough"]);
    assert.deepEqual(trace.capture.providerRollout.truncated, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a normal success and an owner-ruling wait keep no evidence snapshot", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-none-"));
  try {
    writeStream(rootDir);
    assert.equal(captureDispatchForensics(input(rootDir, { outcome: "succeeded", classification: "gate_red" })), null);
    assert.equal(
      captureDispatchForensics(input(rootDir, { outcome: "stopped", classification: "awaiting_ruling" })),
      null,
    );
    assert.equal(dispatchForensicsRequired("stopped", "worker_stop"), true);
    assert.equal(dispatchForensicsRequired("unknown", "completed_without_final_text"), true);
    assert.equal(dispatchForensicsRequired("cancelled", "worker_stop"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the existing needs_attention classification marks a normal terminal for evidence", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-marked-"));
  try {
    writeStream(rootDir);
    assert.equal(dispatchForensicsRequired("succeeded", "needs_attention"), true);
    assert.equal(dispatchForensicsRequired("failed", "needs_attention"), true);
    assert.ok(captureDispatchForensics(input(rootDir, { outcome: "succeeded", classification: "needs_attention" })));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a deepseek-harness transcript keeps its native turn namespaced by provider session", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-dsh-")),
    transcript = path.join(rootDir, "provider-home", "sessions", "project", providerSessionId, "session.v4.jsonl");
  try {
    writeStream(rootDir);
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "session", version: 4, id: providerSessionId }),
        JSON.stringify({ type: "assistant/chunk", data: { turn: 1, step: 1, text: "answer" } }),
        "",
      ].join("\n"),
    );
    const forensics = captureDispatchForensics(
        input(rootDir, { kindId: "deepseek-harness", instanceId: "deepseek-forensics" }),
      ),
      trace = JSON.parse(forensics!.requestTrace);
    assert.deepEqual(trace.response.nativeTurnIds, [`deepseek-harness:${providerSessionId}:turn:1`]);
    assert.ok(trace.response.turnIds.includes(`deepseek-harness:${providerSessionId}:turn:1`));
    assert.deepEqual(trace.capture.providerRollout.truncated, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a high-ratio multi-frame deepseek transcript is bounded before it reaches the snapshot", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-dsh-large-")),
    transcript = path.join(rootDir, "provider-home", "sessions", "project", providerSessionId, "session.v4.jsonl.zstd"),
    frame = zstdCompressSync(Buffer.from("a".repeat(8 * 1024 * 1024)));
  try {
    writeStream(rootDir);
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, Buffer.concat([frame, frame]));
    const forensics = captureDispatchForensics(
        input(rootDir, { kindId: "deepseek-harness", instanceId: "deepseek-forensics" }),
      ),
      trace = JSON.parse(forensics!.requestTrace);
    assert.equal(trace.capture.providerRollout.truncated, true);
    assert.ok(forensics!.providerRollout!.length <= 4 * 1024 * 1024 + 512);
    assert.match(forensics!.providerRollout!, /runtime-dispatch-evidence-truncated\/v1/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a huge request prompt is truncated inside the request trace budget", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-prompt-")),
    prompt = "h".repeat(2 * 1024 * 1024);
  try {
    const stream = openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId,
      taskId: "task-owner",
      executionId: "execution-owner",
      instanceId: "codex-forensics",
      startedAt: "2026-11-05T00:00:00.000Z",
      dispatchOpId: dispatchId,
      kindId: "codex",
      permissionMode: "read-only",
      cwd: rootDir,
      binding: { actor: { principal: { personId: "owner" }, executor: null }, source: "local" },
      prompt,
      model: "gpt-test",
      reasoningEffort: null,
    });
    stream.appendProviderEvent({ type: "thread.started", thread_id: providerSessionId }, "2026-11-05T00:00:01.000Z");
    const forensics = captureDispatchForensics(
        input(rootDir, {
          request: {
            dispatchOpId: dispatchId,
            actor: { principal: { personId: "owner" }, executor: null },
            source: "local",
            permissionMode: "read-only",
            model: "gpt-test",
            reasoningEffort: null,
            cwd: rootDir,
            startedAt: "2026-11-05T00:00:00.000Z",
            promptSource: null,
            prompt,
          },
        }),
      ),
      trace = JSON.parse(forensics!.requestTrace);
    assert.equal(trace.request.promptTruncated, true);
    assert.equal(trace.request.promptBytes, Buffer.byteLength(prompt));
    assert.ok(Buffer.byteLength(forensics!.requestTrace) <= 512 * 1024);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a stream past the snapshot budget keeps both ends and records the truncation", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "dispatch-forensics-large-"));
  try {
    const stream = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: "task-owner",
        executionId: "execution-owner",
        instanceId: "codex-forensics",
        startedAt: "2026-11-05T00:00:00.000Z",
        dispatchOpId: dispatchId,
        kindId: "codex",
        permissionMode: "read-only",
        cwd: rootDir,
        binding: { actor: { principal: { personId: "owner" }, executor: null }, source: "local" },
        prompt: "large stream",
        model: "gpt-test",
        reasoningEffort: null,
      }),
      chunk = "x".repeat(1024 * 1024);
    for (let index = 0; index < 5; index += 1)
      stream.appendProviderEvent(
        { type: "item.completed", item: { type: "agent_message", text: chunk } },
        "2026-11-05T00:00:01.000Z",
      );
    stream.appendProviderEvent({ type: "turn.failed", error: { message: "tail marker" } }, "2026-11-05T00:00:02.000Z");
    const forensics = captureDispatchForensics(input(rootDir)),
      trace = JSON.parse(forensics!.requestTrace);
    assert.ok(forensics);
    assert.equal(trace.capture.stream.truncated, true);
    assert.ok(trace.capture.stream.capturedBytes < trace.capture.stream.totalBytes);
    assert.match(forensics.stream, /runtime-dispatch-evidence-truncated\/v1/u);
    assert.match(forensics.stream, /tail marker/u, "the tail keeps the terminal provider record");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
