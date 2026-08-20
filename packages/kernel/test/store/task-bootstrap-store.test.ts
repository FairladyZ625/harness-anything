// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
  stableStringify,
  taskBootstrapWritePlan,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1
} from "../../src/index.ts";

test("task bootstrap publishes and rebuilds one exact Task, snapshot, and document cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-bootstrap-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Bootstrap Test"); git(rootDir, "config", "user.email", "bootstrap@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const snapshotValue = { schema: "preset-snapshot/v1", id: "standard-task" }, digest = `sha256:${sha256Text(stableStringify(snapshotValue))}` as const, snapshotBody = `${stableStringify({ ...snapshotValue, digest })}\n`, documentBody = "# Plan\n", snapshotSha = sha256Text(snapshotBody), documentSha = sha256Text(documentBody);
    const event: TaskBootstrapEventV1 = { schema: "task-bootstrap-event/v1", eventId: "event-bootstrap", workspaceRevision: 1, opId: "op-bootstrap", taskId: "task-bootstrap", type: "task_bootstrapped", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", payload: {
      task: { schema: "task/v1", taskId: "task-bootstrap", title: "Bootstrap", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: { principal: { personId: "person-1" }, executor: null }, completionGateIds: ["ci"], presetSnapshotDigest: digest },
      presetSnapshotClaim: { digest, sha256: snapshotSha, size: Buffer.byteLength(snapshotBody), mediaType: "application/json" }, initialDocumentClaims: [{ path: "tasks/task-bootstrap-bootstrap/task_plan.md", sha256: documentSha, size: Buffer.byteLength(documentBody), mediaType: "text/markdown", owner: "doc-sync", policyId: "markdown-body-replaceable/v1" }] } };
    const blobs: readonly TaskBootstrapBlob[] = [{ ...event.payload.presetSnapshotClaim, body: snapshotBody }, { ...event.payload.initialDocumentClaims[0]!, body: documentBody }], store = makeTaskEventStore({ repoId: "bootstrap", rootDir }); projection = makeTaskProjection({ rootDir, eventStore: store }); const before = store.currentCommit();
    const tamperedBody = `${stableStringify({ ...snapshotValue, id: "tampered", digest })}\n`, tamperedSha = sha256Text(tamperedBody), tampered = { ...event, payload: { ...event.payload, presetSnapshotClaim: { ...event.payload.presetSnapshotClaim, sha256: tamperedSha, size: Buffer.byteLength(tamperedBody) } } }, tamperedBlobs = [{ ...tampered.payload.presetSnapshotClaim, body: tamperedBody }, blobs[1]!] as const;
    assert.throws(() => store.append({ event: tampered, plan: taskBootstrapWritePlan(tampered), blobs: tamperedBlobs }), /snapshot.*digest/iu); assert.deepEqual(store.currentCommit(), before);
    assert.throws(() => store.append({ event, plan: taskBootstrapWritePlan(event), blobs: blobs.slice(1) }), /content inputs/u); assert.deepEqual(store.currentCommit(), before);
    const plan = taskBootstrapWritePlan(event); assert.equal(plan.targets.some((target) => target.kind === "authored_file" && target.path === "tasks/task-bootstrap-bootstrap/task_plan.md"), true); const receipt = store.append({ event, plan, blobs }); assert.equal(receipt.revision, 1); assert.equal(receipt.commitSha, null); assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-bootstrap-bootstrap/task_plan.md"), "utf8"), documentBody); await store.drain(); const publication = store.publication(event); assert.notEqual(publication.commitSha, null); assert.equal(git(rootDir, "rev-parse", "HEAD"), publication.commitSha?.sha); assert.equal(git(rootDir, "rev-parse", "refs/ha/canonical"), publication.commitSha?.sha); assert.equal(projection.apply(event, plan).metrics.reducedItems, 1);
    assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task); assert.equal(projection.read("task-bootstrap").packagePath, "tasks/task-bootstrap-bootstrap"); assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody)); assert.equal(projection.readDocument("tasks/task-bootstrap-bootstrap/task_plan.md").document?.body, documentBody);
    projection.rebuild(); assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task); assert.equal(projection.list().rows[0]?.packagePath, "tasks/task-bootstrap-bootstrap"); assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody)); assert.equal(projection.readDocument("tasks/task-bootstrap-bootstrap/task_plan.md").document?.body, documentBody);
  } finally { projection?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
