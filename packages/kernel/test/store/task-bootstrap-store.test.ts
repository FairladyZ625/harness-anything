// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
  taskBootstrapWritePlan,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1
} from "../../src/index.ts";

test("task bootstrap publishes and rebuilds one exact Task, snapshot, and document cut", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-bootstrap-"));
  try {
    git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Bootstrap Test"); git(rootDir, "config", "user.email", "bootstrap@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const snapshotBody = `${JSON.stringify({ schema: "preset-snapshot/v1", id: "standard-task" })}\n`, documentBody = "# Plan\n", snapshotSha = sha256Text(snapshotBody), documentSha = sha256Text(documentBody), digest = `sha256:${"a".repeat(64)}` as const;
    const event: TaskBootstrapEventV1 = { schema: "task-bootstrap-event/v1", eventId: "event-bootstrap", workspaceRevision: 1, opId: "op-bootstrap", taskId: "task-bootstrap", type: "task_bootstrapped", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", payload: {
      task: { schema: "task/v1", taskId: "task-bootstrap", title: "Bootstrap", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: { principal: { personId: "person-1" }, executor: null }, completionGateIds: ["ci"], presetSnapshotDigest: digest },
      presetSnapshotClaim: { digest, sha256: snapshotSha, size: Buffer.byteLength(snapshotBody), mediaType: "application/json" }, initialDocumentClaims: [{ path: "tasks/task-bootstrap/task_plan.md", sha256: documentSha, size: Buffer.byteLength(documentBody), mediaType: "text/markdown", policyId: "markdown-additive/v1" }] } };
    const blobs: readonly TaskBootstrapBlob[] = [{ ...event.payload.presetSnapshotClaim, body: snapshotBody }, { ...event.payload.initialDocumentClaims[0]!, body: documentBody }], store = makeTaskEventStore({ repoId: "bootstrap", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }), before = store.currentCommit();
    assert.throws(() => store.append(event, taskBootstrapWritePlan(event), blobs.slice(1)), /content inputs/u); assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append(event, taskBootstrapWritePlan(event), blobs); assert.equal(receipt.revision, 1); assert.equal(projection.apply(event, taskBootstrapWritePlan(event)).metrics.reducedItems, 1);
    assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task); assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody)); assert.equal(projection.readDocument("tasks/task-bootstrap/task_plan.md").document?.body, documentBody);
    projection.rebuild(); assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task); assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody)); assert.equal(projection.readDocument("tasks/task-bootstrap/task_plan.md").document?.body, documentBody);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
