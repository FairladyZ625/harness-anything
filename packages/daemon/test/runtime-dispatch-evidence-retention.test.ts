// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { appendIncidentActionReceipt, readIncidentActionReceipt } from "../src/decision-incident-receipt.ts";
import { dispatchEvidenceStatePath, readDispatchEvidenceState } from "../src/dispatch-evidence-state.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStreamSummary,
} from "../src/dispatch-stream.ts";
import { purgeRepoCache } from "../src/repo-cache-purge.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import {
  fixtureTaskId,
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
  await publishExit(settleContext, runtime, 0);
  const streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId),
    summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId);
  assert.equal(summary?.terminalOutcome?.payload.outcome, "unknown");
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
