// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runtimeEventContentClaims,
  runtimeSessionSemanticState,
  runtimeTaskExecutionRelation,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventType,
  type AgentRuntimeEventV1,
} from "../../src/domain/agent-runtime.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { makeTaskEventReader } from "../../src/store/task-event-store-factory.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

interface ProviderWitnessV1 {
  readonly type: AgentRuntimeEventType | "heartbeat";
  readonly payload: Readonly<Record<string, unknown>>;
}
const canonicalRuntimeInputs: readonly ProviderWitnessV1[] = [
  {
    type: "runtime_installation_observed",
    payload: {
      installationId: "installation-claude",
      kindId: "claude-compatible",
      version: "1.0.0",
      capabilities: ["structured_witness", "resume"],
    },
  },
  {
    type: "runtime_dispatch_requested",
    payload: {
      dispatchId: "dispatch-claude",
      runtimeSessionId: "runtime-session-claude",
      instanceId: "claude-fixture",
      installationId: "installation-claude",
      kindId: "claude",
      idempotencyKey: "dispatch-claude-attempt-1",
      definitionSnapshotRef: "artifact:runtime-definitions/claude/v1",
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "claude-fixture",
        installationId: "installation-claude",
        kindId: "claude",
        providerId: "anthropic",
        model: "claude-fixture",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription",
      },
    },
  },
  {
    type: "runtime_session_started",
    payload: {
      runtimeSessionId: "runtime-session-claude",
      instanceId: "claude-fixture",
      installationId: "installation-claude",
      kindId: "claude",
      definitionSnapshotRef: "artifact:runtime-definitions/claude/v1",
      launchGeneration: 1,
      attachable: false,
    },
  },
  {
    type: "runtime_session_provider_bound",
    payload: {
      runtimeSessionId: "runtime-session-claude",
      providerSessionId: "provider-session-claude",
      transcriptRef: "file:runtime-transcripts/claude/session.jsonl",
    },
  },
  {
    type: "runtime_session_task_bound",
    payload: {
      runtimeSessionId: "runtime-session-claude",
      taskId: "task-runtime",
      executionId: "execution-claude",
      providerSessionId: "provider-session-claude",
      transcriptRef: "file:runtime-transcripts/claude/session.jsonl",
    },
  },
  {
    type: "runtime_session_outcome_observed",
    payload: {
      runtimeSessionId: "runtime-session-claude",
      outcome: "succeeded",
      exitCode: 0,
      resultRef: "artifact:runtime-result/sha256/bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787",
      result: {
        sha256: "bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787",
        size: 14,
        mediaType: "text/plain; charset=utf-8",
      },
    },
  },
  { type: "runtime_session_exited", payload: { runtimeSessionId: "runtime-session-claude" } },
  {
    type: "runtime_dispatch_outcome_unknown",
    payload: { dispatchId: "dispatch-claude", runtimeSessionId: "runtime-session-claude" },
  },
  { type: "heartbeat", payload: { runtimeSessionId: "runtime-session-claude" } },
];
const claude = { witnesses: canonicalRuntimeInputs };
test("runtime session semantics preserve the four adjudicated liveness/outcome cases", () => {
  assert.deepEqual(
    [
      runtimeSessionSemanticState({ liveness: "live", outcome: null }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "succeeded" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "failed" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "cancelled" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "unknown" }),
      runtimeSessionSemanticState({ liveness: "unknown", outcome: null }),
    ],
    ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
  );
});
const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
const envelope = (revision: number, source: AgentRuntimeEventV1["source"] = "local") => ({
  eventId: `event-runtime-${revision}`,
  workspaceRevision: revision,
  opId: `op-runtime-${revision}`,
  actor,
  source,
  occurredAt: `2026-08-12T00:00:0${revision}.000Z`,
  hostRef: "host:local",
});

