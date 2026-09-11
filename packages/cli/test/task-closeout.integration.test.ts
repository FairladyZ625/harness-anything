// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  legacyGenerationSnapshotPath,
  makeTaskEventReader,
  sqliteLedgerPath,
} from "../../kernel/src/index.ts";
import { preflightConvertedGenerationActivation } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts");
test("closeout rejects legacy review input and requests completion without recording consent", (context) => {
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
    const created = run(root, userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Closeout E2E",
        "--preset",
        "docs-task",
      ]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`;
    assert.equal(created.status, "accepted_durable");
    const createdVisible = published(root, userRoot, created);
    assert.equal((createdVisible.worktree as { state: string }).state, "verified");
    assert.equal((createdVisible.git as { state: string }).state, "verified");
    assert.equal(existsSync(path.join(root, "harness", packagePath, "task_plan.md")), true);
    const schema = JSON.parse(
        String(run(root, userRoot, ["task", "closeout", taskId, "--print-schema"]).summary),
      ) as Record<string, unknown>,
      initialTemplate = JSON.parse(
        String(run(root, userRoot, ["task", "closeout", taskId, "--print-template"]).summary),
      ) as Record<string, unknown>;
    assert.equal(schema.$id, "harness://schema/task-closeout-packet/v1");
    assert.equal(Object.hasOwn(initialTemplate, "submission"), false);
    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan("Closeout E2E"));
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
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
    writeFileSync(path.join(root, "harness", packagePath, "artifacts/report.md"), "# Report\n\nFixture verified.\n");
    run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker");
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      readFileSync(path.join(root, "harness", closeoutPath), "utf8").replace(
        "## Summary\n",
        `## Summary\n\nDelivery commit: ${git(root, "rev-parse", "HEAD")}\n`,
      ),
    );
    submitPublished(root, userRoot, taskId);
    const resumeTemplate = JSON.parse(
      String(run(root, userRoot, ["task", "closeout", taskId, "--print-template"]).summary),
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(resumeTemplate, "submission"), false);
    const judgment = JSON.stringify({
      completion: { ci: "not_applicable", codeDocPaths: [] },
    });
    const legacy = runMaybe(
      root,
      userRoot,
      ["task", "closeout", taskId, "--json-input", "@-"],
      undefined,
      JSON.stringify({ ...JSON.parse(judgment), review: { verdict: "approved" }, consent: { approved: true } }),
    );
    assert.notEqual(legacy.status, 0);
    assert.match(legacy.stdout, /review|consent/u);
    const closeout = runMaybe(root, userRoot, ["task", "closeout", taskId, "--json-input", "@-"], undefined, judgment);
    context.diagnostic(`closeout-e2e-output=${closeout.stdout}`);
    assert.notEqual(closeout.status, 0, closeout.stdout);
    const receipt = JSON.parse(closeout.stdout) as Record<string, unknown>;
    assert.equal(receipt.stoppedAt, "complete", closeout.stdout);
    assert.deepEqual(
      (receipt.steps as Array<Record<string, unknown>>).map(({ stage }) => stage),
      ["complete"],
    );
    const shown = runMaybe(root, userRoot, ["task", "show", taskId]);
    context.diagnostic(`closeout-e2e-final=${shown.stdout}`);
    const final = JSON.parse(String((JSON.parse(shown.stdout) as Record<string, unknown>).evidence)) as {
      task: { status: string };
      reviews: readonly unknown[];
      consents: readonly unknown[];
    };
    assert.equal(final.task.status, "in_review");
    assert.deepEqual(final.reviews, []);
    assert.deepEqual(final.consents, []);
    assert.ok(Array.isArray(receipt.next) && receipt.next.length > 0);
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("task-package deliverables request completion without a fabricated code-doc path", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-task-closeout-report-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    taskId = "task-closeout-report",
    executionId = "execution-closeout-report";
  await prepareConvertedRepository(parent, root, "closeout-report");
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", "closeout-report", "--root", root, "--no-link"]);
    const created = run(root, userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Report Closeout",
        "--preset",
        "docs-task",
      ]),
      packagePath = String(created.packagePath),
      closeoutPath = `${packagePath}/closeout.md`,
      reportPath = `${packagePath}/artifacts/report.md`,
      reader = makeTaskEventReader({ rootDir: root, repoId: "closeout-report" }),
      bootstrap = reader.readEvent(String(created.opId));
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    const createdVisible = published(root, userRoot, created);
    assert.equal((createdVisible.git as { state: string }).state, "verified");
    assert.equal((createdVisible.worktree as { state: string }).state, "verified");
    assert.equal(bootstrap?.schema, "task-bootstrap-event/v1");
    if (bootstrap?.schema !== "task-bootstrap-event/v1")
      throw new Error("task create did not publish a bootstrap event");
    const initialPlan = bootstrap.payload.initialDocumentClaims.find(
      (claim) => claim.path === `${packagePath}/task_plan.md`,
    );
    assert.ok(initialPlan, "task bootstrap must own the initial authored plan");
    assert.deepEqual(
      reader.readContentBlob(initialPlan.sha256),
      Buffer.from(readFileSync(path.join(root, "harness", packagePath, "task_plan.md"))),
      "task create's event claim and initial authored plan must share the accepted bytes",
    );
    assert.equal(
      git(root, "show", `HEAD:harness/${packagePath}/task_plan.md`),
      readFileSync(path.join(root, "harness", packagePath, "task_plan.md"), "utf8").trim(),
      "the same create cut must publish the initial plan to Git",
    );
    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan("Report Closeout"));
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    assert.deepEqual(created.completionGates, []);
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
    const reportBody = "# Audit report\n\nNo public code changed.\n";
    writeFileSync(path.join(root, "harness", reportPath), reportBody);
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nReport delivered.\n\n## Verification\n\nReviewed.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask-package-only delivery.\n",
    );
    const reportPublication = run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker"),
      reportEvent = reader.readEvent(String(reportPublication.opId));
    assert.equal(reportPublication.status, "accepted_durable", JSON.stringify(reportPublication));
    const reportVisible = published(root, userRoot, reportPublication);
    assert.equal((reportVisible.git as { state: string }).state, "verified");
    assert.equal((reportVisible.worktree as { state: string }).state, "verified");
    assert.equal(reportEvent?.schema, "doc-event/v1");
    if (reportEvent?.schema !== "doc-event/v1")
      throw new Error("task report did not enter the canonical document event");
    const reportClaim = reportEvent.payload.changes.find((change) => change.path === reportPath)?.candidate;
    assert.ok(reportClaim, "declared task report must carry a durable content claim");
    assert.deepEqual(reader.readContentBlob(reportClaim.sha256), Buffer.from(reportBody));
    assert.equal(git(root, "show", `HEAD:harness/${reportPath}`), reportBody.trim());
    rmSync(path.join(root, "harness", reportPath));
    const materialized = run(root, userRoot, ["doc", "materialize"]);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    assert.equal((materialized.proof as { worktreeVisible: boolean }).worktreeVisible, true);
    assert.equal(readFileSync(path.join(root, "harness", reportPath), "utf8"), reportBody);
    writeFileSync(
      path.join(root, "harness", closeoutPath),
      readFileSync(path.join(root, "harness", closeoutPath), "utf8").replace(
        "## Summary\n",
        `## Summary\n\nDelivery commit: ${git(root, "rev-parse", "HEAD")}\n`,
      ),
    );
    submitPublished(root, userRoot, taskId);
    writeFileSync(
      path.join(root, "judgment.json"),
      JSON.stringify({
        completion: { ci: "not_applicable", codeDocPaths: [] },
      }),
    );
    const closeout = runMaybe(root, userRoot, ["task", "closeout", taskId, "--from-file", "judgment.json"]);
    context.diagnostic(`closeout-report-output=${closeout.stdout}`);
    assert.notEqual(closeout.status, 0, closeout.stdout);
    const receipt = JSON.parse(closeout.stdout) as Record<string, unknown>;
    assert.equal(receipt.stoppedAt, "complete", closeout.stdout);
    const shown = JSON.parse(runMaybe(root, userRoot, ["task", "show", taskId]).stdout) as Record<string, unknown>,
      evidence = JSON.parse(String(shown.evidence)) as {
        task: { status: string };
        codeDocWitnesses: readonly unknown[];
        reviews: readonly unknown[];
        consents: readonly unknown[];
      };
    assert.equal(evidence.task.status, "in_review");
    assert.deepEqual(evidence.reviews, []);
    assert.deepEqual(evidence.consents, []);
    assert.equal(
      evidence.codeDocWitnesses.length,
      0,
      "task-package-only completion does not fabricate a code-doc witness for empty codeDocPaths",
    );
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("two executions publishing one report basename keep both durable contents and their own owners", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-task-report-owner-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "report-owner",
    taskId = "task-report-owner",
    firstExecutionId = "execution-report-owner-a",
    secondExecutionId = "execution-report-owner-b",
    firstBody = "# Implementation report\n\nFirst execution finding.\n",
    secondBody = "# Implementation report\n\nSecond execution finding after the return.\n";
  await prepareConvertedRepository(parent, root, repoId);
  const reader = makeTaskEventReader({ rootDir: root, repoId });
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]);
    const created = run(root, userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Report Ownership",
        "--preset",
        "docs-task",
      ]),
      packagePath = String(created.packagePath),
      reportPath = `${packagePath}/artifacts/reports/implementation.md`,
      reportFile = path.join(root, "harness", reportPath);
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    published(root, userRoot, created);
    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan("Report Ownership"));
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The report ownership fixture publishes one report basename from two executions.",
      "--source",
      "test:task-report-owner",
    ]);
    writeFileSync(
      path.join(root, "harness", `${packagePath}/closeout.md`),
      "# Closeout\n\n## Summary\n\nFirst round.\n\n## Verification\n\nReport published.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask-package-only delivery.\n",
    );
    mkdirSync(path.dirname(reportFile), { recursive: true });
    run(root, userRoot, ["task", "start", taskId, "--execution-id", firstExecutionId], "agent:worker");
    writeFileSync(reportFile, firstBody);
    const firstPublication = run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker"),
      firstEvent = reader.readEvent(String(firstPublication.opId));
    assert.equal(firstPublication.status, "accepted_durable", JSON.stringify(firstPublication));
    assert.equal((published(root, userRoot, firstPublication).git as { state: string }).state, "verified");
    if (firstEvent?.schema !== "doc-event/v1") throw new Error("the first report did not enter a document event");
    assert.equal(
      firstEvent.payload.executionId,
      firstExecutionId,
      "the first report is owned by the execution that held the lease",
    );
    const firstClaim = firstEvent.payload.changes.find((change) => change.path === reportPath)?.candidate;
    assert.ok(firstClaim, "the first report needs its own durable content claim");
    const firstCommit = git(root, "rev-parse", "HEAD");
    assert.equal(git(root, "show", `${firstCommit}:harness/${reportPath}`), firstBody.trim());
    const closeoutFile = path.join(root, "harness", packagePath, "closeout.md");
    writeFileSync(
      closeoutFile,
      readFileSync(closeoutFile, "utf8").replace("## Summary\n", `## Summary\n\nDelivery commit: ${firstCommit}\n`),
    );
    submitPublished(root, userRoot, taskId, firstExecutionId);
    // A returned review is the only supported route from one execution to the next on one task.
    run(root, userRoot, [
      "task",
      "review-execution",
      taskId,
      "--execution-id",
      firstExecutionId,
      "--review-id",
      "review-report-owner-changes",
      "--json-input",
      JSON.stringify({
        verdict: "changes_requested",
        reason: "The report has to be rewritten by a second execution.",
        evidenceChecked: [reportPath],
      }),
    ]);
    const returned = JSON.parse(String(run(root, userRoot, ["task", "show", taskId]).evidence)) as {
      task: { status: string; iteration: number };
    };
    assert.equal(returned.task.status, "active");
    assert.equal(returned.task.iteration, 1, "a returned review opens the second execution round");
    run(root, userRoot, ["task", "start", taskId, "--execution-id", secondExecutionId], "agent:worker");
    writeFileSync(reportFile, secondBody);
    const secondPublication = run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], "agent:worker"),
      secondEvent = reader.readEvent(String(secondPublication.opId));
    context.diagnostic(`report-owner-second=${JSON.stringify(secondPublication)}`);
    assert.equal(secondPublication.status, "accepted_durable", JSON.stringify(secondPublication));
    assert.equal((published(root, userRoot, secondPublication).git as { state: string }).state, "verified");
    assert.notEqual(secondPublication.opId, firstPublication.opId);
    if (secondEvent?.schema !== "doc-event/v1") throw new Error("the second report did not enter a document event");
    assert.equal(
      secondEvent.payload.executionId,
      secondExecutionId,
      "the same report basename is owned by the second execution in the second round",
    );
    const secondClaim = secondEvent.payload.changes.find((change) => change.path === reportPath)?.candidate;
    assert.ok(secondClaim, "the second report needs its own durable content claim");
    assert.notEqual(secondClaim.sha256, firstClaim.sha256, "the two rounds publish different report bytes");
    assert.deepEqual(
      reader.readContentBlob(secondClaim.sha256),
      Buffer.from(secondBody),
      "the second execution's report is durable under its own claim",
    );
    assert.deepEqual(
      reader.readContentBlob(firstClaim.sha256),
      Buffer.from(firstBody),
      "the first execution's report content survives the same-basename republication",
    );
    assert.notDeepEqual(
      reader.readContentBlob(firstClaim.sha256),
      Buffer.from(secondBody),
      "the second round must not take over the first execution's content claim",
    );
    const replayedFirst = reader.readEvent(String(firstPublication.opId));
    assert.equal(
      replayedFirst?.schema === "doc-event/v1" ? replayedFirst.payload.executionId : null,
      firstExecutionId,
      "the first execution keeps its recorded ownership after the second round publishes",
    );
    assert.equal(git(root, "show", `${firstCommit}:harness/${reportPath}`), firstBody.trim());
    assert.equal(git(root, "show", `HEAD:harness/${reportPath}`), secondBody.trim());
    rmSync(reportFile);
    const materialized = run(root, userRoot, ["doc", "materialize"]);
    assert.equal(materialized.outcome, "applied", JSON.stringify(materialized));
    assert.equal(
      readFileSync(reportFile, "utf8"),
      secondBody,
      "restoring the shared basename yields the current round's content, not the returned round's",
    );
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});

