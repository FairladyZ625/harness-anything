import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  makeTaskProjection,
  edgeReadAuthorizationShapeDigest,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { centerEdgeReadModel } from "../src/fleet/replica-read-model.ts";
import type { ReplicaAckStore } from "../src/fleet/replica-ack-store.ts";

/** Seed completed projection rows; publication, frames, CAS, receiver and queries are production paths. */
export function repositoryCutFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-families-"));
  let revision = 100;
  const contents = new Map<string, Uint8Array>();
  const head = () => ({ ...lifecycleFixture().events[0]!, workspaceRevision: revision, opId: `cut-${revision}` });
  const center = makeTaskProjection({
    rootDir: root,
    eventStore: {
      readHead: () => ({ revision }),
      readBatch: () => {
        throw new Error("a completed projection read must not scan canonical events");
      },
      readContentBlob: (sha: string) => contents.get(sha) ?? null,
    },
  });
  center.readCut();
  const db = new DatabaseSync(center.path);
  const seal = () =>
    db
      .prepare("UPDATE projection_meta SET watermark = ?, scanned_revision = ? WHERE singleton = 1")
      .run(revision, revision);
  seal();
  const source = openReplicaCutSource({
    repoId: "families",
    localRoot: path.join(root, "publisher"),
    readBasis: (after) => ({
      watermark: revision,
      sourceRevision: revision,
      headEvent: head(),
      events:
        after !== null && after < revision
          ? Array.from({ length: revision - after }, (_, offset) => ({
              ...head(),
              workspaceRevision: after + offset + 1,
              opId: `cut-${after + offset + 1}`,
            }))
          : [],
      documents: [],
    }),
    readContentBlob: (sha: string) => contents.get(sha) ?? null,
    readEdgeReadModel: (read) => centerEdgeReadModel(center, read),
  });
  const viewRoot = path.join(root, "edge"),
    receiver = openFleetEdgeView(viewRoot, 64 * 1024 * 1024);
  const key = { nodeId: "edge", viewId: "edge", repoId: "families" };
  let cursor: ReturnType<ReplicaAckStore["cursor"]> = null;
  t.after(() => {
    source.close();
    db.close();
    center.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    contents,
    center,
    source,
    viewRoot,
    next: async (count = 1) => {
      revision += count;
      seal();
      source.kick();
      await source.waitForCut(revision);
    },
    read: <T>(query: (projection: TaskProjectionQueries) => T, principalId = "owner") =>
      withEdgeReadModel({ viewRoot, repoId: "families", nodeId: "edge", principalId }, query),
    transfer: async (kind: "snapshot" | "delta", omitBlob?: string) => {
      const cut = await source.prepare();
      assert.ok(cut);
      const offer = { ...key, ...(await makeOffer(key, cursor, cut, source, "2026-10-07T00:00:00Z")) };
      assert.equal(offer.kind, kind);
      const frames = [];
      for await (const frame of offerFrames(offer, source, {
        owner: "owner",
        digest: edgeReadAuthorizationShapeDigest({ repoId: "families", owner: "owner" }),
      })) {
        frames.push(frame);
        if (
          !(
            (frame.schema === "fleet.snapshot.chunk/v1" || frame.schema === "fleet.delta.chunk/v1") &&
            frame.blobSha256 === omitBlob
          )
        )
          receiver.receive(frame);
      }
      cursor = {
        revision: cut.revision,
        headDigest: cut.headDigest,
        manifestDigest: cut.manifest.digest,
      } as ReturnType<ReplicaAckStore["cursor"]>;
      return frames;
    },
  };
}

