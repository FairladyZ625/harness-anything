// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  appendIncidentActionReceipt,
  readIncidentActionReceipt,
} from "../src/daemon-host/decision-incident-receipt.ts";
import {
  dispatchEvidenceStatePath,
  readDispatchEvidenceState,
  writeDispatchEvidenceState,
} from "../src/daemon-host/dispatch-evidence-state.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStreamSummary,
} from "../src/daemon-host/dispatch-stream.ts";
import { purgeRepoCache } from "../src/daemon-host/repo-cache-purge.ts";
import { publishExit } from "./runtime-spawn-settlement.fixtures.ts";
import {
  fixtureTaskId,
  fixtureArtifacts,
  git,
  workerGitFixture,
  workerSettlementContext,
  workerSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

function fixtureStream(
  fixture: ReturnType<typeof workerGitFixture>,
  runtime: ReturnType<typeof workerSettlementRuntime>,
) {
  const stream = openDispatchStream(fixture.canonical, {
    dispatchId: runtime.dispatchId,
    runtimeSessionId: runtime.runtimeSessionId,
    taskId: fixtureTaskId,
    executionId: "execution-owner",
    instanceId: runtime.instanceId,
    startedAt: runtime.startedAt,
    dispatchOpId: runtime.dispatchOpId,
    kindId: runtime.kindId,
    permissionMode: runtime.permissionMode,
    cwd: runtime.cwd,
    binding: runtime.binding,
    prompt: runtime.prompt,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    evidenceTrackingVersion: 1,
  });
  Object.assign(runtime.stream, {
    appendEvidenceState: (
      value: { readonly state: "pending" | "stored"; readonly reason?: string },
      occurredAt: string,
    ) =>
      appendRuntimeWorkerRecord(fixture.canonical, runtime.dispatchId, {
        kind: "evidence_state",
        occurredAt,
        ...value,
      }),
    appendTerminalOutcome: (value: Readonly<Record<string, unknown>>, occurredAt: string) =>
      appendRuntimeWorkerRecord(fixture.canonical, runtime.dispatchId, {
        kind: "terminal_outcome",
        occurredAt,
        ...value,
      }),
  });
  return stream;
}

function failingArchive(context: ReturnType<typeof workerSettlementContext>): void {
  context.input.remote = {
    archive: async () => {
      throw new Error("injected archive publication failure");
    },
  } as never;
}

test("an archive publication failure keeps the abnormal stream out of compaction and cache purge", async (context) => {
  const fixture = workerGitFixture(context, "forensics-pending", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      providerOutcome: "failed",
      failureText: "provider disconnected",
      finalText: null,
      toolCallObserved: false,
    }),
    stream = fixtureStream(fixture, runtime),
    settleContext = workerSettlementContext(fixture, async () => ({}));
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-pending", request_id: "request-pending" },
    "2026-11-05T00:00:01.000Z",
  );
  failingArchive(settleContext);
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 1);
  const summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId),
    streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId);
  assert.equal(summary?.evidenceState, "pending");
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "pending");
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches", "the raw stream must remain un-compacted");
  assert.equal(existsSync(streamPath), true);
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true, "the pending evidence stream survives the cache purge");
  assert.match(readFileSync(streamPath, "utf8"), /"kind":"evidence_state"/u);
});

test("an archive failure after an initial success rewrites the disposition to pending", async (context) => {
  const fixture = workerGitFixture(context, "forensics-success-archive-failure", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "delivered",
      providerOutcome: "succeeded",
      toolCallObserved: true,
    }),
    stream = fixtureStream(fixture, runtime),
    submittedCommitSha = git(fixture.worker, "rev-parse", "HEAD").trim(),
    settleContext = workerSettlementContext(fixture, async () => ({}), "delivered", submittedCommitSha);
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-success-failure" },
    "2026-11-05T00:00:01.000Z",
  );
  failingArchive(settleContext);
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 0);
  const streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId);
  assert.notEqual(summary?.terminalOutcome?.payload.outcome, "succeeded");
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "pending");
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches");
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true);
});

