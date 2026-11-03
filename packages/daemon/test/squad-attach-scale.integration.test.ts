// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { resolveHarnessLayout, type AgentRuntimeEventV1, type CanonicalWriteBundle } from "@harness-anything/kernel";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
} from "../src/dispatch-stream.ts";
import { pruneDispatchStreamArchive } from "../src/dispatch-stream-archive.ts";
import { readSquadRecoveryState } from "../src/squad-run-state.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openFencedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const actor = { principal: { personId: "person-scale" }, executor: null } as const,
  runId = "squad_0123456789abcdef01234567",
  ownerDispatchId = "dispatch_000000000000000000000001",
  runtimeSessionId = "runtime-scale-owner";

test("active Squad recovery hydration stays flat when a valid ledger event count doubles", async (t) => {
  const samples: {
    readonly events: number;
    readonly recoveredRuns: number;
    readonly hydrationMs: number;
  }[] = [];
  for (const eventCount of [1_000, 2_000]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-attach-scale-"));
    try {
      initRepo(rootDir);
      const store = makeTaskEventStore({ repoId: `squad-scale-${eventCount}`, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: store });
      try {
        openDispatchStream(rootDir, {
          dispatchId: ownerDispatchId,
          taskId: null,
          executionId: null,
          runtimeSessionId,
          instanceId: "instance-scale",
          startedAt: "2026-08-27T00:00:00.000Z",
        });
        appendRuntimeWorkerRecord(rootDir, ownerDispatchId, {
          kind: "squad_run_state",
          state: localSquadState(rootDir),
        });
        const events = scaleEvents(eventCount),
          members = events.map(writeBundle),
          last = members.at(-1)!;
        store.append({ ...last, preceding: members.slice(0, -1) });
        projection.catchUp();
        assert.equal(store.readHead()?.revision, eventCount);
        assert.equal(projection.readCut().watermark, eventCount);
        assert.equal(projection.readSquadRuns().length, 1);

        const started = performance.now();
        const restored = readSquadRecoveryState(rootDir, projection),
          hydrationMs = performance.now() - started;
        assert.equal(restored.states.get(runId)?.phase, "leader_running");
        assert.deepEqual([...restored.protectedDispatchIds], [ownerDispatchId]);
        samples.push({ events: eventCount, recoveredRuns: restored.states.size, hydrationMs });
      } finally {
        projection.close();
        await store.drain();
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
  t.diagnostic(`valid ledger event scale=${JSON.stringify(samples)}`);
  assert.equal(samples[1]?.events, 2 * samples[0]!.events);
  assert.equal(samples[0]?.recoveredRuns, samples[1]?.recoveredRuns);
});

test("recovery cost ignores unrelated archive count and retention preserves unpublished owner state", async (t) => {
  const samples: { readonly archives: number; readonly archiveBytes: number; readonly hydrationMs: number }[] = [];
  for (const archives of [100, 1_000]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-archive-scale-"));
    try {
      initRepo(rootDir);
      const store = makeTaskEventStore({ repoId: `squad-archive-${archives}`, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: store });
      try {
        openDispatchStream(rootDir, {
          dispatchId: ownerDispatchId,
          taskId: null,
          executionId: null,
          runtimeSessionId,
          instanceId: "instance-scale",
          startedAt: "2026-08-27T00:00:00.000Z",
        });
        appendRuntimeWorkerRecord(rootDir, ownerDispatchId, {
          kind: "squad_run_state",
          state: localSquadState(rootDir),
        });
        const members = scaleEvents(2).map(writeBundle),
          last = members.at(-1)!;
        store.append({ ...last, preceding: members.slice(0, -1) });
        projection.catchUp();
        archiveDispatchStream(rootDir, ownerDispatchId);

        const archiveRoot = writeUnrelatedArchives(rootDir, archives);
        const archiveBytes = fs
          .readdirSync(archiveRoot)
          .reduce((sum, name) => sum + fs.statSync(path.join(archiveRoot, name)).size, 0);
        assert.equal(fs.readdirSync(archiveRoot).length, archives + 1);
        const originalReaddir = fs.readdirSync;
        t.mock.method(fs, "readdirSync", (target, ...args) => {
          if (path.resolve(String(target)) === archiveRoot)
            throw new Error("Squad recovery enumerated unrelated dispatch archives");
          return originalReaddir(target, ...args);
        });
        syncBuiltinESMExports();
        const started = performance.now();
        let recovered;
        try {
          recovered = readSquadRecoveryState(rootDir, projection);
        } finally {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        }
        const hydrationMs = performance.now() - started,
          protectedIds = [...recovered.protectedDispatchIds];
        assert.deepEqual(protectedIds, [ownerDispatchId]);
        pruneDispatchStreamArchive(
          rootDir,
          { retentionDays: 1, retentionBytes: 1 },
          [],
          Date.parse("2026-11-03T00:00:00.000Z"),
          protectedIds,
        );
        assert.deepEqual(fs.readdirSync(archiveRoot), [`${ownerDispatchId}.jsonl`]);
        assert.equal(recovered.states.get(runId)?.phase, "leader_running");
        assert.ok(fs.existsSync(path.join(archiveRoot, `${ownerDispatchId}.jsonl`)));
        samples.push({ archives, archiveBytes, hydrationMs });
      } finally {
        projection.close();
        await store.drain();
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
  t.diagnostic(`retained dispatch archive scale=${JSON.stringify(samples)}`);
  assert.equal(samples[1]?.archives, 10 * samples[0]!.archives);
  assert.ok(samples[1]!.archiveBytes > samples[0]!.archiveBytes);
});

test("repo ready and first durable write stay flat as ledger and archive sizes grow", async (t) => {
  const samples: {
    readonly events: number;
    readonly archives: number;
    readonly archiveBytes: number;
    readonly readyMs: number;
    readonly firstWriteMs: number;
  }[] = [];
  for (const { events, archives } of [
    { events: 1_000, archives: 100 },
    { events: 2_000, archives: 100 },
    { events: 2, archives: 100 },
    { events: 2, archives: 1_000 },
  ]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-ready-write-scale-")),
      repoId = `squad-ready-write-${archives}`;
    let cell: Awaited<ReturnType<typeof openFencedRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      await seedSquadLedger(rootDir, repoId, events, archives === 1_000);
      const archiveRoot = writeUnrelatedArchives(rootDir, archives),
        archiveBytes = fs
          .readdirSync(archiveRoot)
          .reduce((sum, name) => sum + fs.statSync(path.join(archiveRoot, name)).size, 0);
      const attachStarted = performance.now();
      cell = await openFencedRepoCell({
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(rootDir),
        ownerId: `scale-writer-${archives}`,
      });
      const readyMs = performance.now() - attachStarted,
        binding = withPolicyGroup(
          {
            actor: { principal: { personId: `scale-writer-${events}-${archives}` }, executor: null },
            source: "local" as const,
          },
          "admin",
        ),
        writeStarted = performance.now(),
        receipt = await cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_installation_observed",
            opId: `attach-scale-write-${archives}`,
            payload: {
              installationId: `installation-attach-scale-${archives}`,
              kindId: "attach-scale",
              protocolFamily: "attach-scale",
              hostRef: "host:local",
              version: "1.0.0",
              discoverySource: "wrapper",
              capabilities: [],
            },
          },
          binding,
        ),
        firstWriteMs = performance.now() - writeStarted;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      samples.push({ events, archives, archiveBytes, readyMs, firstWriteMs });
    } finally {
      await cell?.close();
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
  t.diagnostic(`repo ready and first-write archive scale=${JSON.stringify(samples)}`);
  assert.equal(samples[1]?.events, 2 * samples[0]!.events);
  assert.equal(samples[1]?.archives, samples[0]?.archives);
  assert.equal(samples[2]?.events, 2);
  assert.equal(samples[2]?.archives, samples[0]?.archives);
  assert.equal(samples[3]?.events, 2);
  assert.equal(samples[3]?.archives, 10 * samples[2]!.archives);
  assert.ok(samples[3]!.archiveBytes > samples[2]!.archiveBytes);
  assert.ok(samples.every((sample) => sample.readyMs < 30_000 && sample.firstWriteMs < 30_000));
});

test("retention releases an acknowledged terminal Squad owner archive", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-terminal-retention-"));
  try {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "squad-terminal-retention", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      openDispatchStream(rootDir, {
        dispatchId: ownerDispatchId,
        taskId: null,
        executionId: null,
        runtimeSessionId,
        instanceId: "instance-scale",
        startedAt: "2026-08-27T00:00:00.000Z",
      });
      appendRuntimeWorkerRecord(rootDir, ownerDispatchId, {
        kind: "squad_run_state",
        state: localSquadState(rootDir, "converged"),
      });
      appendRuntimeWorkerRecord(rootDir, ownerDispatchId, {
        kind: "squad_run_publication_ack",
        squadRunId: runId,
        revision: 2,
      });
      const events = scaleEvents(2, "converged"),
        members = events.map(writeBundle),
        last = members.at(-1)!;
      store.append({ ...last, preceding: members.slice(0, -1) });
      projection.catchUp();
      archiveDispatchStream(rootDir, ownerDispatchId);

      const recovery = readSquadRecoveryState(rootDir, projection),
        archiveRoot = path.dirname(dispatchStreamPath(rootDir, ownerDispatchId)),
        archivePath = path.join(archiveRoot, `${ownerDispatchId}.jsonl`);
      assert.equal(recovery.states.size, 0);
      assert.deepEqual([...recovery.protectedDispatchIds], []);
      pruneDispatchStreamArchive(
        rootDir,
        { retentionDays: 1, retentionBytes: 1 },
        [],
        Date.parse("2026-11-03T00:00:00.000Z"),
        [...recovery.protectedDispatchIds],
      );
      assert.equal(fs.existsSync(archivePath), false);
    } finally {
      projection.close();
      await store.drain();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function scaleEvents(
  total: number,
  phase: "leader_running" | "converged" = "leader_running",
): readonly AgentRuntimeEventV1[] {
  const subject = { kind: "task" as const, taskId: "task-scale", executionId: "execution-scale" },
    events: AgentRuntimeEventV1[] = [
      event(1, "runtime_dispatch_requested", {
        dispatchId: ownerDispatchId,
        runtimeSessionId,
        instanceId: "instance-scale",
        installationId: "installation-scale",
        kindId: "scale-provider",
        dispatchKey: "scale-dispatch-key",
        definitionSnapshotRef: "artifact:runtime-definitions/scale/v1",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "instance-scale",
          installationId: "installation-scale",
          kindId: "scale-provider",
          providerId: "scale-provider",
          model: "scale-model",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        squadRun: {
          squadRunId: runId,
          squadId: "scale-squad",
          subject,
          mission: "Scale attach recovery",
          leaderAgentId: "leader",
        },
      }),
      event(2, "runtime_squad_run_observed", {
        squadRunId: runId,
        squadId: "scale-squad",
        subject,
        mission: "Scale attach recovery",
        leaderAgentId: "leader",
        ownerDispatchId,
        runRevision: phase === "leader_running" ? 1 : 2,
        phase,
        error: null,
        currentLeaderRuntimeSessionId: runtimeSessionId,
        leaderTurns: [],
        workerAttempts: [],
        workerCallbackCount: 0,
        pendingLeaderCallbackCount: 0,
        synthesisReportPath: null,
      }),
    ];
  for (let revision = 3; revision <= total; revision += 1)
    events.push(
      event(revision, "runtime_installation_observed", {
        installationId: "installation-scale",
        kindId: "scale-provider",
        protocolFamily: "scale-provider",
        hostRef: "host:local",
        version: "1.0.0",
        discoverySource: "wrapper",
        capabilities: [],
      }),
    );
  return events;
}

function event<T extends AgentRuntimeEventV1["type"]>(
  revision: number,
  type: T,
  payload: Extract<AgentRuntimeEventV1, { readonly type: T }>["payload"],
): Extract<AgentRuntimeEventV1, { readonly type: T }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-scale-${revision}`,
    workspaceRevision: revision,
    opId: `op-scale-${revision}`,
    type,
    actor,
    source: "local",
    occurredAt: new Date(Date.parse("2026-08-27T00:00:00.000Z") + revision).toISOString(),
    payload,
  } as Extract<AgentRuntimeEventV1, { readonly type: T }>;
}

function writeBundle(event: AgentRuntimeEventV1): CanonicalWriteBundle {
  return {
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: [],
  };
}

function writeUnrelatedArchives(rootDir: string, archives: number): string {
  const archiveRoot = path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches", "archive"),
    payload = "x".repeat(1_024);
  mkdirSync(archiveRoot, { recursive: true });
  for (let index = 2; index <= archives + 1; index += 1) {
    const dispatchId = `dispatch_${index.toString(16).padStart(24, "0")}`;
    writeFileSync(
      path.join(archiveRoot, `${dispatchId}.jsonl`),
      `${JSON.stringify({
        schema: "runtime-dispatch-stream/v1",
        kind: "dispatch",
        dispatchId,
        taskId: null,
        executionId: null,
        runtimeSessionId: `runtime-${index}`,
        instanceId: "instance-scale",
        startedAt: "2026-08-27T00:00:00.000Z",
        eventStreamRef: `.harness/runtime/dispatches/${dispatchId}.jsonl`,
      })}\n${JSON.stringify({
        schema: "runtime-dispatch-stream/v1",
        kind: "provider_event",
        occurredAt: "2026-08-27T00:00:01.000Z",
        event: { type: "provider.output", payload },
      })}\n`,
    );
  }
  return archiveRoot;
}

async function seedSquadLedger(
  rootDir: string,
  repoId: string,
  eventCount: number,
  archiveOwner: boolean,
): Promise<void> {
  const store = makeTaskEventStore({ repoId: workspaceId(repoId), rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store });
  try {
    openDispatchStream(rootDir, {
      dispatchId: ownerDispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "instance-scale",
      startedAt: "2026-08-27T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, ownerDispatchId, {
      kind: "squad_run_state",
      state: localSquadState(rootDir),
    });
    const members = scaleEvents(eventCount).map(writeBundle),
      last = members.at(-1)!;
    store.append({ ...last, preceding: members.slice(0, -1) });
    projection.catchUp();
    assert.equal(store.readHead()?.revision, eventCount);
    assert.equal(projection.readCut().watermark, eventCount);
    assert.equal(projection.readSquadRuns().length, 1);
    if (archiveOwner) archiveDispatchStream(rootDir, ownerDispatchId);
  } finally {
    projection.close();
    await store.drain();
  }
}

function localSquadState(rootDir: string, phase: "leader_running" | "cancelled" | "converged" = "leader_running") {
  return {
    schema: "squad-run/v1",
    squadRunId: runId,
    stateDispatchId: ownerDispatchId,
    squadId: "scale-squad",
    subject: { kind: "task", taskId: "task-scale", executionId: "execution-scale" },
    scheduleRuntime: null,
    runtimeInstanceId: "instance-scale",
    cwd: rootDir,
    baseSha: null,
    mission: "Scale attach recovery",
    publicMission: "Scale attach recovery",
    model: null,
    effort: null,
    permissionMode: null,
    leaderAgentId: "leader",
    roster: "leader",
    workers: [],
    leaderTurnBudget: 1,
    binding: { actor, source: "local" },
    leaderTurns: [],
    leaderProviderSessionId: null,
    currentLeaderRuntimeSessionId: phase === "leader_running" ? runtimeSessionId : null,
    workerAttempts: [],
    observedWorkerRuntimeSessionIds: [],
    workerWaits: [],
    pendingLeaderTriggers: [],
    phase,
    revision: phase === "leader_running" ? 1 : 2,
    error: null,
  } as const;
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Squad Attach Scale Test");
  git(rootDir, "config", "user.email", "squad-scale@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
