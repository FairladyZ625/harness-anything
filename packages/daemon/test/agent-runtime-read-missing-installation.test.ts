// harness-test-tier: integration
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
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import { validateAgentRuntimeOverview, validateAgentRuntimeSession } from "../src/agent-runtime-contract.ts";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";

const actor = { principal: { personId: "person-runtime" }, executor: null } as const;

test("runtime reads retain a session whose installation witness is missing", (t) =>
  withRuntime(false, ({ reads }) => {
    const overview = reads.overview({}),
      session = overview.sessions[0]!;
    assert.equal(overview.status, "ready");
    assert.equal(session.runtimeSessionId, "runtime-historical");
    assert.equal(session.kindId, "claude");
    assert.equal(session.attachCapability, "unsupported");
    assert.equal(session.installationState, "missing");
    assert.deepEqual(session.installationError, {
      code: "runtime_installation_not_found",
      hint: "Runtime installation installation-missing was not found.",
    });
    assert.deepEqual(validateAgentRuntimeOverview(overview), []);
    const single = reads.session({ runtimeSessionId: session.runtimeSessionId });
    assert.deepEqual(single.session, session);
    assert.deepEqual(validateAgentRuntimeSession(single), []);
    t.diagnostic(JSON.stringify({ status: overview.status, session }));
  }));

test("an installation-backed session DTO remains byte-for-byte unchanged", () =>
  withRuntime(true, ({ reads }) => {
    const session = reads.overview({}).sessions[0]!;
    assert.equal(
      JSON.stringify(session),
      JSON.stringify({
        runtimeSessionId: "runtime-historical",
        providerSessionId: null,
        instanceId: "instance-historical",
        installationId: "installation-present",
        kindId: "claude",
        definitionSnapshotRef: "artifact:runtime-definition/test",
        definitionSnapshot: definition("installation-present"),
        definitionSnapshotPersisted: false,
        liveness: "live",
        semanticState: "running",
        attachCapability: "supported",
        streamCursor: "stream:0",
        associations: [],
        activity: {
          lastObservedAt: "2026-09-03T00:00:03.000Z",
          outcome: null,
          exitCode: null,
          resultRef: null,
          missingEvidence: null,
        },
      }),
    );
    assert.equal(Object.hasOwn(session, "installationState"), false);
    assert.equal(Object.hasOwn(session, "installationError"), false);
  }));

function withRuntime(
  installationPresent: boolean,
  use: (fixture: { readonly reads: ReturnType<typeof makeAgentRuntimeReadModel> }) => void,
): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-missing-installation-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Runtime Test"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "runtime@example.invalid"]);
    execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
    const store = makeTaskEventStore({ repoId: "runtime-missing-installation", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const installationId = installationPresent ? "installation-present" : "installation-missing";
    for (const event of events(installationId)) {
      store.append({ event, plan: runtimeWritePlan(event), blobs: [] });
      projection.apply(event);
    }
    const stream = makeAgentRuntimeStreamHub({
      readSession: (runtimeSessionId) => projection!.readRuntimeSession(runtimeSessionId),
      canAttach: () => true,
    });
    use({ reads: makeAgentRuntimeReadModel({ store, projection, stream }) });
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function events(installationId: string): readonly AgentRuntimeEventV1[] {
  const snapshot = definition(installationId);
  return [
    event(
      "runtime_installation_observed",
      {
        installationId: "installation-present",
        kindId: "claude",
        protocolFamily: "claude-compatible",
        hostRef: "host:local",
        version: "1.0.0",
        discoverySource: "wrapper",
        capabilities: ["structured_witness", "attach"],
      },
      1,
    ),
    event(
      "runtime_dispatch_requested",
      {
        dispatchId: "dispatch-historical",
        runtimeSessionId: "runtime-historical",
        instanceId: snapshot.instanceId,
        installationId,
        kindId: snapshot.kindId,
        idempotencyKey: "historical-once",
        definitionSnapshotRef: "artifact:runtime-definition/test",
        definitionSnapshot: snapshot,
      },
      2,
    ),
    event(
      "runtime_session_started",
      {
        runtimeSessionId: "runtime-historical",
        instanceId: snapshot.instanceId,
        installationId,
        kindId: snapshot.kindId,
        definitionSnapshotRef: "artifact:runtime-definition/test",
        launchGeneration: 1,
        attachable: true,
      },
      3,
    ),
  ];
}

function definition(installationId: string): AgentDefinitionSnapshot {
  return {
    authMode: "subscription",
    baseUrl: null,
    configVersion: 1,
    installationId,
    instanceId: "instance-historical",
    kindId: "claude",
    model: "claude-opus",
    providerId: "anthropic",
    reasoningEffort: null,
    schema: "agent-definition-snapshot/v1",
  };
}

function event<T extends AgentRuntimeEventV1["type"]>(
  type: T,
  payload: Extract<AgentRuntimeEventV1, { readonly type: T }>["payload"],
  revision: number,
): AgentRuntimeEventV1 {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    actor,
    source: "local",
    occurredAt: `2026-09-03T00:00:0${revision}.000Z`,
    type,
    payload,
  } as AgentRuntimeEventV1;
}

function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return Object.freeze({
    commandType: event.type,
    targets: Object.freeze(
      [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "agent-runtime/v1", key: event.opId },
      ].map((target) => Object.freeze(target)),
    ),
  }) as FrozenWritePlan;
}
