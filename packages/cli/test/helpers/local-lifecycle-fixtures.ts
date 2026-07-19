import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unwrapCommandReceipt } from "./receipt.ts";
import { cliTestEnv } from "./cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const executionActorEnv = { HARNESS_ACTOR: "agent:test" } as const;

export function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: {
    readonly taskId?: string;
    readonly engine?: string;
    readonly ref?: string;
    readonly bindingFingerprint?: string;
    readonly packageDisposition?: string;
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
    `packageDisposition: ${options.packageDisposition ?? "active"}`,
    "vertical: software/coding",
    "preset: standard-task",
    "provenance:",
    `  - {runtime: "human", sessionId: "human-cli-${Date.parse(bindingCreatedAt)}", boundAt: "${bindingCreatedAt}"}`,
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

export function writeReview(rootDir: string, directoryName: string, findingRows: ReadonlyArray<string>): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...findingRows,
    ""
  ].join("\n"), "utf8");
}

export function writeFact(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}

export function writeCodeDocAnchors(rootDir: string, directoryName: string, sha = ensureAnchorCommit(rootDir)): void {
  runJson(rootDir, [
    "task", "code-doc", "reconcile", directoryName,
    "--commit", sha,
    "--path", "evidence/code-doc-anchor.txt"
  ]);
}

export function seedApprovedExecution(rootDir: string, taskId: string, id: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "executions", `${id}.md`), `${JSON.stringify({
    schema: "execution/v1",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "worker" },
      executor: { kind: "agent", id: "worker-agent" },
      responsibleHuman: "worker"
    },
    claimed_at: "2026-07-11T00:00:00.000Z",
    submitted_at: "2026-07-11T00:01:00.000Z",
    closed_at: null,
    session_bindings: [{ role: "primary", archive_status: "complete" }],
    outputs: [],
    submission: { summary: "submitted", verification: ["tests passed"], residual_risks: [] }
  }, null, 2)}\n`, "utf8");
  const reviewed = runJson(rootDir, [
    "task", "review-execution", taskId,
    "--execution-id", id,
    "--verdict", "approved",
    "--findings", "All acceptance checks passed.",
    "--rationale", "The submitted Execution satisfies the Task intent.",
    "--consent-utterance", "Approved"
  ], true, executionActorEnv);
  assert.equal(reviewed.executionId, id);
}

function ensureAnchorCommit(rootDir: string): string {
  if (!existsSync(path.join(rootDir, ".git"))) {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Test User"]);
  }
  const evidencePath = "evidence/code-doc-anchor.txt";
  mkdirSync(path.join(rootDir, path.dirname(evidencePath)), { recursive: true });
  writeFileSync(path.join(rootDir, evidencePath), "code-doc reconciliation fixture\n", "utf8");
  execFileSync("git", ["-C", rootDir, "add", evidencePath]);
  execFileSync("git", ["-C", rootDir, "commit", "-m", "seed code-doc anchor"]);
  return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function writeConflictMarker(rootDir: string): void {
  const filePath = path.join(rootDir, "harness/standards/repo.md");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n", "utf8");
}

export function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

export function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ ...env })
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

export function runRawJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return JSON.parse(stdout) as Record<string, any>;
}

export function runText(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): string {
  try {
    return execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stderr?: string };
    return failure.stderr ?? "";
  }
}
