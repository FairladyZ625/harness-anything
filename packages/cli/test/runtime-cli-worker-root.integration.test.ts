// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import {
  cli,
  createRuntimeFixture,
  installIdentities,
  readPublishedDispatch,
  runMaybe,
  seedTask,
} from "./runtime-cli.fixtures.ts";

// F-3AC0AFF0: a worker handed ledger paths that resolve only under the canonical checkout takes that checkout for
// its repository root and edits source there. A task-worktree dispatch names one root, and every path resolves in it.
test("a task-worktree dispatch hands the worker only paths under its own root, ledger included", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture;
  gitRepository(root);
  installIdentities(parent, root, env);
  // The worker reads its plan and writes into its task package through the package root the mission names.
  writeProviderExecutable(
    path.join(parent, "bin", "codex"),
    [
      'const fs = require("node:fs"), path = require("node:path");',
      "const args = process.argv.slice(2);",
      `if (args[0] === "--version") { console.log("codex ${fixture.version}"); process.exit(0); }`,
      'if (args[0] === "login" && args[1] === "status") process.exit(0);',
      'const prompt = fs.readFileSync(0, "utf8");',
      'const packageRoot = prompt.split("Task package root: ")[1].split("\\n")[0];',
      'const taskId = prompt.split("Canonical Task ID: ")[1].split("\\n")[0];',
      'const plan = fs.readFileSync(path.join(packageRoot, "task_plan.md"), "utf8");',
      // The CLI run from the worker root still reaches the registered repository, not the worktree as a repository.
      `const shown = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "show", taskId], { encoding: "utf8", env: process.env });`,
      'fs.writeFileSync(path.join(packageRoot, "artifacts", "worker-probe.json"), JSON.stringify({ cwd: process.cwd(), packageRoot, plan, prompt, shown: { status: shown.status, stdout: shown.stdout, stderr: shown.stderr } }));',
      'console.log(JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }));',
      'console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "final" } }));',
      'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));',
      "",
    ].join("\n"),
  );
  const task = seedTask(root, env, "wt-worker-root"),
    canonical = realpathSync(root),
    worktree = path.join(canonical, ".worktrees", task.taskId);
  // The probe worker writes its artifact but commits nothing and submits nothing, so the dispatch
  // settles unknown and exits 1 (F-4C182EEE); the path scoping below is what this case verifies.
  const probeRun = runMaybe(root, env, ["agent", "run", "terra", "--task", task.taskId, "--no-stream"]);
  assert.equal(probeRun.status, 1, `${probeRun.stderr}\n${JSON.stringify(probeRun.receipt)}`);
  // The probe was written through the worker root and is read here from the canonical ledger: one ledger.
  const probe = JSON.parse(await readPublishedDispatch(path.join(task.artifactRoot, "worker-probe.json"))) as {
    readonly cwd: string;
    readonly packageRoot: string;
    readonly plan: string;
    readonly prompt: string;
    readonly shown: { readonly status: number | null; readonly stdout: string; readonly stderr: string };
  };

  assert.equal(probe.cwd, worktree, "the worker process runs in its task worktree");
  assert.equal(probe.packageRoot, path.join(worktree, "harness", task.packagePath));
  assert.equal(probe.plan, readFileSync(path.join(root, "harness", task.packagePath, "task_plan.md"), "utf8"));
  assert.equal(probe.shown.status, 0, probe.shown.stdout + probe.shown.stderr);
  assert.ok(probe.shown.stdout.includes(task.taskId), probe.shown.stdout);
  assert.match(probe.prompt, new RegExp(`^Worker repository root: ${escapeRegExp(worktree)}$`, "mu"));
  assert.match(
    probe.prompt,
    new RegExp(`^- review: ${escapeRegExp(path.join(worktree, "harness", "skills", "review", "SKILL.md"))}$`, "mu"),
  );
  assert.doesNotMatch(probe.prompt, /Canonical repository root/u);
  assert.deepEqual(
    probe.prompt
      .replaceAll(worktree, "<worker-root>")
      .split("\n")
      .filter((line) => line.includes(canonical)),
    [],
    "outside its own root the worker is never told where the canonical checkout is",
  );
  // The entry files `ha init` seeded are checked out with the worktree, and no ledger path they name is one the
  // worker would have to leave its root to read.
  const named = ["AGENTS.md", "CLAUDE.md"]
    .flatMap((entry) => [...readFileSync(path.join(worktree, entry), "utf8").matchAll(/`(harness\/[^`]*)`/gu)])
    .map((match) => match[1]!)
    .filter((ledgerPath) => existsSync(path.join(root, ledgerPath)));
  assert.ok(named.includes("harness/tasks/"), "the entry files name ledger paths");
  assert.deepEqual(
    named.filter((ledgerPath) => !existsSync(path.join(worktree, ledgerPath))),
    [],
    "every ledger path the entry files name resolves under the worker root",
  );
  // The link is invisible to git in the worktree, and nothing was written into the canonical checkout's source.
  assert.equal(git(worktree, "status", "--short"), "");
  assert.equal(git(root, "diff", "--name-only"), "");
});

function gitRepository(root: string): void {
  const remote = path.join(path.dirname(root), "origin.git"),
    ignore = path.join(root, ".gitignore");
  git(path.dirname(root), "init", "--bare", "-q", remote);
  git(root, "config", "user.name", "Worktree Demo");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(ignore, `${readFileSync(ignore, "utf8")}node_modules/\n`);
  writeFileSync(path.join(root, "README.md"), "demo\n");
  git(root, "add", ".gitignore", "README.md", "AGENTS.md", "CLAUDE.md");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "-M", "main");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
