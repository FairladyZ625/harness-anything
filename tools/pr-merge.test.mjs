// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./pr-merge.mjs", import.meta.url));

function run(command, args, { cwd, env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    ...(process.platform === "win32" && command === "gh" ? { shell: true } : {}),
  });
  if (!allowFailure && result.status !== 0) {
    assert.fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function git(cwd, ...args) {
  // The task-bound git wrapper on a worker's PATH refuses the fixture's pushes to main.
  return run("git", args, { cwd, env: { ...process.env, HARNESS_TASK_BOUND: "" } }).stdout.trim();
}

function makeFakeGh(root) {
  const bin = path.join(root, "bin"),
    gh = path.join(bin, "gh"),
    script = `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.PR_STATE_PATH;
const data = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(data));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (!args.includes("--required")) process.exit(3);
  process.stdout.write("required-checks pass\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const expected = ["--merge", "--admin", "--match-head-commit", data.headRefOid];
  if (!expected.every((token) => args.includes(token))) process.exit(4);
  data.state = "MERGED";
  writeFileSync(statePath, JSON.stringify(data));
  process.stdout.write("merged by fake gh\\n");
} else {
  process.stderr.write(\`unexpected gh args: \${args.join(" ")}\\n\`);
  process.exit(2);
}
`;
  mkdirSync(bin);
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "gh.mjs"), script, "utf8");
    writeFileSync(
      path.join(bin, "gh.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0gh.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
    return bin;
  }
  writeFileSync(gh, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(gh, 0o755);
  return bin;
}

function makeFakeHa(bin) {
  const script = `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.HA_STATE_PATH, "utf8"));
if (args[0] !== "task" || args[1] !== "show" || !args[2] || args[3] !== "--json") {
  process.stderr.write(\`unexpected ha args: \${args.join(" ")}\\n\`);
  process.exit(2);
}
if (state.fail) {
  process.stderr.write("Error: daemon socket not found; is the harness daemon running?\\n");
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({
    schema: "command-receipt/v2",
    ok: true,
    command: "task-show",
    outcome: "applied",
    opId: \`read:\${args[2]}\`,
    evidence: JSON.stringify(state.receipt),
  }),
);
`;
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "ha.mjs"), script, "utf8");
    writeFileSync(
      path.join(bin, "ha.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0ha.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
    return;
  }
  const ha = path.join(bin, "ha");
  writeFileSync(ha, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(ha, 0o755);
}

// haState shapes the fake `ha` fixture: { fail: true } answers every task-show with an
// unreachable-daemon exit, { receipt: <task-show evidence payload> } answers with that payload.
// A fake ha always shadows any real one so tests never reach the production daemon.
function fixture(t, { branch = "codex/pr-123", haState = { fail: true } } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-merge-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const main = path.join(root, "main");
  const prWorktree = path.join(root, "pr-worktree");
  const statePath = path.join(root, "pr-state.json");
  const haStatePath = path.join(root, "ha-state.json");

  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "PR Merge Test");
  git(seed, "config", "user.email", "pr-merge@example.test");
  writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", remote, main);

  git(seed, "checkout", "-b", branch);
  writeFileSync(path.join(seed, "feature.txt"), "feature\n");
  git(seed, "add", "feature.txt");
  git(seed, "commit", "-m", "feature");
  const headRefOid = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-u", "origin", branch);
  git(seed, "checkout", "main");
  writeFileSync(path.join(seed, "base.txt"), "base\nupstream\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "upstream");
  const upstreamHead = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "main");

  git(main, "fetch", "origin", branch);
  git(main, "branch", branch, `origin/${branch}`);
  git(main, "worktree", "add", prWorktree, branch);
  writeFileSync(
    statePath,
    JSON.stringify({
      number: 123,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: branch,
      headRefOid,
      isCrossRepository: false,
      mergeable: "MERGEABLE",
      url: "https://example.test/pull/123",
    }),
  );
  writeFileSync(haStatePath, JSON.stringify(haState));

  const fakeBin = makeFakeGh(root);
  makeFakeHa(fakeBin);
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    PR_STATE_PATH: statePath,
    HA_STATE_PATH: haStatePath,
    HARNESS_TASK_BOUND: "",
    HARNESS_ACTOR: "",
    HARNESS_CANONICAL_ROOT: "",
  };
  return { env, headRefOid, main, prWorktree, remote, seed, statePath, upstreamHead };
}

test("merges, cleans the PR branch and worktree, and fast-forwards local main", (t) => {
  const setup = fixture(t);
  const initialHead = git(setup.main, "rev-parse", "HEAD");
  assert.notEqual(initialHead, setup.upstreamHead);

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, /required-checks pass/u);
  assert.match(result.stdout, /Local main synchronized/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.equal(git(setup.main, "branch", "--show-current"), "main");
  assert.equal(existsSync(setup.prWorktree), false);
  assert.equal(git(setup.main, "branch", "--list", "codex/pr-123"), "");
  assert.equal(git(setup.main, "ls-remote", "--heads", "origin", "refs/heads/codex/pr-123"), "");
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
});

test("refuses a dirty main before merge or cleanup", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.main, "base.txt"), "do not discard\n");
  const initialHead = git(setup.main, "rev-parse", "HEAD");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /main worktree is dirty/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
  assert.equal(existsSync(setup.prWorktree), true);
  assert.notEqual(git(setup.main, "ls-remote", "--heads", "origin", "refs/heads/codex/pr-123"), "");
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "OPEN");
});

test("untracked files in main do not block merge or fast-forward", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.main, "untracked.txt"), "keep me\n");
  const initialHead = git(setup.main, "rev-parse", "HEAD");
  assert.notEqual(initialHead, setup.upstreamHead);

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, /Local main synchronized/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.equal(readFileSync(path.join(setup.main, "untracked.txt"), "utf8"), "keep me\n");
  assert.equal(existsSync(setup.prWorktree), false);
});

