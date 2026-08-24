// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileRepositoryScaffold,
  createCanonicalPresetResolver,
} from "../src/index.ts";

import { write } from "./preset-resolver.fixtures.ts";
test("project task scaffold replaces and adds prose while base ownership, anchors, and portable paths fail closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-scaffold-")),
    scaffold = path.join(root, "governance/task-scaffold.json"),
    template =
      "# Project Plan\n\n## Brief\n\nB\n\n## Goal\n\nG\n\n## Context\n\nC\n\n## Required Reading\n\nR\n\n## Entry Conditions\n\nE\n\n## Dependencies\n\nD\n\n## Execution Surface\n\nE\n\n## Constraints\n\nC\n\n## Checkpoint\n\nC\n\n## CI/Gate Authority Stop Condition\n\nS\n\n## Implementation Plan\n\nP\n\n## Deliverable Contract\n\nD\n\n## Evidence Protocol\n\nE\n\n## Verification\n\nV\n";
  try {
    write(path.join(root, "templates/plan.md"), template);
    write(
      path.join(root, "templates/notes.md"),
      "# Notes\n\n## Project Notes\n\nCustom.\n",
    );
    const valid = {
      schema: "task-scaffold/v1",
      replaceTemplate: [{ slot: "task.plan", template: "templates/plan.md" }],
      addDocument: [
        {
          slot: "project.notes",
          path: "notes.md",
          template: "templates/notes.md",
          requiredAnchors: ["## Project Notes"],
        },
      ],
    };
    write(scaffold, JSON.stringify(valid));
    const resolve = () =>
      createCanonicalPresetResolver({
        userRoot: path.join(root, "user"),
        projectRoot: root,
        projectScaffold: scaffold,
      }).resolve({
        presetId: "code-impact-analysis",
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        purpose: "task-create",
      });
    const applied = await resolve();
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.snapshot.templates.length, 5);
      assert.equal(applied.snapshot.templates[0]?.owner, "doc-sync");
      assert.equal(
        applied.snapshot.templates[0]?.templateRef,
        "project://templates/plan.md",
      );
      assert.deepEqual(
        applied.snapshot.templates.slice(-2).map(({ slot }) => slot),
        ["project.notes", "task.code.impact.analysis"],
      );
      assert.match(
        String(applied.snapshot.scaffold.overlayDigest),
        /^sha256:/u,
      );
    }
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        replaceTemplate: [{ ...valid.replaceTemplate[0], owner: "machine" }],
      }),
    );
    let rejected = await resolve();
    assert.equal(rejected.ok, false);
    if (!rejected.ok)
      assert.equal(rejected.error.code, "invalid_task_scaffold");
    write(path.join(root, "templates/plan.md"), "# Missing anchors\n");
    write(scaffold, JSON.stringify(valid));
    rejected = await resolve();
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "required_anchor");
    write(path.join(root, "templates/plan.md"), template);
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        addDocument: [{ ...valid.addDocument[0], path: "TASK_PLAN.md" }],
      }),
    );
    rejected = await resolve();
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "reserved_path");
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        addDocument: [{ ...valid.addDocument[0], path: "notes.json" }],
      }),
    );
    rejected = await resolve();
    assert.equal(rejected.ok, false);
    if (!rejected.ok)
      assert.equal(rejected.error.code, "invalid_task_scaffold");
    write(
      scaffold,
      JSON.stringify({ ...valid, deleteDocument: ["task.plan"] }),
    );
    rejected = await resolve();
    assert.equal(rejected.ok, false);
    if (!rejected.ok)
      assert.equal(rejected.error.code, "invalid_task_scaffold");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task and repository overlays share replace/add validation while keeping separate schemas and slots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-repository-scaffold-")),
    authoredRoot = path.join(root, "harness"),
    scaffold = path.join(authoredRoot, "governance/repository-scaffold.json");
  try {
    write(
      path.join(authoredRoot, "templates/architecture.md"),
      "# Architecture\n\n## Purpose\n\nProject architecture entry.\n\n## Opt-in Boundary\n\nNo model is enabled by init.\n",
    );
    write(
      path.join(authoredRoot, "templates/project.md"),
      "# Project Context\n\n## Project Notes\n\nCustom.\n",
    );
    const valid = {
      schema: "repository-scaffold/v1",
      replaceTemplate: [
        {
          slot: "repository.context.architecture",
          template: "templates/architecture.md",
        },
      ],
      addDocument: [
        {
          slot: "repository.context.project",
          path: "harness/context/project.md",
          template: "templates/project.md",
          requiredAnchors: ["## Project Notes"],
        },
      ],
    };
    write(scaffold, JSON.stringify(valid));
    const compile = () =>
      compileRepositoryScaffold({
        rootDir: root,
        verticalId: "software/coding",
        locale: "en-US",
        projectScaffold: scaffold,
      });
    const applied = compile();
    assert.equal(applied.documents.length, 16);
    assert.deepEqual(
      applied.documents.map(({ disposition }) => disposition),
      Array(16).fill("created"),
    );
    assert.equal(
      applied.documents.find(
        ({ slot }) => slot === "repository.context.architecture",
      )?.templateRef,
      "project://templates/architecture.md",
    );
    assert.deepEqual(
      applied.documents
        .filter(({ slot }) => slot.startsWith("repository.standard."))
        .map(({ path: target }) => target),
      [
        "harness/governance/standards/README.md",
        "harness/governance/standards/repository-governance.md",
        "harness/governance/standards/decision-writing.md",
      ],
    );
    assert.match(String(applied.projectOverlayDigest), /^sha256:/u);
    assert.match(applied.baseScaffoldDigest, /^sha256:/u);
    write(scaffold, JSON.stringify({ ...valid, schema: "task-scaffold/v1" }));
    assert.throws(
      compile,
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_repository_scaffold",
    );
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        replaceTemplate: [{ ...valid.replaceTemplate[0], owner: "machine" }],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_repository_scaffold",
    );
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        replaceTemplate: [
          {
            slot: "repository.walls.manifest",
            template: "templates/architecture.md",
          },
        ],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_repository_scaffold",
    );
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        addDocument: [
          {
            ...valid.addDocument[0],
            path: "harness/context/architecture/README.md",
          },
        ],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) => (error as { code?: string }).code === "reserved_path",
    );
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        addDocument: [
          { ...valid.addDocument[0], path: "harness/standards/README.md" },
        ],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) => (error as { code?: string }).code === "reserved_path",
    );
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        addDocument: [
          {
            ...valid.addDocument[0],
            path: "harness/governance/standards/project.md",
          },
        ],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) => (error as { code?: string }).code === "reserved_path",
    );
    write(
      path.join(root, "outside/architecture.md"),
      "# Architecture\n\n## Purpose\n\nOutside.\n\n## Opt-in Boundary\n\nNo model.\n",
    );
    symlinkSync(path.join(root, "outside"), path.join(authoredRoot, "linked"));
    write(
      scaffold,
      JSON.stringify({
        ...valid,
        replaceTemplate: [
          {
            slot: "repository.context.architecture",
            template: "linked/architecture.md",
          },
        ],
      }),
    );
    assert.throws(
      compile,
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_repository_scaffold",
    );
    write(
      path.join(authoredRoot, "templates/architecture.md"),
      "# Missing anchors\n",
    );
    write(scaffold, JSON.stringify(valid));
    assert.throws(
      compile,
      (error: unknown) =>
        (error as { code?: string }).code === "required_anchor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository init plan consumes the declaration and composes package-local AGENTS layers", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repository-plan-"));
  try {
    const vertical = JSON.parse(
        readFileSync(
          new URL("../assets/software-coding/vertical.json", import.meta.url),
          "utf8",
        ),
      ) as {
        repositoryScaffold: {
          seededDocs: Array<{ slot: string }>;
          agentsEntry: { repoSpecificsAnchor: string };
        };
      },
      expectedSlots = [
        ...vertical.repositoryScaffold.seededDocs.map(({ slot }) => slot),
        "repository.agent.entry",
      ].sort();
    for (const locale of ["en-US", "zh-CN"]) {
      const plan = compileRepositoryScaffold({
          rootDir,
          verticalId: "software/coding",
          locale,
        }),
        agents = plan.documents.find(
          ({ slot }) => slot === "repository.agent.entry",
        );
      assert.deepEqual(
        plan.documents.map(({ slot }) => slot).sort(),
        expectedSlots,
      );
      assert.equal(agents?.path, "AGENTS.md");
      assert.match(agents?.body ?? "", /## Context Loading/u);
      assert.match(agents?.body ?? "", /## Harness CLI \(software\/coding\)/u);
      assert.match(agents?.body ?? "", /## Repository Specifics/u);
      assert.equal(
        agents?.requiredAnchors.includes(
          vertical.repositoryScaffold.agentsEntry.repoSpecificsAnchor,
        ),
        true,
      );
      assert.equal(
        plan.documents.some(
          ({ path: target }) =>
            target.includes("harness/standards/") ||
            target.includes("architecture-manifest.json"),
        ),
        false,
      );
    }
    assert.throws(
      () =>
        compileRepositoryScaffold({
          rootDir,
          verticalId: "software-coding",
          locale: "en-US",
        }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code ===
          "missing_vertical" &&
        /Available vertical ids: software\/coding\./u.test(
          (error as { message?: string }).message ?? "",
        ),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
