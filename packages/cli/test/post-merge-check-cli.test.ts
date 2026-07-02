import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord, type EntityRelationRecord } from "../../kernel/src/index.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI check --post-merge reports each hard-fail governance code", () => {
  const cases: ReadonlyArray<readonly [string, (rootDir: string) => void]> = [
    ["duplicate_task_id", (rootDir) => {
      writeIndex(rootDir, "task-a", "A", "planned");
      writeIndex(rootDir, "task-b", "B", "planned", { taskId: "task-a" });
    }],
    ["duplicate_external_binding", (rootDir) => {
      writeIndex(rootDir, "task-a", "A", "planned", { engine: "multica", ref: "FAI-1" });
      writeIndex(rootDir, "task-b", "B", "planned", { engine: "multica", ref: "FAI-1" });
    }],
    ["generated_tracked", (rootDir) => {
      execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
      writeFileSync(path.join(rootDir, ".projection.sqlite"), "legacy generated", "utf8");
      execFileSync("git", ["add", ".projection.sqlite"], { cwd: rootDir, stdio: "ignore" });
    }],
    ["binding_tampered", (rootDir) => {
      writeIndex(rootDir, "task-a", "A", "planned", { bindingFingerprint: "sha256:tampered" });
    }],
    ["conflict_marker_present", (rootDir) => {
      mkdirSync(path.join(rootDir, "harness/standards"), { recursive: true });
      writeFileSync(path.join(rootDir, "harness/standards/repo.md"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n", "utf8");
    }],
    ["dangling_entity_ref", (rootDir) => {
      writeIndex(rootDir, "task-a", "A", "planned");
      writeFileSync(path.join(rootDir, "harness/tasks/task-a/relations.md"), "depends on task/missing-task\n", "utf8");
    }],
    ["relation_cycle_detected", (rootDir) => {
      writeIndex(rootDir, "task-a", "A", "planned", {
        relations: [relationRecord("task/task-a", "task/task-b")]
      });
      writeIndex(rootDir, "task-b", "B", "planned", {
        relations: [relationRecord("task/task-b", "task/task-a")]
      });
    }]
  ];

  for (const [code, arrange] of cases) {
    withTempRoot((rootDir) => {
      arrange(rootDir);

      const result = runJson(rootDir, ["check", "--post-merge"], false);

      assert.equal(result.ok, false, code);
      assert.equal(result.error?.code, "projection_check_failed", code);
      assert.equal(result.warnings.some((warning: any) => warning.code === code && typeof warning.source === "string" && warning.severity === "hard-fail" && typeof warning.repairHint === "string"), true, code);
      assert.equal(result.report.summary.hardFailCount >= 1, true, code);
    });
  }
});

test("CLI check --post-merge visibly fails hand-written decision watermarks", () => {
  withTempRoot((rootDir) => {
    writeDecision(rootDir, "dec_MISSING", "");
    writeDecision(rootDir, "dec_DUPLICATE_A", "wm-duplicate");
    writeDecision(rootDir, "dec_DUPLICATE_B", "wm-duplicate");

    const result = runJson(rootDir, ["check", "--post-merge"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "projection_check_failed");
    const missing = result.warnings.find((warning: any) => warning.code === "decision_watermark_missing");
    const duplicate = result.warnings.find((warning: any) => warning.code === "decision_watermark_duplicate");
    assert.ok(missing);
    assert.equal(missing.severity, "hard-fail");
    assert.match(missing.message, /dec_MISSING/);
    assert.match(missing.message, /harness\/decisions\/decision-dec_MISSING\/decision\.md/);
    assert.ok(duplicate);
    assert.equal(duplicate.severity, "hard-fail");
    assert.match(duplicate.message, /dec_DUPLICATE_B/);
    assert.match(duplicate.message, /decision-dec_DUPLICATE_A\/decision\.md/);
    assert.match(duplicate.repairHint, /decision write coordinator path/);
    assert.equal(result.report.summary.hardFailCount >= 2, true);
  });
});

test("CLI check --post-merge reports done task document placeholders as visible warnings", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-a", "A", "done");
    writeFileSync(path.join(rootDir, "harness/tasks/task-a/closeout.md"), [
      "# Closeout",
      "",
      "## Summary",
      "",
      "Summarize the completed behavior change.",
      "",
      "## Verification",
      "",
      "List passing checks and CI.",
      "",
      "## Residual Risk",
      "",
      "Record accepted non-blocking risks.",
      ""
    ].join("\n"), "utf8");
    writeFileSync(path.join(rootDir, "harness/tasks/task-a/review.md"), [
      "# Review",
      "",
      "Status: not-started",
      "",
      "## Reviewer",
      "",
      "- Agent: pending",
      "- Mode: read-only review before merge",
      "",
      "## Findings",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["check", "--post-merge"]);

    assert.equal(result.ok, true);
    const closeout = result.warnings.find((warning: any) => warning.code === "closeout_placeholder");
    const review = result.warnings.find((warning: any) => warning.code === "review_placeholder");
    assert.ok(closeout);
    assert.equal(closeout.severity, "warning");
    assert.match(closeout.message, /harness\/tasks\/task-a\/closeout\.md/);
    assert.match(closeout.repairHint, /hard-fail/);
    assert.ok(review);
    assert.equal(review.severity, "warning");
    assert.match(review.message, /harness\/tasks\/task-a\/review\.md/);
    assert.match(review.repairHint, /hard-fail/);
  });
});

function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: {
    readonly taskId?: string;
    readonly engine?: string;
    readonly ref?: string;
    readonly bindingFingerprint?: string;
    readonly relations?: ReadonlyArray<EntityRelationRecord>;
  } = {}
): void {
  const taskId = options.taskId ?? directoryName;
  const engine = options.engine ?? "local";
  const ref = options.ref ?? "";
  const bindingCreatedAt = "2026-06-12T00:00:00.000Z";
  const bindingFingerprint = options.bindingFingerprint ?? (engine === "local" && ref === ""
    ? "sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7"
    : "sha256:fixture");
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    `  engine: ${engine}`,
    `  status: ${status}`,
    `  ref: ${ref}`,
    `  titleSnapshot: ${title}`,
    "  url: ",
    `  bindingCreatedAt: ${bindingCreatedAt}`,
    `  bindingFingerprint: ${bindingFingerprint}`,
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    ...(options.relations && options.relations.length > 0 ? [
      "relations:",
      ...options.relations.map(formatRelationFlowRecord)
    ] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeDecision(rootDir: string, decisionId: string, watermark: string): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    ...(watermark ? [`_coordinatorWatermark: ${watermark}`] : []),
    `title: ${decisionId}`,
    "state: active",
    "---",
    "",
    `# ${decisionId}`,
    ""
  ].join("\n"), "utf8");
}

function relationRecord(source: string, target: string): EntityRelationRecord {
  const base = {
    source,
    target,
    type: "relates" as const,
    direction: "directed" as const
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active"
  };
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-post-merge-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_SKIP_NPM_INSTALL: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout) as Record<string, any>;
    assert.equal(result.ok, true);
    return result;
  } catch (error) {
    if (expectSuccess) throw error;
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    return JSON.parse(stdout) as Record<string, any>;
  }
}