test("untracked files in the PR worktree pass preflight; git worktree remove refuses", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.prWorktree, "scratch.txt"), "keep me\n");
  const initialHead = git(setup.main, "rev-parse", "HEAD");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /untracked files/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(existsSync(setup.prWorktree), true);
  assert.equal(readFileSync(path.join(setup.prWorktree, "scratch.txt"), "utf8"), "keep me\n");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
});

test("git pull refuses when an incoming commit collides with an untracked file", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.seed, "colliding.txt"), "from upstream\n");
  git(setup.seed, "add", "colliding.txt");
  git(setup.seed, "commit", "-m", "add colliding.txt");
  const collisionHead = git(setup.seed, "rev-parse", "HEAD");
  git(setup.seed, "push", "origin", "main");
  writeFileSync(path.join(setup.main, "colliding.txt"), "keep me\n");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /colliding\.txt/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(readFileSync(path.join(setup.main, "colliding.txt"), "utf8"), "keep me\n");
  assert.notEqual(git(setup.main, "rev-parse", "HEAD"), collisionHead);
});

test("remote deletion races continue cleanup; other deletion failures stop", async (t) => {
  for (const absent of [true, false]) {
    await t.test(absent ? "branch disappears after probe" : "remote deletion fails", (t) => {
      const setup = fixture(t);
      const initialHead = git(setup.main, "rev-parse", "HEAD");
      const receiver = path.join(path.dirname(setup.remote), "receive.mjs");
      const receiveScript = absent
        ? `const deletion = spawnSync("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/codex/pr-123"]);
if (deletion.status !== 0) process.exit(deletion.status ?? 1);
const result = spawnSync("git", ["receive-pack", remote], { stdio: "inherit" });
process.exit(result.status ?? 1);`
        : `process.stderr.write("remote deletion denied\\n");
process.exit(1);`;
      // Change the ref when receive-pack starts, after ls-remote has advertised it.
      writeFileSync(
        receiver,
        `import { spawnSync } from "node:child_process";
const remote = process.argv[2];
${receiveScript}
`,
      );
      git(setup.main, "config", "remote.origin.receivepack", `"${process.execPath}" "${receiver}"`);
      const result = run(process.execPath, [helper, "123"], {
        cwd: setup.main,
        env: setup.env,
        allowFailure: true,
      });
      assert.equal(result.status, absent ? 0 : 1, result.stderr);
      assert.equal(existsSync(setup.prWorktree), !absent);
      assert.equal(git(setup.main, "rev-parse", "HEAD"), absent ? setup.upstreamHead : initialHead);
      assert.equal(git(setup.main, "branch", "--list", "codex/pr-123") === "", absent);
      if (absent) assert.match(result.stdout, /Local main synchronized/u);
      else assert.match(result.stderr, /remote deletion denied/u);
    });
  }
});

const TASK_BRANCH = "task_9c0333244c936a312f0c6d4713";

function consentMissingHaState() {
  return {
    receipt: {
      task: { status: "in_review", taskId: TASK_BRANCH },
      completionBlocker: { code: "consent_missing", gate: "consent" },
      completionNext: {
        action: `ha task review-consent ${TASK_BRANCH}`,
        reason: "The owner's verdict accepts the latest approved review, pinned to its reviewed content.",
        authority: "person_zeyu",
        readCut: { revision: 1, iteration: 0, executionId: "exe_test" },
      },
    },
  };
}

test("refuses a task PR whose current execution has no consented approved review", (t) => {
  const setup = fixture(t, { branch: TASK_BRANCH, haState: consentMissingHaState() });
  const initialHead = git(setup.main, "rev-parse", "HEAD");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`ha task review-consent ${TASK_BRANCH}`, "u"));
  assert.match(result.stderr, /refusing to merge/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "OPEN");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
  assert.notEqual(git(setup.main, "ls-remote", "--heads", "origin", `refs/heads/${TASK_BRANCH}`), "");
  assert.equal(existsSync(setup.prWorktree), true);
});

test("merges a task PR once the ledger shows the consent chain closed", async (t) => {
  const states = [
    {
      label: "consent recorded, completion pending",
      haState: {
        receipt: {
          task: { status: "in_review", taskId: TASK_BRANCH },
          completionBlocker: null,
          completionNext: {
            action: `ha task complete ${TASK_BRANCH}`,
            reason: "The completion chain has no remaining blocker.",
            authority: "person_zeyu",
            readCut: { revision: 1, iteration: 0, executionId: "exe_test" },
          },
        },
      },
    },
    {
      label: "task done",
      haState: {
        receipt: {
          task: { status: "done", taskId: TASK_BRANCH },
          completionBlocker: null,
          completionNext: null,
        },
      },
    },
  ];
  for (const { label, haState } of states) {
    await t.test(label, (t) => {
      const setup = fixture(t, { branch: TASK_BRANCH, haState });
      const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

      assert.match(result.stdout, new RegExp(`Task ${TASK_BRANCH} passed the review-consent check`, "u"));
      assert.match(result.stdout, /Local main synchronized/u);
      assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
      assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
      assert.equal(existsSync(setup.prWorktree), false);
    });
  }
});

test("merges a non-task branch with an explanatory note", (t) => {
  const setup = fixture(t);

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, /codex\/pr-123 is not a task branch; merging without a review-consent check/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
});

test("fails closed when the harness ledger is unreachable for a task PR", (t) => {
  const setup = fixture(t, { branch: TASK_BRANCH });
  const initialHead = git(setup.main, "rev-parse", "HEAD");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /fail closed/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "OPEN");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
  assert.equal(existsSync(setup.prWorktree), true);
});
