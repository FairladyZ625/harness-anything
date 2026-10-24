// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { addManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import {
  dispatchLedgerReadTexts,
  privateLedgerReadSection,
  privateLedgerReferences,
  resolvePrivateLedgerReads,
} from "../src/private-ledger-paths.ts";
import { runWorktreeSetup, workerLedgerPath } from "../src/worktree-setup.ts";

const planBody = "# Plan\n",
  standards = path.join("harness", "governance", "standards"),
  standard = path.join(standards, "testing-standard.md"),
  contract = path.join(standards, "implementation-contract-standard.md"),
  devSkill = path.join("harness", "skills", "agent-dev-standards", "SKILL.md"),
  // As written in a prompt: forward slashes, exactly what the reference extractor records.
  isolatedEntry = "harness/skills/test-isolation/dispatch-isolated-test.mjs";

test("every declared read-set file keeps an openable path when the mission also names globs", async (t) => {
  const root = fixture(t),
    worktree = await privateWorktree(root),
    // The real dispatch shape: the declaration names the files to read first, and the mission body
    // names the directories it edits. The globs fan out to 40 files here, which is what pushed the
    // declared reads past the old 24-entry list.
    declared = `预置 Read Set：${devSkill}；${contract}；${standard}；当前 task_plan、mission 与任务点名文件。`,
    mission = [
      "# Mission",
      "见 agent 声明 harness/agents/*.json 的 prompts 字段。",
      "`harness/governance/standards/*.md`、`harness/context/architecture/*` 在 worker 根下全部不存在。",
    ].join("\n");

  // The premise: each declared file is a real file in the canonical ledger and absent from the
  // worktree checkout, which is what sent the worker into retries.
  for (const relative of [devSkill, contract, standard]) {
    assert.equal(existsSync(path.join(root, relative)), true, `${relative} must exist in the ledger`);
    assert.equal(existsSync(path.join(worktree, relative)), false, `${relative} must be absent in the worktree`);
  }

  const reads = resolvePrivateLedgerReads({ rootDir: root, cwd: worktree, texts: [declared, mission] }),
    section = privateLedgerReadSection(reads)!;

  // Nothing is truncated: three declared files plus three globs, one line each, no "N more" summary.
  assert.equal(reads.length, 6, JSON.stringify(reads, null, 2));
  assert.doesNotMatch(section, /more under/u);
  const lines = section.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, reads.length);

  for (const relative of [devSkill, contract, standard]) {
    const read = reads.find((candidate) => candidate.asWritten === relative);
    assert.ok(read, `${relative} must be listed, not crowded out by the globs`);
    assert.equal(read.directory, false);
    assert.equal(existsSync(read.readable), true, `${relative} must be openable at ${read.readable}`);
    assert.match(section, new RegExp(`- ${relative.replaceAll("/", "\\/")} -> .+`, "u"));
  }

  // A glob is answered by the one directory the worker can list, never by a file list.
  for (const glob of ["harness/agents/*.json", "harness/governance/standards/*.md", "harness/context/architecture/*"]) {
    const read = reads.find((candidate) => candidate.asWritten === glob);
    assert.ok(read, `${glob} must be listed`);
    assert.equal(read.directory, true);
    assert.equal(existsSync(read.readable), true);
    assert.equal(read.readable, path.join(root, path.dirname(glob)), "a glob resolves to its root directory");
  }
  assert.match(section, /directory: list it; a glob is not a file list/u);
  t.diagnostic(`private reads=${String(reads.length)} section bytes=${String(section.length)}`);
});

test("a private file gets one path, and it is the path Required Skills already uses", async (t) => {
  const root = fixture(t),
    worktree = await privateWorktree(root),
    reads = resolvePrivateLedgerReads({ rootDir: root, cwd: worktree, texts: [`读 ${standard}；再读 ${standard}。`] });

  assert.equal(reads.length, 1, "the same file is listed once");
  // One port, not two: the declared prompt resolves through `workerLedgerPath`, the resolver
  // Required Skills uses, so the write-isolation policy is the same one.
  assert.equal(reads[0]!.readable, workerLedgerPath(root, worktree, path.join(root, standard)));
  assert.notEqual(
    reads[0]!.readable,
    path.join(root, standard),
    "a worktree dispatch does not get the bare canonical path",
  );
  assert.equal(existsSync(reads[0]!.readable), true);
});

test("the canonical checkout and prose without a real target add no section", async (t) => {
  const root = fixture(t),
    worktree = await privateWorktree(root);

  // A dispatch rooted at the canonical checkout already resolves every relative reference.
  assert.deepEqual(resolvePrivateLedgerReads({ rootDir: root, cwd: root, texts: [`Read ${standard}.`] }), []);
  // A reference the ledger does not hold is prose, not a read, so the worker is never sent after
  // a path that does not exist.
  assert.deepEqual(
    resolvePrivateLedgerReads({
      rootDir: root,
      cwd: worktree,
      texts: ["harness/governance/standards/absent.md 不存在。", "harness/absent/*.md 也不存在。"],
    }),
    [],
  );
  assert.equal(privateLedgerReadSection([]), null);
});

