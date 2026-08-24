// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
} from "../../kernel/src/index.ts";
import { compileTaskBootstrap, compileTaskPackage } from "../src/index.ts";

test("standard and milestone bootstrap compile one exact canonical birth and rebuild from L1", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-bootstrap-")),
    userRoot = path.join(rootDir, ".harness/presets");
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const common = {
      userRoot,
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z",
    } as const;
    const standard = compileTaskBootstrap({
      ...common,
      taskId: "task-standard",
      title: "Standard",
      presetId: "standard-task",
      workspaceRevision: 1,
      eventId: "event-standard",
      opId: "op-standard",
    });
    assert.equal(standard.event.payload.task.taskClass, "standard");
    assert.equal(standard.event.payload.initialDocumentClaims.length, 6);
    assert.equal(standard.packagePath, "tasks/task-standard-standard");
    assert.deepEqual(
      standard.documents.map(({ relativePath }) => relativePath),
      [
        "INDEX.md",
        "task-contract.json",
        "task_plan.md",
        "facts.md",
        "closeout.md",
        "artifacts/.gitkeep",
      ],
    );
    assert.match(standard.documents[2]!.body, /^# Standard$/mu);
    assert.deepEqual(
      standard.event.payload.initialDocumentClaims.map(({ owner }) => owner),
      ["machine", "machine", "doc-sync", "machine", "doc-sync", "doc-sync"],
    );
    assert.equal(
      JSON.parse(standard.documents[1]!.body).documents[2].owner,
      "doc-sync",
    );
    const packageOnly = compileTaskPackage({
      userRoot,
      taskId: "configure-verify-smoke",
      title: "Configure Verify",
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
    });
    assert.equal(packageOnly.documents.length, 6);
    assert.equal("event" in packageOnly, false);
    assert.equal("plan" in packageOnly, false);
    assert.equal("blobs" in packageOnly, false);
    assert.throws(
      () =>
        compileTaskBootstrap({
          ...common,
          taskId: "task-missing-class",
          title: "Milestone",
          presetId: "create-milestone",
          workspaceRevision: 1,
          eventId: "event-missing",
          opId: "op-missing",
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "task_class_required",
    );
    const milestone = compileTaskBootstrap({
      ...common,
      taskId: "task-milestone",
      title: "Milestone",
      presetId: "create-milestone",
      taskClass: "milestone",
      workspaceRevision: 1,
      eventId: "event-milestone",
      opId: "op-milestone",
    });
    assert.equal(milestone.event.payload.task.taskClass, "milestone");
    assert.equal(
      milestone.snapshot.templates[0]!.templateRef,
      "template://planning/milestone-task-plan@1",
    );
    assert.equal(milestone.event.payload.initialDocumentClaims.length, 6);
    const store = makeTaskEventStore({ repoId: "preset-bootstrap", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      before = store.currentCommit();
    assert.throws(
      () =>
        store.append({
          event: standard.event,
          plan: standard.plan,
          blobs: standard.blobs.slice(1),
        }),
      /content inputs/u,
    );
    assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append({
      event: standard.event,
      plan: standard.plan,
      blobs: standard.blobs,
    });
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.commitSha, null);
    assert.equal(store.read().events.length, 1);
    projection.apply(standard.event, standard.plan);
    assert.deepEqual(
      projection.read("task-standard").snapshot.task,
      standard.event.payload.task,
    );
    assert.equal(
      projection.read("task-standard").packagePath,
      standard.packagePath,
    );
    assert.deepEqual(
      projection.readPresetSnapshot(standard.snapshot.digest).snapshot,
      standard.snapshot,
    );
    for (const document of standard.documents)
      assert.equal(
        projection.readDocument(document.path).document?.body,
        document.body,
      );
    rmSync(path.join(rootDir, "harness", standard.packagePath), {
      recursive: true,
      force: true,
    });
    const restored = store.materialize();
    assert.deepEqual(
      restored.changed,
      [...standard.documents.map(({ path: target }) => target)].sort(
        (left, right) => left.localeCompare(right),
      ),
    );
    for (const document of standard.documents)
      assert.equal(
        readFileSync(path.join(rootDir, "harness", document.path), "utf8"),
        document.body,
      );
    const repeated = compileTaskBootstrap({
      ...common,
      taskId: "task-repeated",
      title: "Repeated",
      presetId: "standard-task",
      workspaceRevision: 2,
      eventId: "event-repeated",
      opId: "op-repeated",
    });
    assert.equal(repeated.snapshot.digest, standard.snapshot.digest);
    store.append({
      event: repeated.event,
      plan: repeated.plan,
      blobs: repeated.blobs,
    });
    projection.apply(repeated.event, repeated.plan);
    assert.deepEqual(
      projection.read("task-repeated").snapshot.task,
      repeated.event.payload.task,
    );
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.deepEqual(
      projection.read("task-standard").snapshot.task,
      standard.event.payload.task,
    );
    assert.deepEqual(
      projection.readPresetSnapshot(standard.snapshot.digest).snapshot,
      standard.snapshot,
    );
    for (const document of standard.documents)
      assert.equal(
        projection.readDocument(document.path).document?.body,
        document.body,
      );
    await store.drain();
    assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical"), "2");
    projection.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