test("runtime events use the canonical envelope, head, store, and the shared projection transaction", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    const events = claude.witnesses
      .map((witness, index) => eventFromProviderWitness(witness, envelope(index + 1)))
      .filter((event): event is AgentRuntimeEventV1 => event !== null);
    events.push(
      eventFromProviderWitness(
        { ...claude.witnesses[0]!, payload: { ...claude.witnesses[0]!.payload, version: "1.1.0" } },
        envelope(events.length + 1),
      )!,
    );
    for (const event of events) {
      const receipt = store.append(bundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
      assert.equal(receipt.revision, event.workspaceRevision);
    }
    assert.equal(store.readHead()?.revision, events.length);
    assert.deepEqual(store.readEvent(events.at(-1)!.opId), events.at(-1));
    const reader = makeTaskEventReader({ repoId: "test-repo", rootDir });
    try {
      assert.deepEqual(reader.readEvent(events[0]!.opId), events[0]);
    } finally {
      await reader.drain();
    }
    assert.deepEqual(projection.readRuntimeInstallation("installation-claude"), {
      installationId: "installation-claude",
      kindId: "claude-compatible",
      protocolFamily: "claude-compatible",
      hostRef: "host:local",
      version: "1.1.0",
      discoverySource: "wrapper",
      effectiveCapabilities: ["structured_witness", "resume"],
      lastObservedAt: "2026-08-12T00:00:09.000Z",
    });
    const session = projection.readRuntimeSession("runtime-session-claude");
    assert.equal(session?.providerSessionId, "provider-session-claude");
    const dispatch = projection.readRuntimeDispatch("runtime-session-claude", session!.definitionSnapshotRef);
    assert.deepEqual(projection.readRuntimeDispatch("runtime-session-claude"), dispatch);
    assert.equal(projection.readRuntimeDispatch("missing"), null);
    assert.equal(dispatch?.type, "runtime_dispatch_requested");
    assert.equal(dispatch?.payload.runtimeSessionId, session?.runtimeSessionId);
    assert.equal(
      projection.readRuntimeDispatch("runtime-session-claude", "artifact:runtime-definitions/missing"),
      null,
    );
    const db = new DatabaseSync(projection.path, { readOnly: true });
    try {
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND json_extract(event_json, '$.payload.definitionSnapshotRef') = ? ORDER BY workspace_revision LIMIT 1",
        )
        .all("runtime-session-claude", session!.definitionSnapshotRef) as readonly { readonly detail: string }[];
      assert.match(
        plan.map(({ detail }) => detail).join("\n"),
        /SEARCH event_index USING INDEX event_index_runtime_dispatch_lookup/u,
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      session?.taskBindings.map(({ taskId, executionId, transcriptRef }) => ({ taskId, executionId, transcriptRef })),
      [
        {
          taskId: "task-runtime",
          executionId: "execution-claude",
          transcriptRef: "file:runtime-transcripts/claude/session.jsonl",
        },
      ],
    );
    assert.deepEqual(projection.getEntity("runtime-session", "runtime-session-claude")?.value, {
      schema: "runtime-session/v1",
      runtimeSessionId: "runtime-session-claude",
      taskBindings: [{ taskId: "task-runtime", executionId: "execution-claude" }],
      liveness: "exited",
      outcome: "succeeded",
      semanticState: "succeeded",
    });
    const executionRelation = runtimeTaskExecutionRelation("runtime-session-claude", "task-runtime");
    assert.equal(projection.readRelationEdge(executionRelation.relation_id)?.relationId, executionRelation.relation_id);
    assert.deepEqual(
      projection.readRuntimeSessionsForTask("task-runtime").map((value) => value.runtimeSessionId),
      ["runtime-session-claude"],
    );
    assert.deepEqual(projection.readRuntimeSessionPage({ limit: 12 }), {
      rows: [session],
      nextRuntimeSessionId: null,
      remainingCount: 0,
    });
    const pageDb = new DatabaseSync(projection.path, { readOnly: true });
    try {
      const primaryPlan = pageDb
          .prepare(
            "EXPLAIN QUERY PLAN SELECT value_json FROM runtime_session WHERE runtime_session_id > ? ORDER BY runtime_session_id LIMIT ?",
          )
          .all("runtime-session", 12) as readonly { readonly detail: string }[],
        taskPlan = pageDb
          .prepare(
            "EXPLAIN QUERY PLAN SELECT runtime_session.value_json FROM runtime_session_task_binding JOIN runtime_session USING(runtime_session_id) WHERE runtime_session_task_binding.task_id = ? AND runtime_session.runtime_session_id > ? GROUP BY runtime_session.runtime_session_id ORDER BY runtime_session.runtime_session_id LIMIT ?",
          )
          .all("task-runtime", "runtime-session", 12) as readonly { readonly detail: string }[];
      assert.match(
        primaryPlan.map(({ detail }) => detail).join("\n"),
        /SEARCH runtime_session USING INDEX .*runtime_session.*runtime_session_id/u,
      );
      assert.match(
        taskPlan.map(({ detail }) => detail).join("\n"),
        /SEARCH runtime_session_task_binding USING COVERING INDEX .*task_id.*runtime_session_id/u,
      );
    } finally {
      pageDb.close();
    }
  });
});

