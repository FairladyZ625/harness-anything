// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reviewDigest, submissionDigest } from "@harness-anything/kernel";

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
  // GitHub answers UNKNOWN while it computes mergeability; later reads settle.
  if (Array.isArray(data.mergeableSequence) && data.mergeableSequence.length) {
    data.mergeable = data.mergeableSequence.shift();
    writeFileSync(statePath, JSON.stringify(data));
  }
  process.stdout.write(JSON.stringify(data));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (!args.includes("--required")) process.exit(3);
  process.stdout.write("required-checks pass\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const expected = ["--merge", "--admin", "--match-head-commit", data.headRefOid];
  if (!expected.every((token) => args.includes(token))) process.exit(4);
  data.state = "MERGED";
  data.mergeCommit = data.mergeCommit ?? { oid: "b".repeat(40) };
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
  const script = `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "task" && args[1] === "annotate") {
  if (process.env.HA_ANNOTATE_LOG_PATH) {
    appendFileSync(process.env.HA_ANNOTATE_LOG_PATH, JSON.stringify(args) + "\\n");
  }
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
const state = JSON.parse(readFileSync(process.env.HA_STATE_PATH, "utf8"));
if (args[0] !== "task" || args[1] !== "show" || !args[2] || args[3] !== "--json") {
  process.stderr.write(\`unexpected ha args: \${args.join(" ")}\\n\`);
  process.exit(2);
}

const showLog = process.env.HA_SHOW_LOG_PATH;
if (showLog) {
  appendFileSync(showLog, args.join(" ") + "\\n");
  const shown = readFileSync(showLog, "utf8").trim().split("\\n").length;
  const failFrom = Number(process.env.HA_FAIL_SHOW_FROM ?? "0");
  if (failFrom > 0 && shown >= failFrom) {
    process.stderr.write("Error: daemon is starting; waited 21s (repo 5/23: canonical)\\n");
    process.exit(1);
  }
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

function makeFakeNpm(bin) {
  const script = `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const packageName = args.at(-1);
appendFileSync(process.env.BUILD_LOG_PATH, packageName + "\\n");
if (packageName === process.env.BUILD_FAIL_PACKAGE) {
  process.stderr.write("simulated build failure\\n");
  process.exit(1);
}
`;
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "npm.mjs"), script, "utf8");
    writeFileSync(
      path.join(bin, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0npm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
    return;
  }
  const npm = path.join(bin, "npm");
  writeFileSync(npm, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(npm, 0o755);
}

// A git shim that refuses `pull`: the helper must synchronize through the remote-tracking ref
// instead of the repository-wide .git/FETCH_HEAD that a concurrent fetch rewrites (#4048).
function makeFakeGit(bin) {
  const script = `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "pull") {
  process.stderr.write("git pull must not be used: .git/FETCH_HEAD is shared\\n");
  process.exit(9);
}
const result = spawnSync(process.env.REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "git.mjs"), script, "utf8");
    writeFileSync(
      path.join(bin, "git.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0git.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8",
    );
    return;
  }
  const gitPath = path.join(bin, "git");
  writeFileSync(gitPath, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(gitPath, 0o755);
}

// Resolve the real binary behind any PATH shim, so the fixture's git shim can delegate to it
// instead of resolving `git` through a PATH that still contains the shim's own directory.
function resolveRealGit() {
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  return path.join(execPath, process.platform === "win32" ? "git.exe" : "git");
}

