// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");
test("a submitted fixture reaches done through one ha task closeout command", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-task-closeout-e2e-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task-closeout-e2e",
    executionId = "execution-closeout-e2e";
  initialize(root);
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "closeout-e2e",
      "--root",
      root,
      "--no-link",
    ]);
    const created = run(root, userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Closeout E2E",
      ]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`,
      commitSha = git(root, "rev-parse", "HEAD");
    run(
      root,
      userRoot,
      ["task", "start", taskId, "--execution-id", executionId],
      "agent:worker",
    );
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
    );
    run(
      root,
      userRoot,
      [
        "doc",
        "sync",
        "--submit",
        "--task",
        taskId,
      ],
      "agent:worker",
    );
    const submission = {
      completionClaim: "The fixture is complete.",
      deliverables: ["task closeout command"],
      outputs: ["done task"],
      verificationNotes: ["one closeout invocation"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    };
    writeFileSync(
      path.join(root, "submission.json"),
      JSON.stringify(submission),
    );
    run(
      root,
      userRoot,
      ["task", "submit", taskId, "--from-file", "submission.json"],
      "agent:worker",
    );
    writeFileSync(
      path.join(root, "judgment.json"),
      JSON.stringify({
        submission,
        review: {
          verdict: "approved",
          reason: "Independent fixture review passed.",
          evidenceChecked: ["submitted execution"],
        },
        consent: { approved: true },
        completion: { ci: "passed", codeDocPaths: ["README.md"] },
      }),
    );
    const closeout = runMaybe(root, userRoot, [
      "task",
      "closeout",
      taskId,
      "--from-file",
      "judgment.json",
    ]);
    context.diagnostic(`closeout-e2e-output=${closeout.stdout}`);
    assert.equal(closeout.status, 0, closeout.stderr);
    const receipt = JSON.parse(closeout.stdout) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", closeout.stdout);
    assert.deepEqual(
      (receipt.steps as Array<Record<string, unknown>>).map(
        ({ stage }) => stage,
      ),
      ["review-execution", "review-consent", "complete"],
    );
    const shown = runMaybe(root, userRoot, ["task", "show", taskId]);
    context.diagnostic(`closeout-e2e-final=${shown.stdout}`);
    assert.equal(
      (
        JSON.parse(
          String(
            (JSON.parse(shown.stdout) as Record<string, unknown>).evidence,
          ),
        ) as {
          task: { status: string };
        }
      ).task.status,
      "done",
    );
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Closeout Test");
  git(root, "config", "user.email", "closeout@example.test");
  git(root, "add", "README.md", "harness");
  git(root, "commit", "--quiet", "-m", "fixture");
}
function environment(
  root: string,
  userRoot: string,
  actor?: string,
): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "task-closeout-e2e",
    ...(actor ? { HARNESS_ACTOR: actor } : {}),
  };
}
function startDaemon(root: string, userRoot: string): void {
  const started = runMaybe(root, userRoot, ["daemon", "start", "--service"]);
  if (started.status === 0) return;
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(started.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(started.stderr || started.stdout);
  }
  if (receipt.code !== "daemon_starting")
    throw new Error(started.stderr || started.stdout);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (runMaybe(root, userRoot, ["daemon", "status"]).status === 0) return;
  }
  throw new Error(String(receipt.nextAction));
}
function run(
  root: string,
  userRoot: string,
  args: readonly string[],
  actor?: string,
): Record<string, unknown> {
  const result = runMaybe(root, userRoot, args, actor);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function runMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
  actor?: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [cli, "--root", root, "--json", ...args],
    {
      encoding: "utf8",
      env: environment(root, userRoot, actor),
    },
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
