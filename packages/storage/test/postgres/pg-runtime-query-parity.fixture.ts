import assert from "node:assert/strict";
import type { AgentRuntimeEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

export async function appendRuntimeQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  const installation: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_installation_observed",
    eventId: "event-runtime-query-installation",
    opId: "operation-runtime-query-installation",
    workspaceRevision: revision(),
    occurredAt: "2026-08-30T00:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source: "local",
    payload: {
      installationId: "runtime-query-installation",
      kindId: "codex",
      protocolFamily: "codex-compatible",
      version: "1.0.0",
      discoverySource: "wrapper",
      hostRef: "host:local",
      capabilities: [],
    },
  };
  await append({
    event: installation,
    plan: canonicalEventWritePlan(installation, "agent-runtime/v1", installation.opId),
    blobs: [],
  });
  const started: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_started",
    eventId: "event-runtime-query-start",
    opId: "operation-runtime-query-start",
    workspaceRevision: revision(),
    occurredAt: "2026-08-31T00:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source: "local",
    payload: {
      runtimeSessionId: "runtime-query-session",
      instanceId: "runtime-query-instance",
      installationId: "runtime-query-installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      taskBinding: { taskId: "task-parity", executionId: "execution-parity" },
      launchGeneration: 1,
      attachable: false,
    },
  };
  await append({ event: started, plan: canonicalEventWritePlan(started, "agent-runtime/v1", started.opId), blobs: [] });
  for (const [id, startedAt, extra] of [
    ["runtime-query-a", "2026-09-01T00:00:00.000Z", {}],
    ["runtime-query-b", "2026-09-01T00:00:00.000Z", { resumedFromDispatchId: "runtime-query-a" }],
    [
      "runtime-query-c",
      "2026-09-02T00:00:00.000Z",
      { reviewTarget: { kind: "decision", decisionId: "dec_PG_PARITY", digest: "sha256:" + "1".repeat(64) } },
    ],
  ] as const) {
    const event: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      eventId: `event-${id}`,
      opId: `operation-${id}`,
      workspaceRevision: revision(),
      occurredAt: startedAt,
      actor: { executor: null, principal: { personId: "person_runtime" } },
      source: "local",
      payload: {
        dispatchId: id,
        dispatchKey: `key-${id}`,
        runtimeSessionId: "runtime-query-session",
        instanceId: "runtime-query-instance",
        installationId: "runtime-query-installation",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "runtime-query-instance",
          installationId: "runtime-query-installation",
          kindId: "codex",
          providerId: "openai",
          model: "codex-fixture",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        startedAt,
        taskId: "task-parity",
        executionId: "execution-parity",
        agentId: "parity-agent",
        ...(id === "runtime-query-a" || id === "runtime-query-b"
          ? {
              squadId: "parity-squad",
              squadRun: {
                squadRunId: "squad_aaaaaaaaaaaaaaaaaaaaaaaa",
                squadId: "parity-squad",
                mission: "query contract",
                leaderAgentId: "parity-agent",
                subject: { kind: "task" as const, taskId: "task-parity", executionId: "execution-parity" },
              },
            }
          : {}),
        attemptGroupId: "runtime-query-attempts",
        ...extra,
      },
    };
    await append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
  }
  const outcome: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    type: "runtime_session_outcome_observed",
    eventId: "event-runtime-query-outcome",
    opId: "operation-runtime-query-outcome",
    workspaceRevision: revision(),
    occurredAt: "2026-09-02T01:00:00.000Z",
    actor: { executor: null, principal: { personId: "person_runtime" } },
    source: "local",
    payload: {
      runtimeSessionId: "runtime-query-session",
      dispatchId: "runtime-query-a",
      outcome: "failed",
      exitCode: 1,
      endedAt: "2026-09-02T01:00:00.000Z",
      reasonCode: "fixture_failure",
      resultRef: "artifact:runtime-result/sha256/" + "1".repeat(64),
      result: null,
    },
  };
  await append({ event: outcome, plan: canonicalEventWritePlan(outcome, "agent-runtime/v1", outcome.opId), blobs: [] });
}

/** One contract body is invoked on each backend before the complete results are compared. */
function dispatchContract(
  queries: Pick<
    TaskProjectionQueries,
    keyof Pick<
      PgTaskQueryMethods,
      | "readRuntimeDispatch"
      | "readRuntimeDispatches"
      | "readRuntimeDispatchById"
      | "readRuntimeDispatchByDispatchKey"
      | "readRuntimeDispatchByResumeSource"
      | "readRuntimeDispatchesBySession"
      | "readRuntimeDispatchesByTaskExecution"
      | "readRuntimeDispatchesByAttemptGroup"
      | "readRuntimeDispatchesByDecision"
      | "readRuntimeDispatchPage"
    >
  >,
) {
  const all = queries.readRuntimeDispatches(),
    byId = queries.readRuntimeDispatchById("runtime-query-a");
  assert.equal(all.length, 3);
  assert.equal(byId?.outcome, "failed");
  assert.equal(byId?.endedAt, "2026-09-02T01:00:00.000Z");
  assert.equal(queries.readRuntimeDispatchById("missing"), null);
  assert.equal(queries.readRuntimeDispatch("missing"), null);
  assert.equal(queries.readRuntimeDispatch("runtime-query-session", "missing"), null);
  assert.equal(queries.readRuntimeDispatchById("runtime-query-b")?.outcome, null);
  const pages = [],
    limit = 1;
  let cursor: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]["cursor"];
  for (;;) {
    const page = queries.readRuntimeDispatchPage({
      startedAtGte: "2026-09-01T00:00:00.000Z",
      limit,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    if (page.done) break;
    assert.ok(page.nextCursor);
    assert.notDeepEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
    assert.ok(pages.length <= 3);
  }
  assert.deepEqual(
    pages.flatMap(({ rows }) => rows.map(({ event }) => event.payload.dispatchId)),
    ["runtime-query-a", "runtime-query-b", "runtime-query-c"],
  );
  assert.throws(() => queries.readRuntimeDispatchPage({ startedAtGte: "", limit: 0 }), /limit/);
  assert.throws(() => queries.readRuntimeDispatchPage({ startedAtGte: "", limit: 501 }), /limit/);
  return {
    all,
    byId,
    pages,
    dispatch: queries.readRuntimeDispatch("runtime-query-session"),
    definition: queries.readRuntimeDispatch("runtime-query-session", "artifact:runtime-definitions/codex/v1"),
    key: queries.readRuntimeDispatchByDispatchKey("key-runtime-query-b"),
    resume: queries.readRuntimeDispatchByResumeSource("runtime-query-a"),
    session: queries.readRuntimeDispatchesBySession("runtime-query-session"),
    execution: queries.readRuntimeDispatchesByTaskExecution("task-parity", "execution-parity"),
    attempts: queries.readRuntimeDispatchesByAttemptGroup("runtime-query-attempts"),
    decisions: queries.readRuntimeDispatchesByDecision("dec_PG_PARITY"),
    empty: queries.readRuntimeDispatchPage({ startedAtGte: "2027-01-01T00:00:00.000Z", limit: 1 }),
  };
}
export function assertRuntimeQueryParity(pg: PgTaskQueryMethods, sqlite: TaskProjectionQueries): void {
  assert.deepEqual(dispatchContract(pg), dispatchContract(sqlite));
}