test("projection reopen and rebuild preserve accepted session observations without growing the canonical log", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      original = makeTaskProjection({ rootDir, eventStore: store });
    const started = eventFromProviderWitness(witness("runtime_session_started"), envelope(1))!;
    const exitedStarted = {
      ...started,
      eventId: "event-runtime-2",
      opId: "op-runtime-2",
      workspaceRevision: 2,
      payload: { ...started.payload, runtimeSessionId: "runtime-session-exited" },
    } as AgentRuntimeEventV1;
    const exited = eventFromProviderWitness(
      { ...witness("runtime_session_exited"), payload: { runtimeSessionId: "runtime-session-exited" } },
      envelope(3),
    )!;
    for (const event of [started, exitedStarted, exited]) {
      store.append(bundle(event));
      original.apply(event);
    }
    assert.equal(original.readRuntimeSession("runtime-session-claude")?.liveness, "live");
    assert.equal(original.readRuntimeSession("runtime-session-exited")?.liveness, "exited");
    const before = store.read().revision;
    const reopened = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "live", attachable: false });
    assert.deepEqual(runtimeState(reopened, "runtime-session-exited"), { liveness: "exited", attachable: false });
    assert.equal(store.read().revision, before);
    const rebuilt = reopened.rebuild();
    assert.equal(rebuilt.metrics.sqliteTransactions, 2);
    assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "live", attachable: false });
    assert.deepEqual(runtimeState(reopened, "runtime-session-exited"), { liveness: "exited", attachable: false });
    assert.equal(store.read().revision, before);
    assert.equal(reopened.getEntity("runtime-session", "runtime-session-claude")?.value.semanticState, "running");
    const adopted = eventFromProviderWitness(
      {
        ...witness("heartbeat"),
        type: "runtime_session_liveness_changed",
        payload: { runtimeSessionId: "runtime-session-claude", liveness: "live" },
      },
      envelope(4),
    )!;
    store.append(bundle(adopted));
    reopened.apply(adopted);
    assert.deepEqual(runtimeState(reopened, "runtime-session-claude"), { liveness: "live", attachable: true });
    assert.equal(reopened.read("task-runtime").snapshot.task, null);
  });
});

test("dispatch requested and outcome unknown round-trip without retry or session fabrication", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    const requested = eventFromProviderWitness(witness("runtime_dispatch_requested"), envelope(1))!,
      unknown = eventFromProviderWitness(witness("runtime_dispatch_outcome_unknown"), envelope(2))!;
    for (const event of [requested, unknown]) {
      store.append(bundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
      assert.deepEqual(store.readEvent(event.opId), event);
    }
    assert.equal(store.readHead()?.revision, 2);
    assert.deepEqual(
      store.read().events.map((event) => event.type),
      ["runtime_dispatch_requested", "runtime_dispatch_outcome_unknown"],
    );
    assert.equal(projection.readRuntimeSession("runtime-session-claude"), null);
    projection.rebuild();
    assert.equal(projection.readRuntimeSession("runtime-session-claude"), null);
    assert.equal(store.read().revision, 2);
    assert.throws(
      () =>
        eventFromProviderWitness(
          {
            ...witness("runtime_dispatch_requested"),
            payload: {
              ...witness("runtime_dispatch_requested").payload,
              definitionSnapshotRef: "https://unsafe.example/definition",
            },
          },
          envelope(3),
        ),
      /invalid|incomplete|unknown/iu,
    );
    assert.throws(
      () =>
        eventFromProviderWitness(
          {
            ...witness("runtime_dispatch_outcome_unknown"),
            payload: { ...witness("runtime_dispatch_outcome_unknown").payload, retry: true },
          },
          envelope(3),
        ),
      /invalid|incomplete|unknown/iu,
    );
  });
});

