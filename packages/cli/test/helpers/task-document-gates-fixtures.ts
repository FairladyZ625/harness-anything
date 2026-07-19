import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeNestedHarnessRepo } from "./git-fixtures.ts";
import { unwrapCommandReceipt } from "./receipt.ts";
import { cliTestEnv } from "./cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const testActorEnv = { HARNESS_ACTOR: "agent:test" };

export function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: { readonly provenance?: boolean; readonly preset?: string; readonly taskClass?: "milestone" | "epic"; readonly parent?: string } = { provenance: true }
): void {
  const provenance = options.provenance !== false
    ? [
      "provenance:",
      "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}"
    ]
    : [];
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${directoryName}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    ...(options.parent ? [`parent: ${options.parent}`] : []),
    "vertical: software/coding",
    `preset: ${options.preset ?? "standard-task"}`,
    ...(options.taskClass ? [`taskClass: ${options.taskClass}`] : []),
    ...provenance,
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

export function writeReview(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n"), "utf8");
}

export function writeRealCloseout(
  rootDir: string,
  directoryName: string,
  options: { readonly coordinatedAnchors?: boolean; readonly sha?: string } = {}
): void {
  writeCloseout(rootDir, directoryName, [
    "## Summary",
    "",
    "Implemented the task document gate.",
    "",
    "## Verification",
    "",
    "npm run check passed.",
    "",
    "## Residual Risk",
    "",
    "No residual risk accepted."
  ]);
  const sha = options.sha ?? ensureAnchorCommit(rootDir);
  if (options.coordinatedAnchors ?? true) writeCodeDocAnchors(rootDir, directoryName, sha);
  else writeCodeDocAnchorsRaw(rootDir, directoryName, sha);
}

export function writeFact(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}

export function writeCloseout(rootDir: string, directoryName: string, lines: ReadonlyArray<string>): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "closeout.md"), ["# Closeout", "", ...lines, ""].join("\n"), "utf8");
}

export function writeExecution(rootDir: string, taskId: string, id: string, executorId: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "executions", `${id}.md`), `${JSON.stringify({
    schema: "execution/v1",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "worker" },
      executor: { kind: "agent", id: executorId },
      responsibleHuman: "worker"
    },
    claimed_at: "2026-07-11T00:00:00.000Z",
    submitted_at: "2026-07-11T00:01:00.000Z",
    closed_at: null,
    session_bindings: [{ role: "primary", archive_status: "complete" }],
    outputs: [],
    submission: { summary: "submitted", verification: ["tests passed"], residual_risks: [] }
  }, null, 2)}\n`, "utf8");
}

export function seedApprovedExecution(rootDir: string, taskId: string, id: string): void {
  writeExecution(rootDir, taskId, id, "worker-agent");
  const reviewed = runJson(rootDir, [
    "task", "review-execution", taskId,
    "--execution-id", id,
    "--verdict", "approved",
    "--findings", "All acceptance checks passed.",
    "--rationale", "The submitted Execution satisfies the Task intent.",
    "--consent-asserted", "Approval was received through an external channel."
  ], true, testActorEnv);
  assert.equal(reviewed.executionId, id);
}

export function writeCodeDocAnchors(rootDir: string, directoryName: string, sha = ensureAnchorCommit(rootDir)): void {
  runJson(rootDir, [
    "task", "code-doc", "reconcile", directoryName,
    "--commit", sha,
    "--path", "evidence/code-doc-anchor.txt"
  ]);
}

export function writeCodeDocAnchorsRaw(rootDir: string, directoryName: string, sha: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "code-doc-anchors.json"), `${JSON.stringify({
    schema: "code-doc-reconciliation/v1",
    taskId: directoryName,
    records: [{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [{ kind: "path", sha, path: "evidence/code-doc-anchor.txt" }]
    }]
  }, null, 2)}\n`, "utf8");
}

export function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-task-doc-gates-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

export function initializeGitRepo(rootDir: string): void {
  if (existsSync(path.join(rootDir, ".git"))) return;
  mkdirSync(rootDir, { recursive: true });
  runGit(rootDir, "init");
  runGit(rootDir, "config", "user.email", "test@example.com");
  runGit(rootDir, "config", "user.name", "Test User");
}

function ensureAnchorCommit(rootDir: string): string {
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/code-doc-anchor.txt"), "code-doc reconciliation fixture\n", "utf8");
  runGit(rootDir, "add", "evidence/code-doc-anchor.txt");
  runGit(rootDir, "commit", "-m", "seed code-doc anchor");
  return runGit(rootDir, "rev-parse", "HEAD");
}

export function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Record<string, string> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_SKIP_NPM_INSTALL: "1", ...testActorEnv, ...env }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout) as Record<string, any>;
    assert.equal(result.ok, true);
    return unwrapCommandReceipt(result);
  } catch (error) {
    if (expectSuccess) throw error;
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  }
}
