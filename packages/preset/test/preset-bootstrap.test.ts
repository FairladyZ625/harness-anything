// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessTransitionDocument,
  compileTaskLifecycleWrite,
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
  type TaskEventV1,
} from "@harness-anything/kernel";
import { compilePresetSnapshotUpgrade, compileTaskBootstrap, compileTaskPackage } from "../src/index.ts";

const PR_TEMPLATE_FIXTURE = `# English

## Summary

-

## What Changed

-

---

# 中文

## 概要

-

## 改动内容

-

---

## PR Gate Checklist / PR 门禁清单

- [ ] PR body uses two complete language blocks.
`;

test("standard and work bootstrap compile one exact canonical birth and rebuild from L1", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-bootstrap-")),
    userRoot = path.join(rootDir, ".harness/presets");
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    mkdirSync(path.join(rootDir, ".github"), { recursive: true });
    writeFileSync(path.join(rootDir, ".github", "pull_request_template.md"), PR_TEMPLATE_FIXTURE);
    const common = {
      userRoot,
      repoRoot: rootDir,
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
    assert.equal(standard.event.payload.initialDocumentClaims.length, 7);
    assert.equal(standard.packagePath, "tasks/task-standard-standard");
    const explainer = standard.documents.find(({ relativePath }) => relativePath === "artifacts/explainer.html")!.body;
    for (const id of ["conclusion", "objectives", "structure", "evidence", "next-steps"])
      assert.ok(explainer.includes(`id="${id}"`));
    assert.equal((explainer.match(/<svg /gu) ?? []).length, 5);
    assert.match(explainer, /AUTHORING GUIDE[\s\S]*four scenarios change only this chapter's diagram/u);
    assert.match(explainer, /max-width:none/u);
    assert.doesNotMatch(explainer, /max-width:72rem/u);
    for (const className of [
      "hero-subtitle",
      "measure-note",
      "metric-grid",
      "chapter-head",
      "group",
      "node-existing",
      "node-new",
      "node-removed",
      "node-external",
      "connector",
      "legend",
      "source-note",
    ])
      assert.match(explainer, new RegExp(`class=\\"[^\\"]*${className}`), `expected visual kit class: ${className}`);
    for (const rule of ["#conclusion:", "#objectives:", "#structure:", "#evidence:", "#next-steps:"])
      assert.ok(explainer.includes(rule), `expected chapter-specific template instructions: ${rule}`);
    assert.ok(
      standard.documents[0]!.body.endsWith("## Next\n\nEdit `task_plan.md`, then run `ha task start task-standard`.\n"),
    );
    assert.deepEqual(
      standard.documents.map(({ relativePath }) => relativePath),
      [
        "INDEX.md",
        "task-contract.json",
        "task_plan.md",
        "closeout.md",
        "artifacts/.gitkeep",
        "artifacts/explainer.html",
        "artifacts/pr-body.md",
      ],
    );
    // The PR-body skeleton is the repository template verbatim: workers fill it in, never guess the format.
    assert.equal(
      standard.documents.find(({ relativePath }) => relativePath === "artifacts/pr-body.md")!.body,
      PR_TEMPLATE_FIXTURE,
    );
    const prBodyClaim = standard.event.payload.initialDocumentClaims.find(({ path }) =>
      path.endsWith("/artifacts/pr-body.md"),
    )!;
    assert.equal(prBodyClaim.owner, "doc-sync");
    assert.equal(prBodyClaim.policyId, "opaque-textual-whole-file/v1");
    assert.equal(prBodyClaim.mediaType, "text/markdown");
    assert.match(standard.documents[2]!.body, /^# Standard$/mu);
    assert.deepEqual(
      standard.event.payload.initialDocumentClaims.map(({ owner }) => owner),
      ["machine", "machine", "doc-sync", "doc-sync", "doc-sync", "doc-sync", "doc-sync"],
    );
    assert.equal(JSON.parse(standard.documents[1]!.body).documents[2].owner, "doc-sync");
    const documentation = compileTaskBootstrap({
      ...common,
      taskId: "task-documentation",
      title: "Documentation",
      presetId: "standard-task",
      workKind: "docs",
      workspaceRevision: 2,
      eventId: "event-documentation",
      opId: "op-documentation",
    });
    const documentationContract = JSON.parse(documentation.documents[1]!.body) as {
      completionGates: readonly string[];
      presetSnapshotDigest: string;
    };
    assert.deepEqual(documentation.snapshot.profile.completionGateIds, []);
    assert.deepEqual(documentation.event.payload.task.completionGateIds, []);
    assert.deepEqual(documentationContract.completionGates, []);
    assert.equal(documentationContract.presetSnapshotDigest, documentation.snapshot.digest);
    assert.notEqual(documentation.snapshot.digest, standard.snapshot.digest);
    // Upgrade recompiles the current preset for the task; a docs task on the current preset must stay current
    // instead of being recompiled as ordinary work and regaining the CI and code-doc gates.
    assert.throws(
      () =>
        compilePresetSnapshotUpgrade({
          userRoot,
          task: documentation.event.payload.task,
          taskContractBody: documentation.documents[1]!.body,
          documentExists: () => true,
          actor: common.actor,
          source: common.source,
          workspaceRevision: 3,
          eventId: "event-documentation-upgrade",
          opId: "op-documentation-upgrade",
          occurredAt: common.occurredAt,
        }),
      (error: unknown) => (error as { code?: string }).code === "snapshot_current",
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
    assert.equal(
      packageOnly.documents.some(({ relativePath }) => relativePath === "artifacts/pr-body.md"),
      false,
      "a compile without a repository root has no template to materialize",
    );
    const docsTask = compileTaskBootstrap({
      ...common,
      taskId: "task-docs-artifact",
      title: "Docs Artifact",
      presetId: "docs-task",
      workspaceRevision: 2,
      eventId: "event-docs-artifact",
      opId: "op-docs-artifact",
    });
    assert.equal(
      docsTask.documents.some(({ relativePath }) => relativePath === "artifacts/pr-body.md"),
      false,
      "a task-package preset has no worktree binding and never opens a PR, even with the template present",
    );
    assert.equal("event" in packageOnly, false);
    assert.equal("plan" in packageOnly, false);
    assert.equal("blobs" in packageOnly, false);
    assert.throws(
      () =>
        compileTaskBootstrap({
          ...common,
          taskId: "task-missing-class",
          title: "Work",
          presetId: "create-work",
          workspaceRevision: 1,
          eventId: "event-missing",
          opId: "op-missing",
        }),
      (error: unknown) => (error as { code?: string }).code === "task_class_required",
    );
    const work = compileTaskBootstrap({
      ...common,
      taskId: "task-work",
      title: "Work",
      presetId: "create-work",
      taskClass: "work",
      workspaceRevision: 1,
      eventId: "event-work",
      opId: "op-work",
    });
    assert.equal(work.event.payload.task.taskClass, "work");
    assert.equal(work.snapshot.templates[0]!.templateRef, "template://planning/work-task-plan@1");
    assert.equal(work.event.payload.initialDocumentClaims.length, 6);
    assert.equal(
      work.documents.some(({ relativePath }) => relativePath === "artifacts/pr-body.md"),
      false,
      "work roots are planning containers and never open a PR of their own",
    );
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
      /event content object .* is missing/u,
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
    assert.deepEqual(projection.read("task-standard").snapshot.task, standard.event.payload.task);
    assert.equal(projection.read("task-standard").packagePath, standard.packagePath);
    assert.deepEqual(projection.readPresetSnapshot(standard.snapshot.digest).snapshot, standard.snapshot);
    for (const document of standard.documents)
      assert.equal(projection.readDocument(document.path).document?.body, document.body);
    await store.settlePendingMaterialization();
    rmSync(path.join(rootDir, "harness", standard.packagePath), {
      recursive: true,
      force: true,
    });
    const restored = store.materialize();
    assert.deepEqual(
      restored.settlements.map(({ path: settledPath, action }) => [settledPath, action]),
      standard.documents.map(({ path: settledPath }) => [settledPath, "restore"]),
    );
    assert.equal(store.read().revision, 1);
    for (const document of standard.documents)
      assert.equal(readFileSync(path.join(rootDir, "harness", document.path), "utf8"), document.body);
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
    assert.deepEqual(projection.read("task-repeated").snapshot.task, repeated.event.payload.task);
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.deepEqual(projection.read("task-standard").snapshot.task, standard.event.payload.task);
    assert.deepEqual(projection.readPresetSnapshot(standard.snapshot.digest).snapshot, standard.snapshot);
    for (const document of standard.documents)
      assert.equal(projection.readDocument(document.path).document?.body, document.body);
    await store.drain();
    const reader = makeTaskEventStore({ repoId: "preset-bootstrap", rootDir, mutable: false });
    try {
      assert.deepEqual(
        reader.read().events.map((event) => event.opId),
        [standard.event.opId, repeated.event.opId],
      );
    } finally {
      await reader.drain();
    }
    projection.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the lightweight profile materializes the minimal plan and closeout and freezes its gates", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-lightweight-"));
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const common = {
      userRoot: path.join(rootDir, ".harness/presets"),
      verticalId: "software/coding",
      profileId: "lightweight",
      locale: "en-US",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-09-18T00:00:00.000Z",
    } as const;
    for (const presetId of ["standard-task", "worker-dispatch", "docs-task"] as const) {
      const compiled = compileTaskBootstrap({
        ...common,
        taskId: `task-${presetId}`,
        title: "Lightweight",
        presetId,
        workspaceRevision: 1,
        eventId: `event-${presetId}`,
        opId: `op-${presetId}`,
      });
      const plan = compiled.documents.find((document) => document.relativePath === "task_plan.md")!;
      assert.deepEqual(
        [...plan.body.matchAll(/^## .+$/gmu)].map((match) => match[0]),
        ["## Brief", "## Context", "## Verification"],
      );
      const closeout = compiled.documents.find((document) => document.relativePath === "closeout.md")!;
      assert.deepEqual(
        [...closeout.body.matchAll(/^## .+$/gmu)].map((match) => match[0]),
        ["## Summary", "## Verification"],
      );
      assert.equal(compiled.event.payload.task.archiveOnComplete, true);
      assert.deepEqual(compiled.event.payload.task.closeoutOverrides, {
        review: false,
        consent: false,
        fact: false,
      });
      const contract = JSON.parse(compiled.documents[1]!.body) as Record<string, unknown>;
      assert.equal(contract.archiveOnComplete, true);
      assert.deepEqual(contract.closeoutOverrides, { review: false, consent: false, fact: false });
      assert.deepEqual(compiled.snapshot.profile.completionGateIds, presetId === "docs-task" ? [] : ["ci"]);
      assert.deepEqual(compiled.lightweightPresetIds, ["docs-task", "standard-task", "worker-dispatch"]);
    }
    // A preset without the profile fails closed and names its own profiles and the presets that declare it.
    assert.throws(
      () =>
        compileTaskPackage({
          ...common,
          taskId: "task-decision-conformance",
          title: "Lightweight",
          presetId: "decision-conformance",
        }),
      {
        code: "missing_profile",
        message:
          "Profile lightweight is unavailable on preset decision-conformance; its profiles: baseline. " +
          "Presets that declare lightweight: docs-task, standard-task, worker-dispatch.",
      },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("reopen recovers bootstrap machine views while preserving bootstrap prose and user drafts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-bootstrap-recovery-"));
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Preset Test");
  git(rootDir, "config", "user.email", "preset@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
  const common = {
      userRoot: path.join(rootDir, ".harness/presets"),
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      presetId: "standard-task",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-09-08T00:00:00.000Z",
    } as const,
    store = makeTaskEventStore({ repoId: "bootstrap-recovery", rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    baseline = compileTaskBootstrap({
      ...common,
      taskId: "task-baseline",
      title: "Baseline",
      workspaceRevision: 1,
      eventId: "event-baseline",
      opId: "op-baseline",
    });
  store.append(baseline);
  await store.settlePendingMaterialization();
  const manifestPath = path.join(rootDir, "harness/events/segments/manifest.json"),
    physicalManifest = readFileSync(manifestPath, "utf8"),
    born = compileTaskBootstrap({
      ...common,
      taskId: "task-born",
      title: "Born",
      workspaceRevision: 2,
      eventId: "event-born",
      opId: "op-born",
    });
  store.append(born);
  projection.apply(born.event, born.plan);
  await store.settlePendingMaterialization();
  const task = { ...born.event.payload.task, title: "Updated" },
    event: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-updated",
      opId: "op-updated",
      workspaceRevision: 3,
      taskId: task.taskId,
      type: "task_amended",
      actor: common.actor,
      source: "local",
      occurredAt: common.occurredAt,
      payload: { task, mutation: { command: "amend", reason: "retitle", fields: ["title"] }, documentClaims: [] },
    },
    updated = compileTaskLifecycleWrite({
      event,
      snapshot: { ...projection.read(task.taskId).snapshot, task, revision: 3 },
      packagePath: born.packagePath,
      currentDocuments: born.documents.map((document) => ({
        path: document.path,
        body: document.body,
        blobSha256: born.event.payload.initialDocumentClaims.find((claim) => claim.path === document.path)!.sha256,
      })),
    });
  store.append(updated);
  await store.settlePendingMaterialization();
  const expected = new Map(
    born.documents
      .filter((document) => /(?:INDEX\.md|task-contract\.json)$/u.test(document.path))
      .map((document) => [document.path, readFileSync(path.join(rootDir, "harness", document.path), "utf8")]),
  );
  await store.drain();
  projection.close();
  writeFileSync(manifestPath, physicalManifest);
  for (const document of born.documents) writeFileSync(path.join(rootDir, "harness", document.path), document.body);
  const draftPath = path.join(rootDir, "harness", born.packagePath, "closeout.md");
  writeFileSync(draftPath, "A real unsubmitted draft\n");
  const reopened = makeTaskEventStore({ repoId: "bootstrap-recovery", rootDir });
  try {
    reopened.materialize();
    for (const [logical, body] of expected)
      assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), body);
    const plan = born.documents.find((document) => document.path.endsWith("/task_plan.md"))!;
    assert.equal(readFileSync(path.join(rootDir, "harness", plan.path), "utf8"), plan.body);
    assert.equal(readFileSync(draftPath, "utf8"), "A real unsubmitted draft\n");
    assert.equal(reopened.currentCut().revision, 3);
    assert.equal(reopened.followerStatus().worktree.status, "pending");
    assert.deepEqual(reopened.followerStatus().worktree.conflicts, [
      `harness/${born.packagePath}/closeout.md`,
      `harness/${plan.path}`,
    ]);
    // The draft is reported, not a reason to hold the worktree back: its manifest records the settled cut.
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).cut.revision, 3);
  } finally {
    await reopened.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an authored plan rides the bootstrap write while readiness keeps deriving from the scaffold", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-plan-")),
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
    const sections = [
      "Brief",
      "Goal",
      "Context",
      "Required Reading",
      "Entry Conditions",
      "Dependencies",
      "Execution Surface",
      "Constraints",
      "Checkpoint",
      "Implementation Plan",
      "Deliverable Contract",
      "Evidence Protocol",
      "Verification",
    ];
    const authoredPlan = `# Authored at create\n\n${sections
      .map((heading) => `## ${heading}\n\nAuthored content for ${heading}.`)
      .join("\n\n")}\n`;
    const compiled = compileTaskBootstrap({
      ...common,
      taskId: "task-authored-plan",
      title: "Authored",
      presetId: "standard-task",
      plan: authoredPlan,
      workspaceRevision: 1,
      eventId: "event-authored-plan",
      opId: "op-authored-plan",
    });
    assert.equal(compiled.documents.find((document) => document.relativePath === "task_plan.md")!.body, authoredPlan);
    const closeout = compiled.documents.find((document) => document.relativePath === "closeout.md")!;
    assert.match(closeout.body, /Replace this file's placeholder content before closeout/u);
    const contract = JSON.parse(
        compiled.documents.find((document) => document.relativePath === "task-contract.json")!.body,
      ),
      planDescriptor = contract.documents.find(
        (descriptor: { readonly slot: string }) => descriptor.slot === "task.plan",
      );
    assert.ok(planDescriptor.readiness, "task.plan descriptor keeps a readiness contract");
    assert.ok(
      planDescriptor.readiness.Brief?.includes("One-line statement of the task objective and scope."),
      "readiness phrases stay the scaffold's, not the authored body's",
    );
    const readiness = assessTransitionDocument("task.plan", authoredPlan, {
      requiredSections: Object.keys(planDescriptor.readiness),
      scaffoldBySection: planDescriptor.readiness,
    });
    assert.equal(readiness.ready, true, JSON.stringify(readiness.missingSections));
    const incomplete = assessTransitionDocument(
      "task.plan",
      authoredPlan.replace("## Verification\n\nAuthored content for Verification.", ""),
      {
        requiredSections: Object.keys(planDescriptor.readiness),
        scaffoldBySection: planDescriptor.readiness,
      },
    );
    assert.equal(incomplete.ready, false);
    assert.deepEqual(
      incomplete.missingSections.map(({ section }) => section),
      ["Verification"],
    );
    assert.throws(
      () =>
        compileTaskPackage({
          ...common,
          taskId: "task-rejected-plan",
          title: "Rejected plan",
          presetId: "standard-task",
          plan: authoredPlan.replace("## Verification\n\nAuthored content for Verification.", ""),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === "plan_placeholder");
        assert.match(error.message, /Verification/u);
        assert.equal(Object.hasOwn(error, "documentPath"), false, "a rejected create has no task document to edit");
        return true;
      },
    );
    const bootstrapClaim = compiled.event.payload.initialDocumentClaims.find(({ path }) =>
      path.endsWith("/task_plan.md"),
    )!;
    assert.equal(bootstrapClaim.sha256, sha256Text(authoredPlan));
    const blank = compileTaskBootstrap({
      ...common,
      taskId: "task-blank-plan",
      title: "Blank",
      presetId: "standard-task",
      plan: "   \n",
      workspaceRevision: 2,
      eventId: "event-blank-plan",
      opId: "op-blank-plan",
    });
    assert.match(
      blank.documents.find((document) => document.relativePath === "task_plan.md")!.body,
      /^# Blank$/mu,
      "a whitespace-only plan falls back to the scaffold body",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