// haState shapes the fake `ha` fixture: { fail: true } answers every task-show with an
// unreachable-daemon exit, { receipt: <task-show evidence payload> } answers with that payload.
// A fake ha always shadows any real one so tests never reach the production daemon.
function fixture(t, { branch = "codex/pr-123", haState = { fail: true }, rejectPull = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-merge-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const main = path.join(root, "main");
  const prWorktree = path.join(root, "pr-worktree");
  const statePath = path.join(root, "pr-state.json");
  const haStatePath = path.join(root, "ha-state.json");
  const buildLogPath = path.join(root, "build.log");

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
  makeFakeNpm(fakeBin);
  if (rejectPull) makeFakeGit(fakeBin);
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    PR_STATE_PATH: statePath,
    HA_STATE_PATH: haStatePath,
    HA_SHOW_LOG_PATH: path.join(root, "show.log"),
    BUILD_LOG_PATH: buildLogPath,
    HA_ANNOTATE_LOG_PATH: path.join(root, "annotate.log"),
    REAL_GIT: resolveRealGit(),
    HARNESS_TASK_BOUND: "",
    HARNESS_ACTOR: "",
    HARNESS_CANONICAL_ROOT: "",
  };
  return {
    env,
    headRefOid,
    main,
    prWorktree,
    remote,
    seed,
    statePath,
    upstreamHead,
    buildLogPath,
    annotateLogPath: path.join(root, "annotate.log"),
  };
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
  assert.deepEqual(readFileSync(setup.buildLogPath, "utf8").trim().split("\n"), [
    "@harness-anything/daemon",
    "@harness-anything/cli",
  ]);
});

test("synchronizes local main without git pull's shared FETCH_HEAD", (t) => {
  // #4048: `git pull` reads .git/FETCH_HEAD after its own fetch, and any concurrent fetch in the
  // repository rewrites that shared file. The helper must fetch into the remote-tracking ref and
  // merge that ref instead.
  const setup = fixture(t, { rejectPull: true });

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Local main synchronized/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
});

test("reports which runtime package failed after local main synchronization", (t) => {
  const setup = fixture(t);
  setup.env.BUILD_FAIL_PACKAGE = "@harness-anything/cli";

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Building @harness-anything\/cli after synchronizing local main failed/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.deepEqual(readFileSync(setup.buildLogPath, "utf8").trim().split("\n"), [
    "@harness-anything/daemon",
    "@harness-anything/cli",
  ]);
});

test("waits while GitHub is still computing mergeability, then merges", (t) => {
  const setup = fixture(t);
  const state = JSON.parse(readFileSync(setup.statePath, "utf8"));
  writeFileSync(setup.statePath, JSON.stringify({ ...state, mergeableSequence: ["UNKNOWN", "MERGEABLE"] }));

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.equal(result.status, 0, result.stderr);
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

test("untracked files in the PR worktree pass preflight; the worktree removal is reported unfinished", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.prWorktree, "scratch.txt"), "keep me\n");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  // The merge already happened, so the independent cleanup steps still run; only the worktree and
  // its checked-out branch stay, and the report names them with the command that finishes them.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PR #123 is MERGED; 1 post-merge step\(s\) did not finish/u);
  assert.match(result.stderr, /remove the local worktree and branch for codex\/pr-123/u);
  assert.match(result.stderr, /finish with: git worktree remove .*pr-worktree/u);
  assert.doesNotMatch(result.stderr, /refusing to merge/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(existsSync(setup.prWorktree), true);
  assert.equal(readFileSync(path.join(setup.prWorktree, "scratch.txt"), "utf8"), "keep me\n");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.equal(git(setup.main, "ls-remote", "--heads", "origin", "refs/heads/codex/pr-123"), "");
});

test("the main synchronization refuses when an incoming commit collides with an untracked file", (t) => {
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
  assert.match(result.stderr, /synchronize local main/u);
  assert.match(result.stderr, /rebuild the runtime packages: skipped/u);
  assert.doesNotMatch(result.stderr, /refusing to merge/u);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(readFileSync(path.join(setup.main, "colliding.txt"), "utf8"), "keep me\n");
  assert.notEqual(git(setup.main, "rev-parse", "HEAD"), collisionHead);
  assert.equal(existsSync(setup.buildLogPath), false, "a stale main is never rebuilt");
});

