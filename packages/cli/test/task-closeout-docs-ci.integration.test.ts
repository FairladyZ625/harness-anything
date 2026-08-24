// harness-test-tier: integration
/**
 * The end-to-end half of the contract-driven CI judgment. The unit tests stub the snapshot;
 * this one drives a real daemon, a real docs-task package whose preset declares
 * `completionGates: []`, and the real `ha task closeout` command, because the same bad state
 * asked through a different command is how a lying layer gets caught.
 *
 * A docs task carries no CI run on its change, so `not_applicable` is the only honest value and
 * has to be the one that works; `passed` would be a CI judgment nobody ran.
 */
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
const createFields = [
  "title",
  "taskId",
  "idempotencyKey",
  "parentTaskId",
  "workKind",
  "riskTier",
  "urgency",
  "verticalId",
  "presetId",
  "profileId",
  "moduleKey",
  "registerModule",
  "slug",
  "surfaces",
  "relations",
  "taskClass",
  "locale",
  "fromLegacyId",
  "createMode",
] as const;

test("a real docs task with no declared ci gate closes out on not_applicable and refuses an invented passed", (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-closeout-docs-ci-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task-closeout-docs-ci",
    executionId = "execution-closeout-docs-ci";
  initialize(root);
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "closeout-docs-ci",
      "--root",
      root,
      "--no-link",
    ]);
    writeFileSync(
      path.join(root, "create.json"),
      JSON.stringify({
        ...Object.fromEntries(createFields.map((field) => [field, null])),
        title: "Docs Closeout CI",
        taskId,
        presetId: "docs-task",
        verticalId: "software/coding",
        workKind: "docs",
        taskClass: "standard",
      }),
    );
    const presetList = runHumanMaybe(root, userRoot, ["preset", "list"]),
      standardPreview = runHumanMaybe(root, userRoot, [
        "task",
        "create",
        "--title",
        "Standard Completion Contract",
        "--preset",
        "standard-task",
        "--dry-run",
      ]);
    context.diagnostic(`preset-list-human=${presetList.stdout}`);
    context.diagnostic(`standard-task-create-human=${standardPreview.stdout}`);
    assert.equal(presetList.status, 0, presetList.stderr || presetList.stdout);
    assert.match(
      presetList.stdout,
      /standard-task[\s\S]*outputShape: repository-diff[\s\S]*completionGates: \["ci","code-doc-reconciliation"\]/u,
    );
    assert.equal(
      standardPreview.status,
      0,
      standardPreview.stderr || standardPreview.stdout,
    );
    assert.match(
      standardPreview.stdout,
      new RegExp(
        [
          "preset: standard-task/baseline\\n",
          "outputShape: repository-diff\\n",
          'completionGates: \\["ci","code-doc-reconciliation"\\]',
        ].join(""),
        "u",
      ),
    );
    assert.match(
      standardPreview.stdout,
      new RegExp(
        [
          "contract: repository-diff requires a committable public-repository diff,",
          "[\\s\\S]*preset docs-task\\.\\nnext: remove --dry-run",
        ].join(""),
        "u",
      ),
    );
    const created = run(root, userRoot, [
        "task",
        "create",
        "--from-file",
        "create.json",
      ]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`,
      commitSha = git(root, "rev-parse", "HEAD");
    context.diagnostic(
      `docs-task-completion-gates=${JSON.stringify(created.completionGates)}`,
    );
    assert.deepEqual(
      created.completionGates,
      [],
      "the docs-task preset must declare no completion gates for this fixture to mean anything",
    );
    assert.equal(created.presetId, "docs-task");
    assert.equal(created.profileId, "baseline");
    assert.equal(created.outputShape, "task-package-artifact");

    run(
      root,
      userRoot,
      ["task", "start", taskId, "--execution-id", executionId],
      "agent:worker",
    );
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nDocs only.\n\n## Verification\n\nRead the artifact.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
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
      completionClaim: "The docs task is complete.",
      deliverables: ["report"],
      outputs: ["artifact"],
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
    const judgment = (ci: string) => ({
      submission,
      review: {
        verdict: "approved",
        reason: "Independent fixture review passed.",
        evidenceChecked: ["submitted execution"],
      },
      consent: { approved: true },
      completion: { ci, codeDocPaths: [] },
    });

    writeFileSync(
      path.join(root, "invented.json"),
      JSON.stringify(judgment("passed")),
    );
    const invented = runMaybe(root, userRoot, [
      "task",
      "closeout",
      taskId,
      "--from-file",
      "invented.json",
    ]);
    context.diagnostic(`invented-passed=${invented.stdout}`);
    assert.notEqual(
      invented.status,
      0,
      "a docs task with no ci gate must not accept an invented passed judgment",
    );
    const rejection = JSON.parse(invented.stdout) as Record<string, unknown>;
    assert.equal(rejection.code, "invalid_judgment", invented.stdout);
    assert.match(
      String(rejection.nextAction),
      /completion\.ci must be not_applicable/u,
    );
    assert.equal(
      (
        JSON.parse(
          String(
            (
              JSON.parse(
                runMaybe(root, userRoot, ["task", "show", taskId]).stdout,
              ) as Record<string, unknown>
            ).evidence,
          ),
        ) as { task: { status: string } }
      ).task.status,
      "in_review",
      "the refused closeout must not have moved the task",
    );

    writeFileSync(
      path.join(root, "honest.json"),
      JSON.stringify(judgment("not_applicable")),
    );
    const honest = runMaybe(root, userRoot, [
      "task",
      "closeout",
      taskId,
      "--from-file",
      "honest.json",
    ]);
    context.diagnostic(`honest-not-applicable=${honest.stdout}`);
    assert.equal(honest.status, 0, honest.stderr || honest.stdout);
    const receipt = JSON.parse(honest.stdout) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied", honest.stdout);
    assert.deepEqual(
      (receipt.steps as Array<Record<string, unknown>>).map(
        ({ stage }) => stage,
      ),
      ["review-execution", "review-consent", "complete"],
    );
    const shown = runMaybe(root, userRoot, ["task", "show", taskId]);
    context.diagnostic(`docs-ci-final=${shown.stdout}`);
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
  git(root, "config", "user.name", "Closeout Docs CI Test");
  git(root, "config", "user.email", "closeout-docs@example.test");
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
    HARNESS_DAEMON_ID: "task-closeout-docs-ci",
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
function runHumanMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, ...args], {
    encoding: "utf8",
    env: environment(root, userRoot),
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