test("session outcome and exit round-trip while exited remains terminal", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    const events = [
      witness("runtime_session_started"),
      witness("runtime_session_outcome_observed"),
      witness("runtime_session_exited"),
    ].map((value, index) => eventFromProviderWitness(value, envelope(index + 1))!);
    for (const event of events) {
      store.append(bundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
      assert.deepEqual(store.readEvent(event.opId), event);
    }
    assert.equal(store.readHead()?.revision, 3);
    assert.deepEqual(projection.readRuntimeSession("runtime-session-claude"), {
      runtimeSessionId: "runtime-session-claude",
      instanceId: "claude-fixture",
      installationId: "installation-claude",
      kindId: "claude",
      definitionSnapshotRef: "artifact:runtime-definitions/claude/v1",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "exited",
      attachable: false,
      taskBindings: [],
      outcome: "succeeded",
      exitCode: 0,
      resultRef: "artifact:runtime-result/sha256/bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787",
      lastObservedAt: "2026-08-12T00:00:03.000Z",
    });
    const liveness = eventFromProviderWitness(
      {
        ...witness("heartbeat"),
        type: "runtime_session_liveness_changed",
        payload: { runtimeSessionId: "runtime-session-claude", liveness: "live" },
      },
      envelope(4),
    )!;
    assert.throws(() => projection.apply(liveness), /already exited/iu);
    assert.equal(projection.readRuntimeSession("runtime-session-claude")?.liveness, "exited");
    assert.equal(store.read().revision, 3);
    assert.throws(
      () =>
        eventFromProviderWitness(
          {
            ...witness("runtime_session_outcome_observed"),
            payload: { ...witness("runtime_session_outcome_observed").payload, resultRef: "inline result" },
          },
          envelope(4),
        ),
      /invalid|incomplete|unknown/iu,
    );
    assert.throws(
      () =>
        eventFromProviderWitness(
          {
            ...witness("runtime_session_exited"),
            payload: { ...witness("runtime_session_exited").payload, reason: "client supplied" },
          },
          envelope(4),
        ),
      /invalid|incomplete|unknown/iu,
    );
  });
});

test("session start projects a pre-launch task binding and provider binding enriches it", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      started = eventFromProviderWitness(
        {
          ...witness("runtime_session_started"),
          payload: {
            ...witness("runtime_session_started").payload,
            taskBinding: { taskId: "task-pre-launch", executionId: "execution-pre-launch" },
          },
        },
        envelope(1),
      )!,
      bound = eventFromProviderWitness(
        {
          ...witness("runtime_session_task_bound"),
          payload: {
            ...witness("runtime_session_task_bound").payload,
            taskId: "task-pre-launch",
            executionId: "execution-pre-launch",
          },
        },
        envelope(2),
      )!;
    for (const event of [started, bound]) {
      store.append(bundle(event));
      projection.apply(event);
    }
    const session = projection.readRuntimeSession("runtime-session-claude")!;
    assert.deepEqual(session.taskBindings, [
      {
        taskId: "task-pre-launch",
        executionId: "execution-pre-launch",
        providerSessionId: bound.payload.providerSessionId,
        transcriptRef: bound.payload.transcriptRef,
        boundAt: bound.occurredAt,
      },
    ]);
  });
});

test("runtime schema rejects credential, transcript body, tool/cost stream, and non-reference transcript data", () => {
  const bound = eventFromProviderWitness(witness("runtime_session_task_bound"), envelope(1))!;
  for (const forbidden of [
    { credential: "secret" },
    { transcript: "full conversation" },
    { tool: { name: "shell" } },
    { cost: { amount: 1 } },
  ])
    assert.match(
      validateCurrentAgentRuntimeEvent({ ...bound, payload: { ...bound.payload, ...forbidden } }).join("\n"),
      /payload/iu,
    );
  assert.throws(
    () =>
      serializeCanonicalEvent({
        ...bound,
        payload: { ...bound.payload, transcriptRef: "full\nconversation" },
      } as AgentRuntimeEventV1),
    /transcript ref|payload/iu,
  );
  const dispatch = witness("runtime_dispatch_requested");
  assert.throws(
    () =>
      eventFromProviderWitness(
        {
          ...dispatch,
          payload: {
            ...dispatch.payload,
            definitionSnapshot: {
              ...(dispatch.payload.definitionSnapshot as Record<string, unknown>),
              credentialRef: "keychain:forbidden",
            },
          },
        },
        envelope(2),
      ),
    /invalid/iu,
  );
  assert.deepEqual(forbiddenKeys(bound), []);
});

