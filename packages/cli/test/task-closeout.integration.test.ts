// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts");
test("a submitted fixture reaches done through one ha task closeout command", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-task-closeout-e2e-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task-closeout-e2e",
    executionId = "execution-closeout-e2e";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId: "closeout-e2e" });
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", "closeout-e2e", "--root", root, "--no-link"]);
    const created = run(root, userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Closeout E2E"]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`,
      commitSha = git(root, "rev-parse", "HEAD");
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The submitted fixture is ready for one-command closeout.",
      "--source",
      "test:task-closeout-e2e",
    ]);
    run(root, userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:worker");
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
    );
    run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker");
    const submission = {
      completionClaim: "The fixture is complete.",
      deliverables: ["task closeout command"],
      outputs: ["done task"],
      verificationNotes: ["one closeout invocation"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    };
    writeFileSync(path.join(root, "submission.json"), JSON.stringify(submission));
    run(root, userRoot, ["task", "submit", taskId, "--from-file", "submission.json"], "agent:worker");
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
    const closeout = runMaybe(root, userRoot, ["task", "closeout", taskId, "--from-file", "judgment.json"]);
    context.diagnostic(`closeout-e2e-output=${closeout.stdout}`);
    assert.equal(closeout.status, 0, closeout.stderr);
    const receipt = JSON.parse(closeout.stdout) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", closeout.stdout);
    assert.deepEqual(
      (receipt.steps as Array<Record<string, unknown>>).map(({ stage }) => stage),
      ["review-execution", "review-consent", "complete"],
    );
    const shown = runMaybe(root, userRoot, ["task", "show", taskId]);
    context.diagnostic(`closeout-e2e-final=${shown.stdout}`);
    assert.equal(
      (
        JSON.parse(String((JSON.parse(shown.stdout) as Record<string, unknown>).evidence)) as {
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

test("a standard task with only task-package deliverables completes without a fabricated code-doc path", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-task-closeout-report-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task-closeout-report",
    executionId = "execution-closeout-report";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId: "closeout-report" });
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", "closeout-report", "--root", root, "--no-link"]);
    const created = run(root, userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Report Closeout"]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`,
      reportPath = `${packagePath}/artifacts/report.md`;
    assert.deepEqual(created.completionGates, ["ci", "code-doc-reconciliation"]);
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The report-only fixture has no public repository deliverable.",
      "--source",
      "test:task-closeout-report",
    ]);
    run(root, userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:worker");
    writeFileSync(path.join(root, "harness", reportPath), "# Audit report\n\nNo public code changed.\n");
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nReport delivered.\n\n## Verification\n\nReviewed.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask-package-only delivery.\n",
    );
    run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker");
    const submission = {
      completionClaim: "The report-only fixture is complete.",
      deliverables: [reportPath],
      outputs: ["reviewed audit report"],
      verificationNotes: ["report reviewed"],
      knownGaps: [],
      residualRisks: [],
      commitSha: git(root, "rev-parse", "HEAD"),
    };
    writeFileSync(path.join(root, "submission.json"), JSON.stringify(submission));
    run(root, userRoot, ["task", "submit", taskId, "--from-file", "submission.json"], "agent:worker");
    writeFileSync(
      path.join(root, "judgment.json"),
      JSON.stringify({
        submission,
        review: {
          verdict: "approved",
          reason: "The task-package report is complete and no public code path exists.",
          evidenceChecked: [reportPath],
        },
        consent: { approved: true },
        completion: { ci: "passed", codeDocPaths: [] },
      }),
    );
    const closeout = runMaybe(root, userRoot, ["task", "closeout", taskId, "--from-file", "judgment.json"]);
    context.diagnostic(`closeout-report-output=${closeout.stdout}`);
    assert.equal(closeout.status, 0, closeout.stderr || closeout.stdout);
    const receipt = JSON.parse(closeout.stdout) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", closeout.stdout);
    const shown = JSON.parse(runMaybe(root, userRoot, ["task", "show", taskId]).stdout) as Record<string, unknown>,
      evidence = JSON.parse(String(shown.evidence)) as {
        task: { status: string };
        codeDocWitnesses: readonly unknown[];
      };
    assert.equal(evidence.task.status, "done");
    assert.deepEqual(evidence.codeDocWitnesses, [], "report-only completion must not fabricate a witness");
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
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
function environment(root: string, userRoot: string, actor?: string): NodeJS.ProcessEnv {
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
  if (receipt.code !== "daemon_starting") throw new Error(started.stderr || started.stdout);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (runMaybe(root, userRoot, ["daemon", "status"]).status === 0) return;
  }
  throw new Error(String(receipt.nextAction));
}
function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
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
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, actor),
  });
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