test("the settled stream keeps its bytes when replacing the not-required sidecar fails", async (context) => {
  const result = "r".repeat(90 * 1024),
    fixture = workerGitFixture(context, "forensics-stale-sidecar", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: result,
      providerOutcome: "succeeded",
      toolCallObserved: true,
    }),
    stream = fixtureStream(fixture, runtime),
    settleContext = workerSettlementContext(
      fixture,
      async () => ({}),
      result,
      git(fixture.worker, "rev-parse", "HEAD").trim(),
    ),
    sidecar = dispatchEvidenceStatePath(fixture.canonical, runtime.dispatchId),
    backup = `${sidecar}.original`;
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-stale-sidecar" },
    "2026-11-05T00:00:01.000Z",
  );
  stream.appendProviderEvent(
    { type: "item.completed", item: { type: "agent_message", text: "p".repeat(40 * 1024) } },
    "2026-11-05T00:00:02.000Z",
  );
  settleContext.input.remote = {
    archive: async () => {
      assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "not-required");
      renameSync(sidecar, backup);
      mkdirSync(sidecar);
      throw new Error("injected archive publication failure");
    },
  } as never;
  const append = runtime.stream.appendEvidenceState!;
  context.mock.method(runtime.stream, "appendEvidenceState", (...args: Parameters<typeof append>) => {
    // The durable replacement has already failed. Restore the old disposition before the
    // append, reproducing a filesystem that kept the old file while permitting JSONL writes.
    rmdirSync(sidecar);
    renameSync(backup, sidecar);
    append(...args);
  });
  const appendTerminal = runtime.stream.appendTerminalOutcome!;
  context.mock.method(runtime.stream, "appendTerminalOutcome", (...args: Parameters<typeof appendTerminal>) => {
    appendRuntimeWorkerRecord(fixture.canonical, runtime.dispatchId, {
      kind: "provider_event",
      occurredAt: args[1],
      event: {
        type: "model.streaming",
        turnId: "turn-tail-filler",
        payload: { kind: "reasoning_delta", delta: "g".repeat(128 * 1024) },
      },
    });
    appendTerminal(...args);
  });
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 0);

  const live = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    bytes = readFileSync(live);
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "not-required");
  assert.match(bytes.toString("utf8"), /"kind":"evidence_state"[^\n]+"state":"pending"/u);
  const summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId);
  assert.equal(summary?.evidenceState, null, "the terminal record can mask the marker from the bounded summary");
  assert.equal(summary?.terminalOutcome?.payload.outcome, "failed", "the full terminal remains visible");
  archiveDispatchStream(fixture.canonical, runtime.dispatchId);
  assert.equal(dispatchStreamPath(fixture.canonical, runtime.dispatchId), live);
  assert.deepEqual(readFileSync(live), bytes);
});