/**
 * The gen-1 ledger a task-event reader can read: an empty legacy generation converted into `root`,
 * so a test can inspect canonical events and content blobs the daemon accepts.
 */
async function prepareConvertedRepository(parent: string, root: string, repoId: string): Promise<void> {
  initialize(root);
  const sourceRoot = path.join(parent, "import-source");
  initialize(sourceRoot);
  seedSettingsEvent({ rootDir: sourceRoot, repoId });
  const sourceLedger = makeTaskEventReader({ rootDir: sourceRoot, repoId }),
    snapshotPath = legacyGenerationSnapshotPath(root);
  try {
    const snapshot = createImmutableLegacyGenerationSnapshot({ repoId, source: sourceLedger, snapshotPath });
    const imported = convertLegacyGeneration({
      rootDir: root,
      snapshotPath,
      fence: { repoId, holder: "cold-import", epoch: 40 },
    });
    assert.equal(imported.migratedEvents, snapshot.eventCount);
    preflightConvertedGenerationActivation({
      repoId,
      rootDir: root,
      snapshotPath,
      databasePath: sqliteLedgerPath(root, 1),
    });
  } finally {
    await sourceLedger.drain();
  }
}
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
function submitPublished(root: string, userRoot: string, taskId: string, executionId?: string): void {
  const args = ["task", "submit", taskId, ...(executionId ? ["--execution-id", executionId] : [])];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const receipt = run(root, userRoot, args, "agent:worker");
    if (receipt.outcome === "applied") {
      const replay = run(root, userRoot, args, "agent:worker");
      assert.equal(replay.outcome, "applied", JSON.stringify(replay));
      assert.equal(replay.opId, receipt.opId, "repeated submit must return the same execution submission");
      return;
    }
    assert.equal(receipt.outcome, "pending", JSON.stringify(receipt));
    run(
      root,
      userRoot,
      ["receipt", "show", String(receipt.opId), "--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"],
      "agent:worker",
    );
  }
  assert.fail("submit did not settle after its publication receipts became visible");
}
function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = runMaybe(root, userRoot, args, actor);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
function published(root: string, userRoot: string, receipt: Record<string, unknown>): Record<string, unknown> {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, userRoot, ["receipt", "show", String(receipt.opId), ...wait]);
}
function runMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
  actor?: string,
  input?: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, actor),
    ...(input === undefined ? {} : { input }),
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
