import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI check profiles expose stable JSON and fail closed on strict task contract issues", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeTaskPackage(rootDir, "task-1", {
      taskPlan: [
        "# Plan",
        "",
        "Task Contract: harness-task v1",
        "",
        "[说明这个占位应该失败]",
        ""
      ].join("\n"),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });

    const result = runJson(rootDir, ["check", "--profile", "private-harness", "--strict"], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "check");
    assert.equal(result.profile, "private-harness");
    assert.equal(result.error.code, "check_profile_failed");
    assert.equal(result.report.schema, "harness-check-profile-report/v1");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_placeholder" && warning.severity === "hard-fail"), true);
  });
});

test("CLI target-project check profile passes valid task material contracts", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeTaskPackage(rootDir, "task-1", {
      taskPlan: validTaskPlan(),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "check");
    assert.equal(result.report.summary.hardFailCount, 0);
    assert.equal(result.report.validators.some((validator: Record<string, unknown>) => validator.source === "task-plan-contract"), false);
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "lesson-promote"), true);
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "preset-validate" && entry.primary === "harness-anything preset validate <manifest> [--kernel-version <version>] [--json]"), true);
  });
});

test("CLI metadata check validates software coding preset task documents", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Coding Task", "--vertical", "software/coding", "--preset", "standard-task"]);

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.summary.hardFailCount, 0);
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "visual_map_missing"), false);
    assert.equal(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8").includes("Task Contract: harness-task v1"), true);
  });
});

test("CLI metadata check uses the selected persisted preset profile", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeRawPreset(rootDir, ".harness/presets/profiled-task/preset.json", makeMultiProfilePreset());
    const created = runJson(rootDir, ["new-task", "--title", "Profiled Task", "--vertical", "software/coding", "--preset", "profiled-task", "--profile", "extra"]);

    assert.equal(created.report.profile, "extra");
    assert.equal(created.generated.includes("extra.md"), true);
    const index = readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8");
    assert.match(index, /profile: extra/);

    const passed = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(passed.ok, true);

    rmSync(path.join(rootDir, created.packagePath, "extra.md"));
    const failed = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(failed.ok, false);
    assert.equal(failed.warnings.some((warning: Record<string, unknown>) => warning.code === "metadata_document_missing" && warning.message.includes("extra.md")), true);
  });
});

test("CLI task supersede preserves selected preset profile metadata", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeRawPreset(rootDir, ".harness/presets/profiled-task/preset.json", makeMultiProfilePreset());
    const created = runJson(rootDir, ["new-task", "--title", "Profiled Task", "--vertical", "software/coding", "--preset", "profiled-task", "--profile", "extra"]);
    const superseded = runJson(rootDir, ["task", "supersede", created.taskId, "--title", "Replacement Profiled Task", "--reason", "scope changed"]);

    assert.equal(superseded.ok, true);
    const index = readFileSync(path.join(rootDir, superseded.packagePath, "INDEX.md"), "utf8");
    assert.match(index, /vertical: software\/coding/);
    assert.match(index, /preset: profiled-task/);
    assert.match(index, /profile: extra/);
    for (const documentPath of ["task_plan.md", "progress.md", "facts.md", "review.md", "closeout.md", "artifacts/.gitkeep", "references/.gitkeep", "extra.md"]) {
      assert.equal(existsSync(path.join(rootDir, superseded.packagePath, documentPath)), true, documentPath);
    }

    const checked = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(checked.ok, true);
    assert.equal(checked.report.summary.hardFailCount, 0);
    assert.equal(checked.warnings.some((warning: Record<string, unknown>) => warning.code === "metadata_document_missing"), false);
    assert.equal(checked.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_missing"), false);
  });
});

test("CLI metadata check fails closed on missing preset-selected document and anchor", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Coding Task", "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, created.packagePath, "progress.md"));

    const missingDocument = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);

    assert.equal(missingDocument.ok, false);
    assert.equal(missingDocument.error.code, "check_profile_failed");
    assert.equal(missingDocument.warnings.some((warning: Record<string, unknown>) => warning.code === "metadata_document_missing" && warning.severity === "hard-fail"), true);

    const recreated = runJson(rootDir, ["new-task", "--title", "Anchor Task", "--vertical", "software/coding", "--preset", "standard-task"]);
    const taskPlanPath = path.join(rootDir, recreated.packagePath, "task_plan.md");
    writeFileSync(taskPlanPath, readFileSync(taskPlanPath, "utf8").replace("## Context", "## Notes"), "utf8");

    const missingAnchor = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);

    assert.equal(missingAnchor.ok, false);
    assert.equal(missingAnchor.warnings.some((warning: Record<string, unknown>) => warning.code === "metadata_required_anchor_missing" && warning.message.includes("task_plan.md")), true);
  });
});