test("runtime dispatch history supports keyed reads and done-driven startedAt pages", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "runtime-history", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      requestedBase = witness("runtime_dispatch_requested"),
      startedBase = witness("runtime_session_started"),
      outcomeBase = witness("runtime_session_outcome_observed");
    for (const [index, dispatchId] of ["dispatch_history_1", "dispatch_history_2"].entries()) {
      const requested = eventFromProviderWitness(
          {
            ...requestedBase,
            payload: {
              ...requestedBase.payload,
              dispatchId,
              runtimeSessionId: `runtime-history-${index}`,
              startedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
              ...(index === 1 ? { resumedFromDispatchId: "dispatch_history_1" } : {}),
              taskId: "task-history",
              executionId: "execution-history",
              attemptGroupId: "attempt-history",
              attemptIndex: index,
            },
          },
          envelope(index * 3 + 1),
        )!,
        started = eventFromProviderWitness(
          {
            ...startedBase,
            payload: { ...startedBase.payload, runtimeSessionId: `runtime-history-${index}` },
          },
          envelope(index * 3 + 2),
        )!,
        outcome = eventFromProviderWitness(
          {
            ...outcomeBase,
            payload: {
              ...outcomeBase.payload,
              runtimeSessionId: `runtime-history-${index}`,
              dispatchId,
              endedAt: `2026-09-0${index + 1}T00:01:00.000Z`,
              runtimeMetrics: {
                inputTokens: index + 1,
                cacheReadTokens: 0,
                outputTokens: 2,
                totalTokens: index + 3,
                toolCallCount: 1,
                usageUnavailable: false,
              },
            },
          },
          envelope(index * 3 + 3),
        )!;
      for (const event of [requested, started, outcome]) {
        store.append(bundle(event));
        projection.apply(event);
      }
    }
    assert.equal(projection.readRuntimeDispatchById("dispatch_history_1")?.metrics?.totalTokens, 3);
    assert.equal(
      projection.readRuntimeDispatchByResumeSource("dispatch_history_1")?.event.payload.dispatchId,
      "dispatch_history_2",
    );
    assert.equal(projection.readRuntimeDispatchesByTaskExecution("task-history", "execution-history").length, 2);
    assert.equal(projection.readRuntimeDispatchesByAttemptGroup("attempt-history").length, 2);
    const first = projection.readRuntimeDispatchPage({ startedAtGte: "2026-09-01T00:00:00.000Z", limit: 1 });
    assert.equal(first.done, false);
    assert.ok(first.nextCursor);
    const second = projection.readRuntimeDispatchPage({
      startedAtGte: "2026-09-01T00:00:00.000Z",
      cursor: first.nextCursor,
      limit: 1,
    });
    assert.equal(second.done, true);
    assert.equal(second.nextCursor, null);
    assert.equal(second.rows[0]?.event.payload.dispatchId, "dispatch_history_2");
  });
});

function witness(type: AgentRuntimeEventType | "heartbeat"): ProviderWitnessV1 {
  const value = claude.witnesses.find((candidate) => candidate.type === type);
  if (value === undefined) throw new Error(`missing ${type} witness`);
  return value;
}
function eventFromProviderWitness(
  input: ProviderWitnessV1,
  binding: ReturnType<typeof envelope>,
): AgentRuntimeEventV1 | null {
  if (input.type === "heartbeat") return null;
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: binding.eventId,
    workspaceRevision: binding.workspaceRevision,
    opId: binding.opId,
    actor: binding.actor,
    source: binding.source,
    occurredAt: binding.occurredAt,
    type: input.type,
    payload:
      input.type === "runtime_installation_observed"
        ? {
            ...input.payload,
            protocolFamily: "claude-compatible",
            discoverySource: "wrapper",
            hostRef: binding.hostRef,
          }
        : input.payload,
  } as AgentRuntimeEventV1;
  const errors = validateCurrentAgentRuntimeEvent(event);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return event;
}
function runtimeState(
  projection: ReturnType<typeof makeTaskProjection>,
  runtimeSessionId: string,
): { readonly liveness: string; readonly attachable: boolean } | null {
  const session = projection.readRuntimeSession(runtimeSessionId);
  return session === null ? null : { liveness: session.liveness, attachable: session.attachable };
}
const FIXTURE_RESULT_TEXT = "fixture result"; // sha256 bc4e5d54eb57cccf71e6b1e926ea7fe979ee04cdc883ba550ac827f576e89787, matches both fixtures' runtime_session_outcome_observed.payload.result
function bundle(event: AgentRuntimeEventV1): CanonicalWriteBundle {
  return {
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: FIXTURE_RESULT_TEXT })),
  };
}
function forbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, found);
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, nested] of Object.entries(value)) {
    if (["credential", "transcript", "transcriptBody", "tool", "cost", "stdout", "stderr"].includes(key))
      found.push(key);
    forbiddenKeys(nested, found);
  }
  return found;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Runtime Test");
  git(rootDir, "config", "user.email", "runtime@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
