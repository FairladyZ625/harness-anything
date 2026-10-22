// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { addManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import {
  expandLedgerReference,
  privateLedgerReadSection,
  privateLedgerReferences,
  resolvePrivateLedgerReads,
} from "../src/private-ledger-paths.ts";
import { runWorktreeSetup } from "../src/worktree-setup.ts";

const planBody = "# Plan\n",
  standard = path.join("harness", "governance", "standards", "testing-standard.md");

test("a worktree dispatch receives the canonical path for every private reference its prompt names", async (t) => {
  const root = fixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "task-private"), branch: "task-private", baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-private", steps: [] });
  const prompt = `预置 Read Set：${standard}；harness/context/architecture/{architecture-manifest.json,README.md}。`;

  // The premise: the reference is a real file in the canonical ledger and absent from the worktree,
  // which is what sends the worker into retries.
  const readable = path.join(root, standard);
  assert.equal(existsSync(readable), true);
  assert.equal(existsSync(path.join(worktree.cwd, standard)), false);

  const reads = resolvePrivateLedgerReads({ rootDir: root, cwd: worktree.cwd, texts: [prompt] });
  assert.deepEqual(
    reads.map((read) => [read.asWritten, read.readable]),
    [
      [
        "harness/context/architecture/architecture-manifest.json",
        path.join(root, "harness", "context", "architecture", "architecture-manifest.json"),
      ],
      ["harness/context/architecture/README.md", path.join(root, "harness", "context", "architecture", "README.md")],
      [standard, readable],
    ],
  );
  for (const read of reads) assert.equal(existsSync(read.readable), true, `${read.asWritten} must be openable`);

  const section = privateLedgerReadSection(reads)!;
  assert.match(section, /# Private Ledger Paths \(read-only\)/u);
  assert.match(section, /harness\/governance\/standards\/testing-standard\.md -> \//u);
  assert.match(section, /never copy one into the checkout, never write through one/u);
  t.diagnostic(`private reads=${String(reads.length)} section bytes=${String(section.length)}`);
});

test("the canonical checkout and prose without a real target add no section", async (t) => {
  const root = fixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "task-private"), branch: "task-private", baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-private", steps: [] });

  // A dispatch rooted at the canonical checkout already resolves every relative reference.
  assert.deepEqual(resolvePrivateLedgerReads({ rootDir: root, cwd: root, texts: [`Read ${standard}.`] }), []);
  // A prompt that merely says "harness/agents/*.json" or names a file the ledger does not hold
  // yields no read, so the worker is never sent after a path that does not exist.
  assert.deepEqual(
    resolvePrivateLedgerReads({
      rootDir: root,
      cwd: worktree.cwd,
      texts: ["改 harness/agents/*.json 声明；harness/governance/standards/absent.md 不存在。"],
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

test("brace groups and globs expand to the concrete files they name", (t) => {
  const root = fixture(t),
    authored = path.join(root, "harness");
  assert.deepEqual(expandLedgerReference("harness/governance/{a.md,b.md}", authored), [
    "harness/governance/a.md",
    "harness/governance/b.md",
  ]);
  assert.deepEqual(expandLedgerReference("harness/skills/*/SKILL.md", authored), [
    "harness/skills/alpha/SKILL.md",
    "harness/skills/zeta/SKILL.md",
  ]);
  assert.deepEqual(expandLedgerReference("harness/absent/*.md", authored), []);
  assert.deepEqual(expandLedgerReference(standard, authored), [standard]);
});

/** A project repository with a private ledger holding one standard, two skills and one architecture doc. */
function fixture(t: TestContext): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-private-ledger-"))),
    root = path.join(base, "canonical"),
    ledger = path.join(root, "harness");
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
    path.join("harness", "context", "architecture", "architecture-manifest.json"),
    path.join("harness", "context", "architecture", "README.md"),
    path.join("harness", "skills", "alpha", "SKILL.md"),
    path.join("harness", "skills", "zeta", "SKILL.md"),
  ]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), `# ${path.basename(relative)}\n`);
  }
  assert.equal(existsSync(ledger), true);
  return root;
}

function planBodyPath(): string {
  return path.join("harness", "tasks", "task-private-fixture", "task_plan.md");
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
