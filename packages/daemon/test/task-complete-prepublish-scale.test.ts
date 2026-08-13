// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { produceDocumentPublicationWitness } from "../src/authority/production/task-complete-prepublish-witness.ts";

const taskId = "task_01KZ9JFNGPFBFDP3J9ZW0B99CN";

test("publication attribution subprocess overhead stays constant as path count grows", async (context) => {
  const observations: Array<{
    readonly pathCount: number;
    readonly scanCount: number;
    readonly historyPathspecCount: number;
    readonly treeCallOverhead: number;
  }> = [];
  for (const pathCount of [3, 30]) {
    const fixture = pathScaleWitnessRepository(pathCount);
    try {
      const traced = await withGitTrace2(fixture.fixtureRoot, () =>
        Promise.resolve(produceDocumentPublicationWitness(fixture))
      );
      const calls = traced.commands.filter(isUnboundedFirstParentHistoryCall);
      const historyPathspecCount = calls[0]
        ? calls[0].slice(calls[0].indexOf("--") + 1).length
        : 0;
      const treeCallCount = traced.commands.filter((args) => args.includes("ls-tree")).length;
      observations.push({
        pathCount,
        scanCount: calls.length,
        historyPathspecCount,
        treeCallOverhead: treeCallCount - pathCount
      });
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }

  context.diagnostic(`publication attribution scans: ${observations
    .map((entry) => `${entry.pathCount} paths: history=${entry.scanCount}, pathspecs=${entry.historyPathspecCount}, tree-overhead=${entry.treeCallOverhead}`)
    .join(", ")}`);
  assert.equal(observations[0]!.scanCount, observations[1]!.scanCount, JSON.stringify(observations));
  assert.deepEqual(observations.map((entry) => entry.historyPathspecCount), [1, 1]);
  assert.deepEqual(observations.map((entry) => entry.treeCallOverhead), [1, 1]);
});

test("history scan tracing recognizes unbounded first-parent log and rev-list calls", () => {
  assert.equal(isUnboundedFirstParentHistoryCall(["-C", "/repo", "log", "--first-parent", "HEAD"]), true);
  assert.equal(isUnboundedFirstParentHistoryCall(["-C", "/repo", "rev-list", "--first-parent", "HEAD"]), true);
  assert.equal(isUnboundedFirstParentHistoryCall([
    "-C", "/repo", "rev-list", "--first-parent", "--max-count=1", "HEAD"
  ]), false);
  assert.equal(isUnboundedFirstParentHistoryCall([
    "-C", "/repo", "log", "--first-parent", "--since=2026-01-01", "HEAD"
  ]), false);
  assert.equal(isUnboundedFirstParentHistoryCall([
    "-C", "/repo", "rev-list", "--first-parent", "-n", "1", "HEAD"
  ]), false);
  assert.equal(isUnboundedFirstParentHistoryCall([
    "-C", "/repo", "rev-list", "--reverse", "first-parent..authority-tip", "--", "task_plan.md"
  ]), false);
});

function pathScaleWitnessRepository(documentCount: number) {
  assert.ok(documentCount > 0, "path scale fixture requires at least one task document");
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-prepublish-witness-path-scale-"));
  const rootDir = path.join(fixtureRoot, "workspace");
  const authoredRoot = path.join(rootDir, "harness");
  const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-path-scale`);
  mkdirSync(taskRoot, { recursive: true });
  gitInit(authoredRoot);
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Path scale fixture",
    "lifecycle:",
    "  engine: local",
    "  status: in_review",
    "---",
    "",
    "# Path scale fixture",
    ""
  ].join("\n"));
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "test: seed path scale task");

  git(authoredRoot, "checkout", "-q", "-b", "scale-publication");
  const documents = Array.from({ length: documentCount }, (_, index) => ({
    path: `artifacts/scale-evidence-${String(index + 1).padStart(2, "0")}.md`,
    body: `# Scale evidence ${index + 1}\n\nDeterministic publication fixture.\n`
  }));
  for (const document of documents) {
    const absolutePath = path.join(taskRoot, document.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, document.body);
  }
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "test: publish path scale documents [op_scale]");
  git(authoredRoot, "checkout", "-q", "main");
  git(authoredRoot, "merge", "-q", "--no-ff", "scale-publication", "-m", "materialize path scale documents [op_scale]");
  return { fixtureRoot, rootDir, authoredRoot, taskId, documents };
}

function gitInit(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
  execFileSync("git", ["-C", rootDir, "init", "-q", "-b", "main"]);
  git(rootDir, "config", "user.name", "Harness Test");
  git(rootDir, "config", "user.email", "harness@example.test");
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

interface GitTrace2Event {
  readonly event: string;
  readonly argv?: ReadonlyArray<string>;
}

async function withGitTrace2<Result>(
  fixtureRoot: string,
  operation: () => Promise<Result>
): Promise<{ readonly result: Result; readonly commands: ReadonlyArray<ReadonlyArray<string>> }> {
  const tracePath = path.join(fixtureRoot, "git-trace2.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    const result = await operation();
    return { result, commands: readGitTrace2Commands(tracePath) };
  } finally {
    restoreEnvironment("GIT_TRACE2_EVENT", previousTrace);
  }
}

function readGitTrace2Commands(tracePath: string): ReadonlyArray<ReadonlyArray<string>> {
  return readFileSync(tracePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GitTrace2Event)
    .flatMap((event) => event.event === "start" && event.argv ? [event.argv] : []);
}

function isUnboundedFirstParentHistoryCall(args: ReadonlyArray<string>): boolean {
  const isHistoryCommand = args.includes("log") || args.includes("rev-list");
  return isHistoryCommand
    && args.includes("--first-parent")
    && !args.some(isExplicitHistoryBound);
}

function isExplicitHistoryBound(arg: string): boolean {
  return /^(?:-\d+|-n(?:\d+)?)$/u.test(arg)
    || /^--(?:max-count|since(?:-as-filter)?|after|until|before|max-age|min-age)(?:=|$)/u.test(arg)
    || arg === "--no-walk";
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
