// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  eventObjectTarget,
  makeTaskEventStore,
  makeTaskProjection,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";

test("runtime lifecycle cursors stay at the projection cut while the canonical stream is ahead", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-read-cut-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined,
    store: ReturnType<typeof makeTaskEventStore> | undefined;
  try {
    initRepo(rootDir);
    store = makeTaskEventStore({ repoId: "runtime-read-cut", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const events = runtimeEvents();
    for (const event of events) store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
    projection.apply(events[0]!);
    projection.apply(events[1]!);

    const reads = makeAgentRuntimeReadModel({ store, projection, stream: {} as never }),
      lagged = reads.events({ runtimeSessionId: "runtime-session", afterCursor: "lifecycle:0" });
    assert.deepEqual(lagged, {
      ok: true,
      runtimeSessionId: "runtime-session",
      events: [
        {
          cursor: "lifecycle:2",
          runtimeSessionId: "runtime-session",
          type: "runtime_dispatch_requested",
          occurredAt: "2026-09-03T00:00:02.000Z",
        },
      ],
      cursor: "lifecycle:2",
      sourceCursor: "lifecycle:2",
      done: true,
    });
    assert.throws(
      () => reads.events({ runtimeSessionId: "runtime-session", afterCursor: "lifecycle:3" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_cursor",
    );

    projection.apply(events[2]!);
    const continued = reads.events({ runtimeSessionId: "runtime-session", afterCursor: lagged.cursor }),
      synchronized = reads.events({ runtimeSessionId: "runtime-session", afterCursor: "lifecycle:0" }),
      expectedSynchronized = {
        ok: true,
        runtimeSessionId: "runtime-session",
        events: [
          {
            cursor: "lifecycle:2",
            runtimeSessionId: "runtime-session",
            type: "runtime_dispatch_requested",
            occurredAt: "2026-09-03T00:00:02.000Z",
          },
          {
            cursor: "lifecycle:3",
            runtimeSessionId: "runtime-session",
            type: "runtime_session_started",
            occurredAt: "2026-09-03T00:00:03.000Z",
          },
        ],
        cursor: "lifecycle:3",
        sourceCursor: "lifecycle:3",
        done: true,
      };
    assert.deepEqual(
      [...lagged.events, ...continued.events].map(({ type }) => type),
      expectedSynchronized.events.map(({ type }) => type),
    );
    assert.equal(JSON.stringify(synchronized), JSON.stringify(expectedSynchronized));
    t.diagnostic(`lagged=${JSON.stringify(lagged)}`);
    t.diagnostic(`continued=${JSON.stringify(continued)}`);
    t.diagnostic(`synchronized-bytes=${JSON.stringify(synchronized)}`);
  } finally {
    await store?.drain();
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function runtimeEvents(): readonly AgentRuntimeEventV1[] {
  const actor = { principal: { personId: "person-runtime-cut" }, executor: null } as const,
    definition = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "instance-runtime",
      installationId: "installation-runtime",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      baseUrl: null,
      authMode: "subscription",
    } as const;
  return [
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-installation",
      workspaceRevision: 1,
      opId: "op-runtime-installation",
      actor,
      source: "local",
      occurredAt: "2026-09-03T00:00:01.000Z",
      type: "runtime_installation_observed",
      payload: {
        installationId: definition.installationId,
        kindId: definition.kindId,
        protocolFamily: "codex",
        hostRef: "host:local",
        version: "1.0.0",
        discoverySource: "wrapper",
        capabilities: ["structured_witness", "attach"],
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-dispatch",
      workspaceRevision: 2,
      opId: "op-runtime-dispatch",
      actor,
      source: "local",
      occurredAt: "2026-09-03T00:00:02.000Z",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: "dispatch-runtime",
        runtimeSessionId: "runtime-session",
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        idempotencyKey: "runtime-read-cut",
        definitionSnapshotRef: "artifact:runtime-definition/test",
        definitionSnapshot: definition,
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-session",
      workspaceRevision: 3,
      opId: "op-runtime-session",
      actor,
      source: "local",
      occurredAt: "2026-09-03T00:00:03.000Z",
      type: "runtime_session_started",
      payload: {
        runtimeSessionId: "runtime-session",
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        definitionSnapshotRef: "artifact:runtime-definition/test",
        launchGeneration: 1,
        attachable: true,
      },
    },
  ];
}

function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return Object.freeze({
    commandType: event.type,
    targets: Object.freeze([
      Object.freeze({ kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" }),
      Object.freeze({ kind: "event_head", path: "harness/events/head.json", operation: "replace" }),
      Object.freeze({ kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId }),
    ]),
  }) as FrozenWritePlan;
}

function initRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Runtime Read Cut Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "runtime-read-cut@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
}