export function seedRepositoryFamilies(db: DatabaseSync) {
  for (const n of [1, 2]) {
    db.prepare("INSERT INTO runtime_installation VALUES (?, ?, ?)").run(
      `installation-${n}`,
      n,
      JSON.stringify({ installationId: `installation-${n}`, hostRef: "/private/owner/provider-home", version: "1" }),
    );
    db.prepare("INSERT INTO runtime_session VALUES (?, ?, ?)").run(
      `runtime-${n}`,
      n,
      JSON.stringify({
        runtimeSessionId: `runtime-${n}`,
        installationId: `installation-${n}`,
        liveness: "live",
        transcriptRef: "file:/private/owner/session.jsonl",
        attachable: true,
        taskBindings: [],
      }),
    );
    db.prepare("INSERT INTO runtime_session_task_binding VALUES (?, ?, ?, ?)").run(
      "task-1",
      `runtime-${n}`,
      "execution-1",
      "2026-10-07T00:00:00Z",
    );
  }
  db.prepare("INSERT INTO pinned_entities VALUES (?, ?, ?)").run("squad/squad-1", "2026-10-07T00:00:00Z", "owner");
  db.prepare("INSERT INTO lease_interval VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "task-1",
    "execution-1",
    1,
    null,
    JSON.stringify({ principal: { personId: "owner" }, executor: null }),
    null,
    "2026-10-08T00:00:00Z",
    "acquired",
  );
  db.prepare("INSERT INTO squad_run_projection VALUES (?, ?, ?)").run(
    "squad_111111111111111111111111",
    1,
    JSON.stringify({ squadRunId: "squad_111111111111111111111111", phase: "planning" }),
  );
  for (const [kind, id] of [
    ["squad", "squad-1"],
    ["schedule", "schedule-1"],
    ["settings", "repository"],
  ])
    db.prepare("INSERT INTO entity_projection VALUES (?, ?, '', ?, 'current', ?, ?)").run(
      kind,
      id,
      kind === "settings" ? 10 : 1,
      kind === "settings" ? 10 : 1,
      JSON.stringify({ name: id }),
    );
  const actor = { principal: { personId: "owner" }, executor: { kind: "agent", id: "runtime-session:runtime-1" } };
  const events = [
    {
      schema: "settings-event/v1",
      type: "settings_changed",
      workspaceRevision: 10,
      payload: { settings: { name: "repository" } },
    },
    ...[1, 2].map((n) => ({
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      workspaceRevision: 10 + n,
      payload: {
        runtimeSessionId: `runtime-${n}`,
        instanceId: "instance-1",
        installationId: "installation-1",
        kindId: "codex",
        idempotencyKey: `dispatch-${n}`,
        definitionSnapshotRef: "artifact:runtime-definition/test",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "instance-1",
          installationId: "installation-1",
          kindId: "codex",
          providerId: "openai",
          model: "fixture",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        cwd: "/private/owner/worktree",
        dispatchId: `dispatch-${n}`,
        taskId: "task-1",
        executionId: "execution-1",
        attemptGroupId: "attempt-1",
        startedAt: "2026-10-07T00:00:00Z",
      },
    })),
    {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      workspaceRevision: 13,
      payload: {
        runtimeSessionId: "runtime-1",
        dispatchId: "dispatch-1",
        outcome: "succeeded",
        exitCode: 0,
        resultRef: null,
        result: null,
        endedAt: "2026-10-07T01:00:00Z",
      },
    },
    {
      schema: "schedule-event/v1",
      type: "schedule_created",
      workspaceRevision: 14,
      entity: { kind: "schedule", id: "schedule-1" },
      payload: { schedule: { status: { lastRun: null } } },
    },
    {
      schema: "ci-run-observation/v3",
      type: "ci_run_observed",
      workspaceRevision: 15,
      payload: { run: { runId: "run-1" }, tests: [], gates: [] },
    },
    {
      schema: "fact-event/v1",
      type: "fact_recorded",
      workspaceRevision: 16,
      payload: { statement: "scheduled output" },
    },
    {
      schema: "task-event/v1",
      type: "task_created",
      workspaceRevision: 17,
      actor: { principal: { personId: "owner" }, executor: null },
      payload: {},
    },
  ];
  for (const event of events)
    db.prepare("INSERT INTO event_index VALUES (?, ?, NULL, ?)").run(
      `op-${event.workspaceRevision}`,
      event.workspaceRevision,
      JSON.stringify({
        actor,
        source: "local",
        eventId: `event-${event.workspaceRevision}`,
        occurredAt: "2026-10-07T00:00:00Z",
        opId: `op-${event.workspaceRevision}`,
        ...event,
      }),
    );
}

/** Transfer a real cell cut through the production replica receiver for offline edge queries. */
export async function materializeCellReplica(
  rootDir: string,
  repoId: string,
  owner: string,
  source: import("../src/fleet/replica-cut-store.ts").ReplicaCutSource,
) {
  const viewRoot = path.join(rootDir, ".fleet-view"),
    key = { repoId, nodeId: "test-edge", viewId: "test-edge" },
    cut = await source.prepare();
  assert.ok(cut);
  const receiver = openFleetEdgeView(viewRoot, 64 * 1024 * 1024),
    offer = { ...key, ...(await makeOffer(key, null, cut, source, new Date().toISOString())) };
  for await (const frame of offerFrames(offer, source, {
    owner,
    digest: edgeReadAuthorizationShapeDigest({ repoId, owner }),
  }))
    receiver.receive(frame);
  writeFileSync(
    path.join(rootDir, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId,
      nodeId: key.nodeId,
      host: "127.0.0.1",
      port: 1,
      caPath: path.join(rootDir, "unused-ca.pem"),
      credential: "unused-offline-test",
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
    }),
  );
  return cut;
}
