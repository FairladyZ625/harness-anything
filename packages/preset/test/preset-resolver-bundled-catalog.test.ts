// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, sha256Text } from "../../kernel/src/index.ts";
import { compileTaskBootstrap } from "../src/index.ts";
import { createRuntime } from "../src/preset-resolver.ts";

import { git } from "./preset-resolver.fixtures.ts";
test("all twelve bundled packages resolve through one valid catalog", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-builtins-"));
  try {
    const runtime = createRuntime({ userRoot: root }),
      resolver = runtime.resolver,
      common = {
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        purpose: "task-create",
      } as const,
      listed = await resolver.list({ verticalId: "software/coding" });
    assert.deepEqual(
      listed.map(({ id, validity, errorCode }) => ({
        id,
        validity,
        errorCode,
      })),
      [
        {
          id: "architecture-rot-audit",
          validity: "valid",
          errorCode: undefined,
        },
        { id: "code-impact-analysis", validity: "valid", errorCode: undefined },
        { id: "create-milestone", validity: "valid", errorCode: undefined },
        { id: "decision-conformance", validity: "valid", errorCode: undefined },
        { id: "docs-task", validity: "valid", errorCode: undefined },
        { id: "github-issue-repair", validity: "valid", errorCode: undefined },
        { id: "legacy-migration", validity: "valid", errorCode: undefined },
        { id: "milestone-closeout", validity: "valid", errorCode: undefined },
        { id: "module", validity: "valid", errorCode: undefined },
        { id: "standard-task", validity: "valid", errorCode: undefined },
        { id: "subtask-expansion", validity: "valid", errorCode: undefined },
        { id: "worker-dispatch", validity: "valid", errorCode: undefined },
      ],
    );
    const standard = await resolver.resolve({
        ...common,
        presetId: "standard-task",
      }),
      milestone = await resolver.resolve({
        ...common,
        presetId: "create-milestone",
      });
    assert.equal(standard.ok, true);
    assert.equal(milestone.ok, true);
    if (!standard.ok || !milestone.ok) return;
    assert.deepEqual(
      standard.snapshot.templates.map(
        ({ slot, path: target, templateRef }) => ({
          slot,
          target,
          templateRef,
        }),
      ),
      [
        {
          slot: "task.plan",
          target: "task_plan.md",
          templateRef: "template://planning/task-plan@1",
        },
        {
          slot: "task.closeout",
          target: "closeout.md",
          templateRef: "template://planning/closeout@1",
        },
        {
          slot: "task.artifacts.keep",
          target: "artifacts/.gitkeep",
          templateRef: "template://planning/keep-file@1",
        },
      ],
    );
    assert.deepEqual(
      milestone.snapshot.templates.map(
        ({ slot, path: target, templateRef }) => ({
          slot,
          target,
          templateRef,
        }),
      ),
      [
        {
          slot: "task.plan",
          target: "task_plan.md",
          templateRef: "template://planning/milestone-task-plan@1",
        },
        {
          slot: "task.closeout",
          target: "closeout.md",
          templateRef: "template://planning/closeout@1",
        },
        {
          slot: "task.artifacts.keep",
          target: "artifacts/.gitkeep",
          templateRef: "template://planning/keep-file@1",
        },
      ],
    );
    const skeletonAnchors = [
      "## Required Reading",
      "## Entry Conditions",
      "## Dependencies",
      "## Execution Surface",
      "## Deliverable Contract",
      "## Evidence Protocol",
    ];
    for (const locale of ["en-US", "zh-CN"] as const)
      for (const presetId of ["standard-task", "create-milestone"]) {
        const resolved = runtime.resolveInternal({
            ...common,
            locale,
            presetId,
          }),
          template = resolved.snapshot.templates.find(
            ({ slot }) => slot === "task.plan",
          ),
          plan =
            resolved.documents.find(({ slot }) => slot === "task.plan")?.body ??
            "";
        for (const anchor of skeletonAnchors) {
          assert.equal(
            template?.requiredAnchors.includes(anchor),
            true,
            `${presetId}:${locale}:${anchor}:contract`,
          );
          assert.match(
            plan,
            new RegExp(anchor, "u"),
            `${presetId}:${locale}:${anchor}:body`,
          );
        }
      }
    const matrix = [
      [
        "standard-task",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "docs-task",
        "task-package-artifact",
        [],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "code-impact-analysis",
        "task-package-artifact",
        [],
        [
          "task.plan",
          "task.closeout",
          "task.artifacts.keep",
          "task.code.impact.analysis",
        ],
      ],
      [
        "worker-dispatch",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        [
          "task.plan",
          "task.closeout",
          "task.artifacts.keep",
          "task.worker.flow",
        ],
      ],
      [
        "architecture-rot-audit",
        "task-package-artifact",
        [],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "github-issue-repair",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "legacy-migration",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "create-milestone",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "milestone-closeout",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "decision-conformance",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
      [
        "module",
        "repository-diff",
        ["ci", "code-doc-reconciliation"],
        [
          "task.plan",
          "task.closeout",
          "task.artifacts.keep",
          "module.plan",
          "module.brief",
          "module.session.prompt",
        ],
      ],
      [
        "subtask-expansion",
        "task-package-artifact",
        [],
        ["task.plan", "task.closeout", "task.artifacts.keep"],
      ],
    ] as const;
    for (const [presetId, outputShape, completionGateIds, slots] of matrix) {
      const result = await resolver.resolve({ ...common, presetId });
      assert.equal(result.ok, true, presetId);
      if (result.ok)
        assert.deepEqual(
          {
            outputShape: result.snapshot.profile.outputShape,
            completionGateIds: result.snapshot.profile.completionGateIds,
            slots: result.snapshot.templates.map(({ slot }) => slot),
            entrypoints: Object.keys(result.snapshot.entrypoints),
          },
          { outputShape, completionGateIds, slots, entrypoints: [] },
        );
    }
    for (const presetId of ["module", "subtask-expansion"]) {
      const result = await resolver.resolve({ ...common, presetId });
      assert.equal(result.ok, true, presetId);
    }
    assert.equal(
      existsSync(
        new URL(
          "../assets/software-coding/presets/reference-task/",
          import.meta.url,
        ),
      ),
      false,
    );
    assert.equal(
      existsSync(
        new URL(
          "../assets/software-coding/presets/long-running-task/",
          import.meta.url,
        ),
      ),
      false,
    );
    const noEntrypoint = await resolver.resolve({
      presetId: "create-milestone",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "script-run",
      entrypoint: "run",
    });
    assert.equal(noEntrypoint.ok, false);
    if (!noEntrypoint.ok)
      assert.equal(noEntrypoint.error.code, "entrypoint_not_found");
    const auditEntrypoint = await resolver.resolve({
      presetId: "architecture-rot-audit",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "script-run",
      entrypoint: "run",
    });
    assert.equal(auditEntrypoint.ok, false);
    if (!auditEntrypoint.ok)
      assert.equal(auditEntrypoint.error.code, "entrypoint_not_found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const sample of [
  {
    presetId: "standard-task",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: null,
    taskClass: undefined,
  },
  { presetId: "docs-task", gates: [], addedPath: null },
  {
    presetId: "code-impact-analysis",
    gates: [],
    addedPath: "code-impact-analysis.md",
  },
  {
    presetId: "worker-dispatch",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: "worker-flow.md",
  },
  { presetId: "architecture-rot-audit", gates: [], addedPath: null },
  {
    presetId: "github-issue-repair",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: null,
  },
  {
    presetId: "create-milestone",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: null,
    taskClass: "milestone",
  },
  {
    presetId: "milestone-closeout",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: null,
  },
  {
    presetId: "decision-conformance",
    gates: ["ci", "code-doc-reconciliation"],
    addedPath: null,
  },
] as const)
  test(`${sample.presetId} dry-run claims equal canonical materialization`, () => {
    const rootDir = mkdtempSync(
        path.join(tmpdir(), `ha-preset-${sample.presetId}-`),
      ),
      userRoot = path.join(rootDir, ".harness/presets");
    try {
      git(rootDir, "init", "-q");
      git(rootDir, "config", "user.name", "Preset Test");
      git(rootDir, "config", "user.email", "preset@example.invalid");
      git(rootDir, "commit", "--allow-empty", "-qm", "base");
      const preview = compileTaskBootstrap({
        userRoot,
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local",
        occurredAt: "2026-08-14T00:00:00.000Z",
        taskId: `task-${sample.presetId}`,
        title: sample.presetId,
        presetId: sample.presetId,
        ...(sample.taskClass ? { taskClass: sample.taskClass } : {}),
        workspaceRevision: 1,
        eventId: `event-${sample.presetId}`,
        opId: `op-${sample.presetId}`,
      });
      const dryRunPaths = preview.documents.map(({ path: target }) => target),
        claimPaths = preview.event.payload.initialDocumentClaims.map(
          ({ path: target }) => target,
        );
      assert.deepEqual(claimPaths, dryRunPaths);
      assert.deepEqual(
        preview.snapshot.profile.completionGateIds,
        sample.gates,
      );
      assert.equal(
        sample.addedPath === null
          ? preview.documents.length === 6
          : preview.documents.some(
              ({ relativePath }) => relativePath === sample.addedPath,
            ),
        true,
      );
      const store = makeTaskEventStore({
        repoId: `preset-${sample.presetId}`,
        rootDir,
      });
      store.append({
        event: preview.event,
        plan: preview.plan,
        blobs: preview.blobs,
      });
      for (const document of preview.documents)
        assert.equal(
          readFileSync(path.join(rootDir, "harness", document.path), "utf8"),
          document.body,
        );
      rmSync(path.join(rootDir, "harness", preview.packagePath), {
        recursive: true,
        force: true,
      });
      const restored = store.materialize();
      assert.deepEqual(
        restored.changed,
        [...dryRunPaths].sort((left, right) => left.localeCompare(right)),
      );
      for (const document of preview.documents)
        assert.equal(
          readFileSync(path.join(rootDir, "harness", document.path), "utf8"),
          document.body,
        );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

test("module locale, required anchors, and body digests close through the canonical catalog", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-module-catalog-")),
    assetsRoot = path.join(root, "assets");
  try {
    cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, {
      recursive: true,
    });
    const runtime = createRuntime({
      bundledRoot: path.join(assetsRoot, "presets"),
      assetsRoot,
      userRoot: path.join(root, "user"),
    });
    for (const locale of ["en-US", "zh-CN"] as const) {
      const resolved = runtime.resolveInternal({
          presetId: "module",
          verticalId: "software/coding",
          profileId: "baseline",
          locale,
          purpose: "task-create",
        }),
        increments = resolved.snapshot.templates.filter(({ slot }) =>
          slot.startsWith("module."),
        );
      assert.equal(increments.length, 3);
      for (const template of increments) {
        const document = resolved.documents.find(
          ({ slot }) => slot === template.slot,
        );
        assert.equal(template.locale, locale);
        assert.ok(template.requiredAnchors.length >= 2);
        assert.equal(template.content.sha256, sha256Text(document?.body ?? ""));
        for (const anchor of template.requiredAnchors)
          assert.match(
            document?.body ?? "",
            new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
          );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
