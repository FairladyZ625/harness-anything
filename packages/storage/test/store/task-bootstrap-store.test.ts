// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../src/index.ts";
import {
  REPLAY_TASK_GRAPH,
  taskBootstrapWritePlan,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
} from "@harness-anything/kernel";
import { sha256Text, stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";

test("task bootstrap publishes and rebuilds one exact Task, snapshot, and document cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-bootstrap-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Bootstrap Test");
    git(rootDir, "config", "user.email", "bootstrap@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const snapshotValue = { schema: "preset-snapshot/v1", id: "standard-task" },
      digest = `sha256:${sha256Text(stableStringify(snapshotValue))}` as const,
      snapshotBody = `${stableStringify({ ...snapshotValue, digest })}\n`,
      documentBody = "# Plan\n",
      snapshotSha = sha256Text(snapshotBody),
      documentSha = sha256Text(documentBody);
    const event: TaskBootstrapEventV1 = {
      schema: "task-bootstrap-event/v1",
      eventId: "event-bootstrap",
      workspaceRevision: 1,
      opId: "op-bootstrap",
      taskId: "task-bootstrap",
      type: "task_bootstrapped",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
          taskId: "task-bootstrap",
          title: "Bootstrap",
          taskClass: "standard",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: { principal: { personId: "person-1" }, executor: null },
          completionGateIds: ["ci"],
          presetSnapshotDigest: digest,
          pinned: false,
        },
        presetSnapshotClaim: {
          digest,
          sha256: snapshotSha,
          size: Buffer.byteLength(snapshotBody),
          mediaType: "application/json",
        },
        initialDocumentClaims: [
          {
            path: "tasks/task-bootstrap-bootstrap/task_plan.md",
            sha256: documentSha,
            size: Buffer.byteLength(documentBody),
            mediaType: "text/markdown",
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      },
    };
    const blobs: readonly TaskBootstrapBlob[] = [
        { ...event.payload.presetSnapshotClaim, body: snapshotBody },
        { ...event.payload.initialDocumentClaims[0]!, body: documentBody },
      ],
      store = makeTaskEventStore({ repoId: "bootstrap", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const before = store.currentCommit();
    // A claim with neither a blob nor a stored object is still refused; since content is verified once at the
    // store boundary, the rejection now comes from the object store rather than the bundle's blob/claim shape.
    assert.throws(
      () =>
        store.append({
          event,
          plan: taskBootstrapWritePlan(event),
          blobs: blobs.slice(1),
        }),
      /event content object .* is missing/u,
    );
    assert.deepEqual(store.currentCommit(), before);
    assert.equal(store.read().revision, 0);
    const plan = taskBootstrapWritePlan(event);
    assert.equal(
      plan.targets.some(
        (target) => target.kind === "authored_file" && target.path === "tasks/task-bootstrap-bootstrap/task_plan.md",
      ),
      true,
    );
    const receipt = store.append({ event, plan, blobs });
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.commitSha, null);
    await store.settlePendingMaterialization();
    assert.equal(
      readFileSync(path.join(rootDir, "harness/tasks/task-bootstrap-bootstrap/task_plan.md"), "utf8"),
      documentBody,
    );
    const follower = store.followerStatus();
    assert.equal(follower.git.status, "verified");
    assert.equal(follower.worktree.status, "verified");
    assert.equal(git(rootDir, "rev-parse", "HEAD"), follower.git.commitSha);
    const manifest = JSON.parse(git(rootDir, "show", "HEAD:harness/events/segments/manifest.json"));
    assert.deepEqual(manifest.cut, store.currentCut());
    assert.equal(git(rootDir, "show", "HEAD:harness/tasks/task-bootstrap-bootstrap/task_plan.md"), documentBody.trim());
    assert.equal(projection.apply(event, plan).metrics.reducedItems, 1);
    assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task);
    assert.equal(projection.read("task-bootstrap").packagePath, "tasks/task-bootstrap-bootstrap");
    assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody));
    assert.equal(projection.readDocument("tasks/task-bootstrap-bootstrap/task_plan.md").document?.body, documentBody);
    projection.rebuild();
    assert.deepEqual(projection.read("task-bootstrap").snapshot.task, event.payload.task);
    assert.equal(projection.list().rows[0]?.packagePath, "tasks/task-bootstrap-bootstrap");
    assert.equal(projection.list().rows[0]?.createdAt, event.occurredAt);
    assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, JSON.parse(snapshotBody));
    assert.equal(projection.readDocument("tasks/task-bootstrap-bootstrap/task_plan.md").document?.body, documentBody);
    await store.drain();
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a preset snapshot row an older build stored compares in today's normalized form (2026-10-20)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-bootstrap-normalized-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Bootstrap Test");
    git(rootDir, "config", "user.email", "bootstrap@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    // Edges stalled replaying past e08dd0ccc: the stored row kept the retired hosted CI source.
    const snapshotValue = {
        schema: "preset-snapshot/v1",
        id: "standard-task",
        completion: {
          sources: { ci: { kind: "github-actions" }, lifecycle: { kind: "lifecycle" } },
          gates: { ci: { source: "ci" }, lifecycle: { source: "lifecycle" } },
        },
      },
      digest = `sha256:${sha256Text(stableStringify(snapshotValue))}` as const,
      snapshotBody = `${stableStringify({ ...snapshotValue, digest })}\n`,
      store = makeTaskEventStore({ repoId: "bootstrap", rootDir }),
      append = (n: number) => {
        const event = bootstrapEvent(n, digest, snapshotBody),
          plan = taskBootstrapWritePlan(event);
        store.append({
          event,
          plan,
          blobs: [
            { ...event.payload.presetSnapshotClaim, body: snapshotBody },
            { ...event.payload.initialDocumentClaims[0]!, body: "# Plan\n" },
          ],
        });
        return { event, plan };
      },
      storedRow = () => {
        const db = new DatabaseSync(path.join(rootDir, ".harness/cache/task.sqlite"));
        try {
          const row = db.prepare("SELECT value_json FROM preset_snapshot WHERE digest = ?").get(digest) as {
            value_json: string;
          };
          return JSON.parse(row.value_json) as unknown;
        } finally {
          db.close();
        }
      },
      storeRow = (valueJson: string) => {
        const db = new DatabaseSync(path.join(rootDir, ".harness/cache/task.sqlite"));
        try {
          db.prepare("UPDATE preset_snapshot SET value_json = ? WHERE digest = ?").run(valueJson, digest);
        } finally {
          db.close();
        }
      };
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const first = append(1);
    projection.apply(first.event, first.plan);
    const normalized = projection.readPresetSnapshot(digest).snapshot as { completion: { sources: object } };
    assert.deepEqual(Object.keys(normalized.completion.sources), ["lifecycle"]);

    storeRow(stableStringify(JSON.parse(snapshotBody)));
    const second = append(2);
    assert.equal(projection.apply(second.event, second.plan).metrics.reducedItems, 1);
    assert.deepEqual(projection.readPresetSnapshot(digest).snapshot, normalized);
    // Reads normalize on their own; the row itself must be rewritten so state digests agree across nodes.
    assert.deepEqual(storedRow(), normalized);

    storeRow(stableStringify({ ...JSON.parse(snapshotBody), id: "other-preset" }));
    const third = append(3);
    assert.throws(() => projection!.apply(third.event, third.plan), /names different bytes/u);
    await store.drain();
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function bootstrapEvent(n: number, digest: `sha256:${string}`, snapshotBody: string): TaskBootstrapEventV1 {
  const taskId = `task-bootstrap-${n}`,
    documentBody = "# Plan\n";
  return {
    schema: "task-bootstrap-event/v1",
    eventId: `event-bootstrap-${n}`,
    workspaceRevision: n,
    opId: `op-bootstrap-${n}`,
    taskId,
    type: "task_bootstrapped",
    actor: { principal: { personId: "person-1" }, executor: null },
    source: "local",
    occurredAt: "2026-10-20T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId,
        title: "Bootstrap",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-1" }, executor: null },
        completionGateIds: ["lifecycle"],
        presetSnapshotDigest: digest,
        pinned: false,
      },
      presetSnapshotClaim: {
        digest,
        sha256: sha256Text(snapshotBody),
        size: Buffer.byteLength(snapshotBody),
        mediaType: "application/json",
      },
      initialDocumentClaims: [
        {
          path: `tasks/${taskId}-bootstrap/task_plan.md`,
          sha256: sha256Text(documentBody),
          size: Buffer.byteLength(documentBody),
          mediaType: "text/markdown",
          owner: "doc-sync",
          policyId: "markdown-body-replaceable/v1",
        },
      ],
    },
  };
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