test("CLI metadata check enforces milestone dossier artifact and resolvable provenance refs", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Milestone Dossier", "--vertical", "software/coding", "--preset", "milestone-dossier"]);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "artifacts", "dossier.scaffold.html")), true);

    const missing = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.warnings.some((warning: Record<string, unknown>) => warning.source === "dossier-gate-checker" && warning.code === "dossier_html_missing"), true);

    const artifactsDir = path.join(rootDir, created.packagePath, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "dossier.html"), "<!doctype html><p>Unresolved decision/dec_MISSING.</p>\n", "utf8");
    const unresolved = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.warnings.some((warning: Record<string, unknown>) => warning.code === "dossier_entity_ref_unresolved" && warning.message.includes("decision/dec_MISSING")), true);

    writeFileSync(path.join(rootDir, created.packagePath, "facts.md"), [
      "# Facts",
      "",
      "- {fact_id: F-DEADBEEF, statement: \"Milestone dossier has anchored evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
      ""
    ].join("\n"), "utf8");
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_DOSSIER",
      "--title",
      "Dossier Boundary",
      "--question",
      "Should the milestone close?",
      "--chosen",
      "Close with dossier evidence",
      "--rejected",
      "Close without dossier",
      "--why-not",
      "Boundary understanding must be reviewable"
    ]);

    writeFileSync(path.join(artifactsDir, "dossier.html"), [
      "<!doctype html>",
      "<html><body>",
      `<p>Resolved task/${created.taskId}.</p>`,
      "<p>Resolved decision/dec_DOSSIER and decision/dec_DOSSIER/CH1.</p>",
      `<p>Resolved fact/${created.taskId}/F-DEADBEEF.</p>`,
      "</body></html>",
      ""
    ].join("\n"), "utf8");

    const passed = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.warnings.some((warning: Record<string, unknown>) => warning.source === "dossier-gate-checker"), false);
  });
});

test("CLI metadata check does not resolve preset overrides for default tasks", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeTaskPackage(rootDir, "task-1", {
      taskPlan: validTaskPlan(),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });
    writePreset(rootDir, ".harness/presets/module/preset.json", {
      id: "module",
      title: "Bad Module",
      version: "9.0.0",
      templateSelections: [conflictingTaskPlanSelection()]
    });

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);

    assert.equal(result.ok, true);
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.source === "metadata-preset"), false);
  });
});

test("CLI metadata check blocks invalid active preset overrides without bundled fallback", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["new-task", "--title", "Coding Task", "--vertical", "software/coding", "--preset", "standard-task"]);
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
      id: "standard-task",
      title: "Bad Standard Task",
      version: "9.0.0",
      templateSelections: [conflictingTaskPlanSelection()]
    });

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "check_profile_failed");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "preset_required_template_conflict"), true);
  });
});

test("CLI metadata check reports invalid materialized paths instead of crashing", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["new-task", "--title", "Coding Task", "--vertical", "software/coding", "--preset", "standard-task"]);
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
      id: "standard-task",
      title: "Bad Path Standard Task",
      version: "9.0.0",
      templateSelections: [invalidPathSelection()]
    });

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "check_profile_failed");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "invalid_materialized_path"), true);
  });
});

test("CLI metadata check rejects unsupported non-default verticals", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeTaskPackage(rootDir, "task-1", {
      vertical: "custom/coding",
      preset: "standard-task",
      taskPlan: validTaskPlan(),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });

    const result = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "unsupported_vertical_metadata"), true);
  });
});

test("CLI governance rebuild supports dry-run, apply, and archive modes", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });
    writeTaskPackage(rootDir, "task-1", {
      taskPlan: validTaskPlan(),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });

    const dryRun = runJson(rootDir, ["governance", "rebuild", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.rows, 1);
    assert.equal(existsSync(path.join(rootDir, ".harness/cache/projections.sqlite")), false);

    const applied = runJson(rootDir, ["governance", "rebuild", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, "apply");
    assert.equal(existsSync(path.join(rootDir, ".harness/cache/projections.sqlite")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness/generated/Harness-Ledger.md")), true);

    const archived = runJson(rootDir, ["governance", "rebuild", "--archive"]);
    assert.equal(archived.ok, true);
    assert.equal(archived.mode, "archive");
    assert.equal(archived.generated.some((entry: string) => entry.startsWith(".harness/archive/governance/")), true);
  });
});