test("an awaiting-ruling archive failure keeps its stream when the pending sidecar replacement fails", async (context) => {
  const fixture = workerGitFixture(context, "forensics-awaiting-ruling-archive-failure", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "awaiting an owner ruling",
    }),
    artifacts = fixtureArtifacts(fixture),
    stream = fixtureStream(fixture, runtime),
    settleContext = workerSettlementContext(fixture, async () => ({})),
    rulingPath = path.join(
      fixture.worker,
      "harness",
      "tasks",
      `${fixtureTaskId}-fixture`,
      "artifacts",
      "rulings",
      `${runtime.dispatchId}.md`,
    ),
    sidecar = dispatchEvidenceStatePath(fixture.canonical, runtime.dispatchId),
    backup = `${sidecar}.original`;
  mkdirSync(path.dirname(rulingPath), { recursive: true });
  writeFileSync(rulingPath, artifacts.body);
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-awaiting-ruling-archive-failure" },
    "2026-11-05T00:00:01.000Z",
  );
  stream.appendProviderEvent(
    { type: "item.completed", item: { type: "agent_message", text: "p".repeat(40 * 1024) } },
    "2026-11-05T00:00:02.000Z",
  );
  settleContext.input.remote = {
    archive: async () => {
      assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "not-required");
      renameSync(sidecar, backup);
      mkdirSync(sidecar);
      throw new Error("injected archive publication failure");
    },
  } as never;
  const appendEvidenceState = runtime.stream.appendEvidenceState!;
  context.mock.method(runtime.stream, "appendEvidenceState", (...args: Parameters<typeof appendEvidenceState>) => {
    rmdirSync(sidecar);
    renameSync(backup, sidecar);
    appendEvidenceState(...args);
  });
  const appendTerminalOutcome = runtime.stream.appendTerminalOutcome!;
  context.mock.method(runtime.stream, "appendTerminalOutcome", (...args: Parameters<typeof appendTerminalOutcome>) => {
    appendRuntimeWorkerRecord(fixture.canonical, runtime.dispatchId, {
      kind: "provider_event",
      occurredAt: args[1],
      event: {
        type: "model.streaming",
        turnId: "turn-tail-filler",
        payload: { kind: "reasoning_delta", delta: "g".repeat(128 * 1024) },
      },
    });
    appendTerminalOutcome(...args);
  });
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 2);

  const live = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    bytes = readFileSync(live),
    summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId),
    terminal = summary?.terminalOutcome;
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "not-required");
  assert.equal(summary?.evidenceState, null, "the bounded summary cannot see the pending stream record");
  assert.equal(terminal?.payload.outcome, "failed");
  assert.equal(terminal?.payload.reasonCode, "runtime_archive_failed");
  assert.equal(terminal?.payload.attempt?.classification, "awaiting_ruling");
  archiveDispatchStream(fixture.canonical, runtime.dispatchId);
  assert.equal(dispatchStreamPath(fixture.canonical, runtime.dispatchId), live);
  assert.deepEqual(readFileSync(live), bytes);
});

test("a stale not-required disposition cannot retire a visible abnormal terminal", async (context) => {
  const fixture = workerGitFixture(context, "forensics-stale-not-required", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, { finalText: "failed", providerOutcome: "failed" }),
    stream = fixtureStream(fixture, runtime),
    occurredAt = "2026-11-05T00:00:03.000Z";
  writeDispatchEvidenceState(fixture.canonical, runtime.dispatchId, "not-required");
  stream.appendTerminalOutcome(
    {
      payload: {
        runtimeSessionId: runtime.runtimeSessionId,
        outcome: "failed",
        exitCode: 1,
        resultRef: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
        result: null,
        endedAt: occurredAt,
        attempt: { classification: "worker_stop", reason: "injected failed terminal" },
      },
      body: "failed",
      reason: "injected failed terminal",
    },
    occurredAt,
  );
  const live = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    bytes = readFileSync(live);
  assert.equal(
    readDispatchStreamSummary(fixture.canonical, runtime.dispatchId)?.terminalOutcome?.payload.outcome,
    "failed",
  );
  archiveDispatchStream(fixture.canonical, runtime.dispatchId);
  assert.equal(dispatchStreamPath(fixture.canonical, runtime.dispatchId), live);
  assert.deepEqual(readFileSync(live), bytes);
});

test("a post-archive settlement failure rewrites the disposition to pending", async (context) => {
  const fixture = workerGitFixture(context, "forensics-success-settlement-failure", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "delivered",
      providerOutcome: "succeeded",
      toolCallObserved: true,
    }),
    stream = fixtureStream(fixture, runtime),
    submittedCommitSha = git(fixture.worker, "rev-parse", "HEAD").trim(),
    settleContext = workerSettlementContext(fixture, async () => ({}), "delivered", submittedCommitSha);
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-settlement-failure" },
    "2026-11-05T00:00:01.000Z",
  );
  settleContext.input.remote = {
    archive: async () => ({ outcome: "applied" }),
  } as never;
  Object.assign(settleContext, {
    settleFallback: async () => {
      throw new Error("injected settlement failure");
    },
  });
  context.mock.method(console, "error", () => undefined);
  await assert.rejects(publishExit(settleContext, runtime, 0), /injected settlement failure/u);
  const streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId);
  assert.equal(summary?.terminalOutcome, null, "a refused settlement publishes no terminal outcome");
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "pending");
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches");
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true);
});