test("a remote deletion failure is reported while the independent cleanup and sync still run", async (t) => {
  for (const absent of [true, false]) {
    await t.test(absent ? "branch disappears after probe" : "remote deletion fails", (t) => {
      const setup = fixture(t);
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
      assert.equal(existsSync(setup.prWorktree), false);
      assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
      assert.equal(git(setup.main, "branch", "--list", "codex/pr-123"), "");
      assert.match(result.stdout, /Local main synchronized/u);
      if (absent) assert.doesNotMatch(result.stderr, /remote branch/u);
      else {
        assert.match(result.stderr, /PR #123 is MERGED; 1 post-merge step\(s\) did not finish/u);
        assert.match(result.stderr, /delete remote branch origin\/codex\/pr-123: git push origin --delete/u);
        assert.match(result.stderr, /remote deletion denied/u);
      }
    });
  }
});

const TASK_BRANCH = "task_9c0333244c936a312f0c6d4713";

// The task-show evidence always carries the whole lifecycle snapshot (taskShowFromProjection spreads
// read.snapshot into the payload); fixtures mirror that shape so the guard sees realistic receipts.
function snapshotArrays(extra = {}) {
  return {
    executions: [],
    reviews: [],
    consents: [],
    gateWitnesses: [],
    ...extra,
  };
}

function consentMissingHaState() {
  return {
    receipt: {
      revision: 1,
      task: { status: "in_review", taskId: TASK_BRANCH, iteration: 0, completionGateIds: [] },
      ...snapshotArrays(),
      completionBlocker: { code: "consent_missing", gate: "consent" },
      completionNext: {
        action: `ha task review-consent ${TASK_BRANCH} --execution-id exe_test --review-id review_test`,
        reason: "The owner's verdict accepts the latest approved review, pinned to its reviewed content.",
        authority: "person_zeyu",
        readCut: { revision: 1, iteration: 0, executionId: "exe_test" },
      },
    },
  };
}

// A historical task-show receipt retains the retired CI gate in its frozen declaration. Its
// current completion blocker is delivery_missing until merge; review consent is judged separately.
// The digests use the kernel helpers so the fixture matches the facts production consumes.
function reviewChainWithDeliveryBlockerHaState({ consented = true, staleConsent = false, closeoutOverrides } = {}) {
  const submission = {
      commitSha: `5a1f${"0".repeat(36)}`,
      completionClaim: "Delivered the guarded merge path.",
      deliverables: ["tools/pr-merge.mjs"],
      outputs: [],
      verificationNotes: ["node --test tools/pr-merge.test.mjs"],
      knownGaps: [],
      residualRisks: [],
      completionContract: {
        gates: [
          {
            gateId: "ci",
            appliesTo: "code",
            witness: {
              adapterId: "github-actions",
              adapterOptions: {
                workflows: ["rewrite-ci"],
                branch: "main",
                event: "push",
                coverage: "exact",
                selection: "newest",
              },
            },
          },
        ],
      },
    },
    execution = {
      schema: "execution/v1",
      executionId: "exe_cut",
      taskId: TASK_BRANCH,
      nodeId: "implementation",
      iteration: 0,
      state: "submitted",
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      claimedAt: "2026-10-05T08:00:00.000Z",
      submittedAt: "2026-10-05T09:00:00.000Z",
      closedAt: null,
      submission,
    },
    review = {
      schema: "review/v1",
      reviewId: "rev_approved",
      taskId: TASK_BRANCH,
      executionId: "exe_cut",
      verdict: "approved",
      actor: { principal: { personId: "person_reviewer" }, executor: { id: "agent_reviewer" } },
      capabilityRef: "task.review",
      reason: "Delivery verified against the task contract.",
      evidenceChecked: ["closeout.md"],
      commitSha: submission.commitSha,
      iteration: 0,
      contentDigest: `sha256:${"ab".repeat(32)}`,
      submissionDigest: submissionDigest(submission),
      reviewedAt: "2026-10-05T10:00:00.000Z",
    },
    consent = {
      schema: "review-consent/v1",
      consentId: "consent_owner",
      taskId: TASK_BRANCH,
      executionId: "exe_cut",
      reviewId: "rev_approved",
      reviewDigest: reviewDigest(review),
      contentDigest: review.contentDigest,
      // A stale pin names a superseded cut: the owner consented, then the worker re-submitted.
      submissionDigest: staleConsent ? `sha256:${"cd".repeat(32)}` : submissionDigest(submission),
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      source: { channel: "cli" },
      consentedAt: "2026-10-05T11:00:00.000Z",
    };
  return {
    receipt: {
      revision: 7,
      task: {
        taskId: TASK_BRANCH,
        status: "in_review",
        currentNode: "review",
        iteration: 0,
        completionGateIds: ["ci"],
        ...(closeoutOverrides ? { closeoutOverrides } : {}),
      },
      ...snapshotArrays({
        executions: [execution],
        reviews: closeoutOverrides?.review === false ? [] : [review],
        consents: consented ? [consent] : [],
      }),
      completionBlocker: { code: "delivery_missing" },
      completionNext: {
        action: "ha task complete task",
        reason: "Confirm the delivery is merged to the configured target branch.",
        authority: "person_zeyu",
        readCut: { revision: 7, iteration: 0, executionId: "exe_cut" },
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

test("merges a consented task PR with a historical CI gate declaration and delivery_missing blocker", (t) => {
  // CH4 keeps frozen CI gates readable as retired history; completion now waits for merge evidence.
  // The merge command checks the approved review and owner consent before it creates that evidence.
  const setup = fixture(t, { branch: TASK_BRANCH, haState: reviewChainWithDeliveryBlockerHaState() });

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, new RegExp(`Task ${TASK_BRANCH} passed the review-consent check`, "u"));
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.equal(existsSync(setup.prWorktree), false);
});

test("merges a task PR whose receipt exceeds the spawnSync default maxBuffer", (t) => {
  // PR #3502's failure: a long-lived task's task-show receipt grew to 2.2 MiB, past spawnSync's
  // 1 MiB default maxBuffer, so reading it died with ENOBUFS and the merge failed closed. The
  // lifecycle progress log is what grows with task age, so pad it past the old default on top of
  // an otherwise consented receipt and require the judgment to still be read and the merge to run.
  const haState = reviewChainWithDeliveryBlockerHaState();
  haState.receipt.progress = [{ schema: "task-progress/v1", statement: "p".repeat(3 * 1024 * 1024) }];
  const setup = fixture(t, { branch: TASK_BRANCH, haState });

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, new RegExp(`Task ${TASK_BRANCH} passed the review-consent check`, "u"));
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
});

test("refuses a task PR whose missing consent is masked by a merge-only gate", async (t) => {
  const cases = [
    {
      label: "no consent recorded",
      haState: reviewChainWithDeliveryBlockerHaState({ consented: false }),
    },
    {
      label: "consent pinned to a superseded submission",
      haState: reviewChainWithDeliveryBlockerHaState({ staleConsent: true }),
    },
  ];
  for (const { label, haState } of cases) {
    await t.test(label, (t) => {
      const setup = fixture(t, { branch: TASK_BRANCH, haState });
      const initialHead = git(setup.main, "rev-parse", "HEAD");

      const result = run(process.execPath, [helper, "123"], {
        cwd: setup.main,
        env: setup.env,
        allowFailure: true,
      });

      assert.equal(result.status, 1, result.stdout);
      // The printed remedy states both ids, so running it as printed never asks for inference.
      assert.match(
        result.stderr,
        new RegExp(`ha task review-consent ${TASK_BRANCH} --execution-id exe_cut --review-id rev_approved`, "u"),
      );
      assert.match(result.stderr, /no owner-consented approved review for its current execution/u);
      assert.match(result.stderr, /refusing to merge/u);
      assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "OPEN");
      assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
      assert.equal(existsSync(setup.prWorktree), true);
    });
  }
});

test("merges a lightweight task PR whose review and consent gates were lifted at declaration", (t) => {
  // A lightweight profile owes no review or consent ever; requiring one here would deadlock the
  // very class of low-risk PRs the short path exists for.
  const setup = fixture(t, {
    branch: TASK_BRANCH,
    haState: reviewChainWithDeliveryBlockerHaState({
      consented: false,
      closeoutOverrides: { review: false, consent: false },
    }),
  });

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, new RegExp(`Task ${TASK_BRANCH} passed the review-consent check`, "u"));
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
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

test("a daemon restart between merge and annotation does not skip the post-merge steps", (t) => {
  // #4045/#4047: the merge succeeded, then the daemon restarting into a new build made the second
  // `ha task show` fail. The merge-sha annotation reuses the pre-merge snapshot, so the daemon
  // becoming unreachable after the merge must not abort the branch/worktree/main cleanup.
  const setup = fixture(t, { branch: TASK_BRANCH, haState: reviewChainWithDeliveryBlockerHaState() });
  setup.env.HA_FAIL_SHOW_FROM = "2";

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(setup.env.HA_SHOW_LOG_PATH, "utf8").trim().split("\n").length, 1);
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
  assert.equal(existsSync(setup.annotateLogPath), true);
  assert.match(readFileSync(setup.annotateLogPath, "utf8"), /merge_commit_sha:b{40}/u);
  assert.equal(existsSync(setup.prWorktree), false);
  assert.equal(git(setup.main, "branch", "--list", TASK_BRANCH), "");
  assert.equal(git(setup.main, "ls-remote", "--heads", "origin", `refs/heads/${TASK_BRANCH}`), "");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
});

test("an already merged PR with an unreachable ledger reports the annotation unfinished and finishes cleanup", (t) => {
  const setup = fixture(t, { branch: TASK_BRANCH });
  const prState = JSON.parse(readFileSync(setup.statePath, "utf8"));
  writeFileSync(setup.statePath, JSON.stringify({ ...prState, state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }));

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  // Nothing was merged in this run, so the failure is bookkeeping: it is named as an unfinished
  // post-merge step with a runnable remedy, and every independent git step still completes.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PR #123 is MERGED; 1 post-merge step\(s\) did not finish/u);
  assert.match(result.stderr, /annotate the current execution with merge_commit_sha/u);
  assert.match(result.stderr, /finish with: node tools\/pr-merge\.mjs 123/u);
  assert.doesNotMatch(result.stderr, /refusing to merge/u);
  assert.equal(existsSync(setup.annotateLogPath), false);
  assert.equal(existsSync(setup.prWorktree), false);
  assert.equal(git(setup.main, "branch", "--list", TASK_BRANCH), "");
  assert.equal(git(setup.main, "ls-remote", "--heads", "origin", `refs/heads/${TASK_BRANCH}`), "");
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
});

test("annotates the current execution with merge_commit_sha when a task PR is already merged", (t) => {
  const mergeSha = "a".repeat(40);
  const haState = reviewChainWithDeliveryBlockerHaState();
  const setup = fixture(t, { branch: TASK_BRANCH, haState });
  const prState = JSON.parse(readFileSync(setup.statePath, "utf8"));
  writeFileSync(
    setup.statePath,
    JSON.stringify({
      ...prState,
      state: "MERGED",
      mergeCommit: { oid: mergeSha },
    }),
  );

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is already merged; continuing with cleanup/u);
  assert.equal(existsSync(setup.annotateLogPath), true);
  const annotateLines = readFileSync(setup.annotateLogPath, "utf8").trim().split("\n");
  assert.equal(annotateLines.length, 1);
  const annotateArgs = JSON.parse(annotateLines[0]);
  assert.deepEqual(annotateArgs, [
    "task",
    "annotate",
    TASK_BRANCH,
    "--execution-id",
    "exe_cut",
    "--kind",
    "correction",
    "--note",
    `merge_commit_sha:${mergeSha}`,
  ]);
});

test("does not duplicate merge_commit_sha annotation when the current execution already carries it", (t) => {
  const mergeSha = "a".repeat(40);
  const haState = reviewChainWithDeliveryBlockerHaState();
  haState.receipt.executions[0].annotations = [
    {
      kind: "correction",
      note: `merge_commit_sha:${mergeSha}`,
      actor: { principal: { personId: "person_zeyu" } },
      annotatedAt: "2026-10-05T12:00:00.000Z",
    },
  ];
  const setup = fixture(t, { branch: TASK_BRANCH, haState });
  const prState = JSON.parse(readFileSync(setup.statePath, "utf8"));
  writeFileSync(
    setup.statePath,
    JSON.stringify({
      ...prState,
      state: "MERGED",
      mergeCommit: { oid: mergeSha },
    }),
  );

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is already merged; continuing with cleanup/u);
  assert.equal(existsSync(setup.annotateLogPath), false);
});