test("CLI lesson commands preserve task-local candidate routing", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeTaskPackage(rootDir, "task-1", {
      taskPlan: validTaskPlan(),
      review: validReview(),
      visual: validVisualMap(),
      execution: validExecutionStrategy(),
      lessons: validLessonCandidates()
    });

    const dryRun = runJson(rootDir, ["lesson-promote", "task-1", "LC-001", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.generated.length, 0);
    assert.equal(dryRun.report.plannedWrite, ".harness/generated/lessons/LC-001.json");

    const applied = runJson(rootDir, ["lesson-promote", "task-1", "LC-001", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(existsSync(path.join(rootDir, ".harness/generated/lessons/LC-001.json")), true);

    const sediment = runJson(rootDir, ["lesson-sediment", "task-1", "LC-001", "--title", "Keep Task Lessons Local"]);
    assert.equal(sediment.ok, true);
    assert.equal(sediment.mode, "dry-run");
    assert.equal(sediment.report.plannedWrite, "harness/lessons/LC-001.md");

    const missing = runJson(rootDir, ["lesson-promote", "task-1", "LC-404"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "lesson_candidate_not_found");
  });
});

function writeTaskPackage(
  rootDir: string,
  taskId: string,
  files: {
    readonly vertical?: string;
    readonly preset?: string;
    readonly taskPlan: string;
    readonly review: string;
    readonly visual: string;
    readonly execution: string;
    readonly lessons: string;
  }
): void {
  const taskDir = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Governance Task",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: planned",
    "  ref: ",
    "  titleSnapshot: Governance Task",
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    `vertical: ${files.vertical ?? "default"}`,
    `preset: ${files.preset ?? "module"}`,
    "---",
    "",
    "# Governance Task",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(taskDir, "task_plan.md"), files.taskPlan, "utf8");
  writeFileSync(path.join(taskDir, "review.md"), files.review, "utf8");
  writeFileSync(path.join(taskDir, "visual_map.md"), files.visual, "utf8");
  writeFileSync(path.join(taskDir, "execution_strategy.md"), files.execution, "utf8");
  writeFileSync(path.join(taskDir, "lesson_candidates.md"), files.lessons, "utf8");
}

function writePreset(rootDir: string, relativePath: string, overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(makePreset(overrides), null, 2), "utf8");
}

function writeRawPreset(rootDir: string, relativePath: string, manifest: Record<string, unknown>): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf8");
}

function makePreset(overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schema: "preset-manifest/v1",
    id: overrides.id,
    title: overrides.title,
    vertical: "software/coding",
    version: overrides.version,
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: overrides.templateSelections ?? []
    }],
    defaultProfile: "baseline"
  };
}

function conflictingTaskPlanSelection(): Record<string, unknown> {
  return {
    slot: "task.plan",
    templateRef: "template://planning/progress@1",
    materializeAs: "task_plan.md",
    localePolicy: {
      prefer: "project",
      fallback: "en-US"
    }
  };
}

function invalidPathSelection(): Record<string, unknown> {
  return {
    slot: "task.extra",
    templateRef: "template://planning/references-index@1",
    materializeAs: ".",
    localePolicy: {
      prefer: "project",
      fallback: "en-US"
    }
  };
}

function makeMultiProfilePreset(): Record<string, unknown> {
  return {
    schema: "preset-manifest/v1",
    id: "profiled-task",
    title: "Profiled Task",
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [],
    profiles: [
      {
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      },
      {
        id: "extra",
        title: "Extra",
        checkerProfile: "standard",
        templateSelections: [{
          slot: "task.extra",
          templateRef: "template://planning/references-index@1",
          materializeAs: "extra.md",
          localePolicy: {
            prefer: "project",
            fallback: "en-US"
          }
        }]
      }
    ],
    defaultProfile: "baseline"
  };
}

function validTaskPlan(): string {
  return [
    "# Governance Task",
    "",
    "Task Contract: harness-task v1",
    "",
    "## 目标",
    "",
    "Validate governance profiles.",
    ""
  ].join("\n");
}

function validReview(): string {
  return [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n");
}

function validVisualMap(): string {
  return [
    "# Visual Map",
    "",
    "| Phase ID | Kind | Depends On | State | Completion | Output | Required Evidence | Exit Command | Actor | Evidence Status | Blocking Risk | Owner / Handoff |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |",
    "| INIT-01 | init | none | done | 100 | plan | task_plan.md | n/a | coordinator | present | none | coordinator |",
    ""
  ].join("\n");
}

function validExecutionStrategy(): string {
  return [
    "# Execution",
    "",
    "| Gate | State | Decided By | Decided At | Scope | Worktree / Branch | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| worker subagent | not-needed | coordinator | 2026-06-13 | not used | n/a | reviewer-only |",
    ""
  ].join("\n");
}

function validLessonCandidates(): string {
  return [
    "# Lessons",
    "",
    "| ID | Row Status | Title | Scope | Module Key | Detail Artifact | Boundary Reason | Why It Might Matter | Review Decision | Promotion Target | Conflict Check | Required Standard Update | Follow-up Task |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| LC-001 | ready-for-review | Keep Task Lessons Local | task | n/a | task-local | prevents silent global mutation | reusable lesson workflow | pending | harness/lessons | no conflict | none | none |",
    ""
  ].join("\n");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p3-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