test("references are extracted from prose without swallowing punctuation or absolute paths", () => {
  assert.deepEqual(privateLedgerReferences("读 harness/skills/a/SKILL.md。另见 /Users/x/harness-anything/AGENTS.md"), [
    "harness/skills/a/SKILL.md",
  ]);
  assert.deepEqual(privateLedgerReferences("harness/governance/{a.md,b.md} 与 harness/skills/*/SKILL.md"), [
    "harness/governance/{a.md,b.md}",
    "harness/skills/*/SKILL.md",
  ]);
  assert.deepEqual(privateLedgerReferences("harness/ 与 harness"), []);
  assert.deepEqual(privateLedgerReferences("`harness/governance/standards/testing-standard.md`,"), [
    "harness/governance/standards/testing-standard.md",
  ]);
});

test("a brace group enumerates files while a glob stops at its directory", async (t) => {
  const root = fixture(t),
    worktree = await privateWorktree(root),
    reads = resolvePrivateLedgerReads({
      rootDir: root,
      cwd: worktree,
      texts: [
        `harness/governance/standards/{testing-standard.md,implementation-contract-standard.md}；harness/skills/*/SKILL.md`,
      ],
    });

  // The brace group names two concrete files, so each one is a read the worker can open.
  for (const relative of [standard, contract]) {
    const read = reads.find((candidate) => candidate.asWritten === relative);
    assert.ok(read, `${relative} must be enumerated from the brace group`);
    assert.equal(read.directory, false);
    assert.equal(existsSync(read.readable), true);
  }
  // The glob names a directory of 40 files; expanding it is what starved the declared reads.
  const glob = reads.find((candidate) => candidate.asWritten === "harness/skills/*/SKILL.md");
  assert.equal(glob?.directory, true);
  assert.equal(glob?.readable, path.join(root, "harness", "skills"));
});

test("an implementation dispatch carries the isolated-test entry without naming it", async (t) => {
  const root = fixture(t),
    worktree = await privateWorktree(root),
    reads = resolvePrivateLedgerReads({
      rootDir: root,
      cwd: worktree,
      texts: dispatchLedgerReadTexts({
        prompts: [],
        instructions: null,
        mission: "# Mission\n本 mission 不点名任何私有路径。",
        reviewer: false,
        readOnly: false,
      }),
    }),
    entry = reads.find((candidate) => candidate.asWritten === isolatedEntry.replaceAll("\\", "/"));

  // task_936005e1: nothing named the entry, so the section omitted it and the worker read the
  // isolated dispatcher as absent, stopping without its targeted tests.
  assert.ok(entry, "the fixed entry must be listed for a coding dispatch");
  assert.equal(entry.directory, false);
  assert.equal(existsSync(entry.readable), true, `${isolatedEntry} must be openable at ${entry.readable}`);
  assert.match(privateLedgerReadSection(reads)!, new RegExp(`- ${isolatedEntry.replaceAll("/", "\\/")} -> .+`, "u"));
});

test("reviewer and read-only dispatches omit the fixed entry", () => {
  const lastText = (reviewer: boolean, readOnly: boolean) =>
    dispatchLedgerReadTexts({ prompts: [], instructions: null, mission: "MISSION", reviewer, readOnly }).at(-1);

  assert.deepEqual(privateLedgerReferences(lastText(false, false)!), [isolatedEntry]);
  assert.deepEqual(privateLedgerReferences(lastText(true, false)!), [], "a reviewer cannot run the entry");
  assert.deepEqual(privateLedgerReferences(lastText(false, true)!), [], "a read-only dispatch cannot run the entry");
});

/** A managed worktree of the fixture repo, prepared through the same setup production uses. */
async function privateWorktree(root: string): Promise<string> {
  const worktree = {
    cwd: path.join(root, ".worktrees", "task-private"),
    branch: "task-private",
    baseRef: "origin/main",
  };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-private", steps: [] });
  return worktree.cwd;
}

/**
 * A project repository whose private ledger holds the standards, the architecture docs and the
 * skills a real dispatch names; `standards` is large enough that expanding its glob would exhaust
 * any fixed-size list.
 */
function fixture(t: TestContext): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-private-ledger-"))),
    root = path.join(base, "canonical");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Private Ledger Test");
  git(root, "config", "user.email", "private@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "origin/main");
  mkdirSync(path.dirname(path.join(root, planBodyPath())), { recursive: true });
  writeFileSync(path.join(root, planBodyPath()), planBody);
  for (const relative of [
    standard,
    contract,
    devSkill,
    path.join("harness", "agents", "ae-discrimination.json"),
    path.join("harness", "agents", "ae-reconcile.json"),
    path.join("harness", "context", "architecture", "architecture-manifest.json"),
    path.join("harness", "context", "architecture", "README.md"),
    path.join("harness", "skills", "alpha", "SKILL.md"),
    path.join("harness", "skills", "zeta", "SKILL.md"),
    path.join("harness", "skills", "test-isolation", "dispatch-isolated-test.mjs"),
    ...Array.from({ length: 38 }, (_, index) => path.join(standards, `standard-${String(index).padStart(2, "0")}.md`)),
  ]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), `# ${path.basename(relative)}\n`);
  }
  assert.equal(existsSync(path.join(root, "harness")), true);
  return root;
}

function planBodyPath(): string {
  return path.join("harness", "tasks", "task-private-fixture", "task_plan.md");
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