test("a large terminal body cannot hide the sidecar disposition from purge or archive", async (context) => {
  const fixture = workerGitFixture(context, "forensics-large-terminal", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      providerOutcome: "failed",
      failureText: "provider disconnected",
      finalText: "x".repeat(200 * 1024),
      toolCallObserved: true,
    }),
    stream = fixtureStream(fixture, runtime),
    largeResult = "x".repeat(200 * 1024),
    settleContext = workerSettlementContext(fixture, async () => ({}), largeResult);
  // Push the pending marker out of both 16 KiB head windows; the terminal body then fills the
  // 128 KiB tail window so the bounded summary cannot see either record.
  stream.appendProviderEvent(
    { type: "item.completed", item: { type: "agent_message", text: "p".repeat(40 * 1024) } },
    "2026-11-05T00:00:01.000Z",
  );
  failingArchive(settleContext);
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 0);
  const summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId),
    streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId);
  assert.equal(summary?.evidenceState, null, "the bounded summary must not be the protection source");
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), "pending");
  archiveDispatchStream(fixture.canonical, runtime.dispatchId);
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches", "the sidecar blocks archiving");
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true);
});

test("a sidecar write failure is fail-closed for archive and cache purge", async (context) => {
  const fixture = workerGitFixture(context, "forensics-sidecar-failure", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      providerOutcome: "failed",
      failureText: "provider disconnected",
      finalText: null,
      toolCallObserved: false,
    }),
    stream = fixtureStream(fixture, runtime),
    settleContext = workerSettlementContext(fixture, async () => ({}));
  // A directory at the sidecar path makes every durable state write fail without touching the
  // stream append path.
  mkdirSync(dispatchEvidenceStatePath(fixture.canonical, runtime.dispatchId));
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-sidecar-failure" },
    "2026-11-05T00:00:01.000Z",
  );
  failingArchive(settleContext);
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 1);
  const streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId);
  assert.equal(readDispatchEvidenceState(fixture.canonical, runtime.dispatchId), null);
  archiveDispatchStream(fixture.canonical, runtime.dispatchId);
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches", "a missing sidecar is fail-closed");
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true);
});

test("an incident needs_attention receipt marks a successful settlement through publishExit", async (context) => {
  const fixture = workerGitFixture(context, "forensics-incident-marker", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "delivered",
      providerOutcome: "succeeded",
      toolCallObserved: true,
    }),
    stream = fixtureStream(fixture, runtime),
    submittedCommitSha = git(fixture.worker, "rev-parse", "HEAD").trim(),
    settleContext = workerSettlementContext(fixture, async () => ({}), "delivered", submittedCommitSha);
  let captured: { readonly forensics?: unknown } | null = null;
  stream.appendProviderEvent({ type: "thread.started", thread_id: "provider-marker" }, "2026-11-05T00:00:01.000Z");
  appendIncidentActionReceipt(fixture.canonical, runtime.dispatchId, {
    pointId: "incident-marker",
    questionVersion: "runtime-incident-disposition/v1",
    status: "applied",
    selected: "needs_attention",
    action: "needs_attention",
    attention: "guard",
    reason: "owner asked for evidence",
    successorDispatchId: null,
    budget: null,
    decidedAt: "2026-11-05T00:00:02.000Z",
  });
  assert.equal(readIncidentActionReceipt(fixture.canonical, runtime.dispatchId)?.action, "needs_attention");
  settleContext.input.remote = {
    archive: async (archive: { readonly forensics?: unknown }) => {
      captured = archive;
      return { outcome: "applied" };
    },
  } as never;
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 0);
  assert.ok(captured?.forensics, "the real settlement entry must capture after the incident marker");
  assert.equal(
    readDispatchEvidenceState(fixture.canonical, runtime.dispatchId),
    "stored",
    "a successful archive writes the stored disposition",
  );
});
