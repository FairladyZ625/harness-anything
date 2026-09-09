// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  clientCount = 8,
  chainsPerClient = 3;

type Fixture = {
  readonly parent: string;
  readonly root: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly repoId: string;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

test("eight isolated CLI clients complete 24 lifecycle chains", async (context) => {
  const fixtures = Array.from({ length: clientCount }, (_, index) => setup(index));
  const startedAt = Date.now();
  try {
    for (const fixture of fixtures) await startClient(fixture);
    const outcomes = await Promise.all(fixtures.map((fixture, index) => runClient(fixture, index)));
    const chains = outcomes.flat();
    assert.equal(chains.length, clientCount * chainsPerClient);
    assert.equal(chains.filter((chain) => chain.status === "done").length, chains.length);
    assert.equal(new Set(chains.map((chain) => chain.taskId)).size, chains.length);
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-stress/v1",
        clients: clientCount,
        chains: chains.length,
        actors: outcomes.map(({ actor }) => actor),
        elapsedMs: Date.now() - startedAt,
        chainElapsedMs: chains.map(({ elapsedMs }) => elapsedMs),
      }),
    );
  } finally {
    for (const fixture of fixtures) {
      await stopClient(fixture);
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("eight CLI clients share one center while closeout facade completes each task", async (context) => {
  const fixture = setup(8),
    startedAt = Date.now();
  try {
    await startClient(fixture);
    const outcomes = await Promise.all(
      Array.from({ length: clientCount }, (_, clientIndex) =>
        runChain(fixture, clientIndex, 0, actorLabel(clientIndex), true),
      ),
    );
    assert.equal(outcomes.length, clientCount);
    assert.equal(new Set(outcomes.map(({ taskId }) => taskId)).size, clientCount);
    assert.ok(outcomes.every(({ status }) => status === "done"));
    context.diagnostic(
      JSON.stringify({
        schema: "cli-lifecycle-shared-center/v1",
        topology: "eight-clients-one-daemon-one-repo",
        clients: clientCount,
        chains: outcomes.length,
        elapsedMs: Date.now() - startedAt,
        chainElapsedMs: outcomes.map(({ elapsedMs }) => elapsedMs),
      }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI changes-requested recovery releases and re-enters a new execution", async (context) => {
  const fixture = setup(9),
    taskId = "task-cli-changes-requested",
    firstExecutionId = "execution-cli-changes-requested-1",
    secondExecutionId = "execution-cli-changes-requested-2",
    workerEnvironment = actorEnvironment(fixture, 0, "agent:recovery-worker"),
    reviewerEnvironment = actorEnvironment(fixture, 1, "agent:recovery-reviewer");
  try {
    await startClient(fixture);
    const created = await expectApplied(
        fixture,
        [
          "task",
          "create",
          "--id",
          taskId,
          "--title",
          "CLI changes requested recovery",
          "--preset",
          "docs-task",
          "--vertical",
          "software/coding",
          "--kind",
          "docs",
          "--admin",
        ],
        workerEnvironment,
      ),
      packagePath = String(created.packagePath),
      packageRoot = path.join(fixture.root, "harness", packagePath),
      closeoutPath = path.join(packageRoot, "closeout.md");
    writeFileSync(path.join(packageRoot, "task_plan.md"), realizedTaskPlan("CLI changes requested recovery"));
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\nRecovery chain.\n\n## Verification\n\nCLI recovery.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
    );
    await expectApplied(
      fixture,
      ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
      workerEnvironment,
    );
    await expectApplied(
      fixture,
      [
        "fact",
        "record",
        "--task",
        taskId,
        "--statement",
        "The CLI recovery fixture reached its first execution.",
        "--source",
        `test:cli-lifecycle-recovery/${taskId}`,
        "--confidence",
        "high",
      ],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", firstExecutionId], workerEnvironment);
    await expectApplied(
      fixture,
      ["task", "release", taskId, "--reason", "re-dispatch before the first review"],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", firstExecutionId], workerEnvironment);
    await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
    const firstSubmission = {
      completionClaim: "First execution needs another iteration.",
      deliverables: [packagePathFor(packagePath, "closeout.md")],
      outputs: ["synthetic recovery receipt"],
      verificationNotes: ["changes_requested recovery"],
      knownGaps: ["review requested another iteration"],
      residualRisks: [],
      commitSha: git(fixture.root, "rev-parse", "HEAD"),
    };
    const firstSubmissionPath = path.join(fixture.root, "recovery-first-submission.json");
    writeFileSync(firstSubmissionPath, JSON.stringify(firstSubmission));
    await expectApplied(
      fixture,
      ["task", "submit", taskId, "--execution-id", firstExecutionId, "--from-file", path.basename(firstSubmissionPath)],
      workerEnvironment,
    );
    const requested = await expectApplied(
      fixture,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        firstExecutionId,
        "--review-id",
        "review-cli-changes-requested",
        "--json-input",
        JSON.stringify({
          verdict: "changes_requested",
          reason: "The first iteration needs a clearer verification note.",
          evidenceChecked: [packagePathFor(packagePath, "closeout.md")],
        }),
      ],
      reviewerEnvironment,
    );
    assert.equal(requested.outcome, "applied");
    const afterRequest = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
      afterRequestEvidence = JSON.parse(String(afterRequest.evidence)) as {
        readonly task?: { readonly status?: string; readonly iteration?: number };
      };
    assert.equal(afterRequestEvidence.task?.status, "active");
    assert.equal(afterRequestEvidence.task?.iteration, 1);
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    const secondSubmission = {
      ...firstSubmission,
      completionClaim: "Second execution addresses the requested verification note.",
      knownGaps: [],
      commitSha: git(fixture.root, "rev-parse", "HEAD"),
    };
    const secondSubmissionPath = path.join(fixture.root, "recovery-second-submission.json");
    writeFileSync(secondSubmissionPath, JSON.stringify(secondSubmission));
    await expectApplied(
      fixture,
      [
        "task",
        "submit",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--from-file",
        path.basename(secondSubmissionPath),
      ],
      workerEnvironment,
    );
    const review = await expectApplied(
      fixture,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-cli-recovery-approved",
        "--json-input",
        JSON.stringify({
          verdict: "approved",
          reason: "The second execution includes the requested verification note.",
          evidenceChecked: [packagePathFor(packagePath, "closeout.md")],
        }),
      ],
      reviewerEnvironment,
    );
    const reviewDigest = String(review.reviewDigest ?? ""),
      contentDigest = String(review.contentDigest ?? "");
    await expectApplied(
      fixture,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-cli-recovery-approved",
        "--consent-id",
        "consent-cli-recovery-approved",
        "--json-input",
        JSON.stringify({ reviewDigest, contentDigest }),
      ],
      workerEnvironment,
    );
    await expectApplied(fixture, ["task", "complete", taskId, "--execution-id", secondExecutionId], workerEnvironment);
    const final = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
      finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
    assert.equal(finalEvidence.task?.status, "done");
    context.diagnostic(
      JSON.stringify({ schema: "cli-lifecycle-recovery/v1", taskId, firstExecutionId, secondExecutionId }),
    );
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI accepted receipt and daemon restart recover an in-flight task", async (context) => {
  const fixture = setup(10),
    taskId = "task-cli-restart-recovery",
    executionId = "execution-cli-restart-recovery",
    environment = actorEnvironment(fixture, 0, "agent:restart-worker");
  try {
    await startClient(fixture);
    const created = await expectApplied(
        fixture,
        [
          "task",
          "create",
          "--id",
          taskId,
          "--title",
          "CLI daemon restart recovery",
          "--preset",
          "docs-task",
          "--vertical",
          "software/coding",
          "--kind",
          "docs",
          "--admin",
        ],
        environment,
      ),
      opId = String(created.opId),
      receipt = await expectApplied(
        fixture,
        [
          "receipt",
          "show",
          opId,
          "--wait",
          "accepted_durable,projection_visible,git_verified,worktree_visible",
          "--timeout-ms",
          "5000",
        ],
        environment,
      );
    assert.deepEqual(receipt.wait, { state: "satisfied", unsatisfied: [] });
    assert.equal((receipt.git as { readonly state?: string }).state, "verified");
    const packagePath = String(created.packagePath),
      packageRoot = path.join(fixture.root, "harness", packagePath),
      planPath = path.join(packageRoot, "task_plan.md"),
      closeoutPath = path.join(packageRoot, "closeout.md");
    writeFileSync(planPath, realizedTaskPlan("CLI daemon restart recovery"));
    await expectApplied(
      fixture,
      ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
      environment,
    );
    await expectApplied(fixture, ["task", "start", taskId, "--execution-id", executionId], environment);
    await expectApplied(
      fixture,
      ["task", "progress", "append", taskId, "--text", "before daemon restart"],
      environment,
    );
    await stopClient(fixture);
    await startClient(fixture);
    await expectApplied(fixture, ["task", "progress", "append", taskId, "--text", "after daemon restart"], environment);
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\nRestart recovery.\n\n## Verification\n\nDaemon restarted during execution.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
    );
    await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], environment);
    const final = await expectApplied(fixture, ["task", "show", taskId], environment),
      finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
    assert.equal(finalEvidence.task?.status, "active");
    context.diagnostic(JSON.stringify({ schema: "cli-lifecycle-restart-recovery/v1", taskId, opId, executionId }));
  } finally {
    await stopClient(fixture);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

async function runClient(fixture: Fixture, clientIndex: number): Promise<ChainOutcome[] & { actor: string }> {
  const actor = actorLabel(clientIndex),
    outcomes: ChainOutcome[] = [];
  for (let chainIndex = 0; chainIndex < chainsPerClient; chainIndex += 1)
    outcomes.push(await runChain(fixture, clientIndex, chainIndex, actor));
  return Object.assign(outcomes, { actor });
}

type ChainOutcome = {
  readonly taskId: string;
  readonly status: string;
  readonly elapsedMs: number;
};

async function runChain(
  fixture: Fixture,
  clientIndex: number,
  chainIndex: number,
  actor: string,
  facade = false,
): Promise<ChainOutcome> {
  const taskId = `task-cli-stress-${clientIndex}-${chainIndex}`,
    executionId = `execution-cli-stress-${clientIndex}-${chainIndex}`,
    standard = chainIndex === 2,
    preset = standard ? "standard-task" : "docs-task",
    workerEnvironment = actorEnvironment(fixture, clientIndex, actor),
    reviewerEnvironment = actorEnvironment(fixture, clientIndex, `agent:reviewer-${clientIndex}-${chainIndex}`),
    startedAt = Date.now();
  const created = await expectApplied(
      fixture,
      [
        "task",
        "create",
        "--id",
        taskId,
        "--title",
        `CLI stress ${clientIndex}-${chainIndex}`,
        "--preset",
        preset,
        "--vertical",
        "software/coding",
        "--kind",
        standard ? "test" : "docs",
        "--admin",
      ],
      workerEnvironment,
    ),
    packagePath = String(created.packagePath),
    packageRoot = path.join(fixture.root, "harness", packagePath),
    planPath = path.join(packageRoot, "task_plan.md"),
    closeoutPath = path.join(packageRoot, "closeout.md"),
    artifactPath = path.join(packageRoot, "artifacts", "chain.txt");
  writeFileSync(planPath, realizedTaskPlan(`CLI stress ${clientIndex}-${chainIndex}`));
  writeFileSync(artifactPath, `synthetic chain ${clientIndex}-${chainIndex}\n`);
  await expectApplied(
    fixture,
    ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
    workerEnvironment,
  );
  await expectApplied(
    fixture,
    [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "A synthetic CLI lifecycle chain reached its execution lease.",
      "--source",
      `test:cli-lifecycle-stress/${taskId}`,
      "--confidence",
      "high",
    ],
    workerEnvironment,
  );
  await expectApplied(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  await expectNoop(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  const rejectedProgress = await runResult(
    fixture,
    ["task", "progress", "append", taskId, "--text", "unauthorized checkpoint"],
    reviewerEnvironment,
  );
  assert.notEqual(rejectedProgress.status, 0, rejectedProgress.stdout);
  assert.match(rejectedProgress.stdout, /progress_lease_required|actor_unauthorized|lease/u);
  await expectApplied(
    fixture,
    [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "checkpoint",
      "--evidence",
      `test:${packagePathFor(packagePath, "artifacts/chain.txt")}:synthetic chain evidence`,
    ],
    workerEnvironment,
  );
  writeFileSync(
    closeoutPath,
    "# Closeout\n\n## Summary\n\nSynthetic chain complete.\n\n" +
      "## Verification\n\nCLI stress path.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
  );
  await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
  const commitSha = git(fixture.root, "rev-parse", "HEAD"),
    submissionPath = path.join(fixture.root, `submission-${taskId}.json`),
    submission = {
      completionClaim: "Synthetic CLI lifecycle chain is complete.",
      deliverables: [packagePathFor(packagePath, "artifacts/chain.txt")],
      outputs: ["synthetic lifecycle receipt"],
      verificationNotes: ["task show reached done"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    };
  writeFileSync(submissionPath, JSON.stringify(submission));
  if (facade) {
    const closeoutPacketPath = path.join(fixture.root, `closeout-${taskId}.json`);
    writeFileSync(
      closeoutPacketPath,
      JSON.stringify({
        submission,
        review: {
          verdict: "approved",
          reason: "Independent synthetic reviewer checked the closeout packet.",
          evidenceChecked: [packagePathFor(packagePath, "artifacts/chain.txt")],
        },
        consent: { approved: true },
        completion: { ci: standard ? "passed" : "not_applicable", codeDocPaths: standard ? ["README.md"] : [] },
      }),
    );
    const closeout = await expectApplied(
      fixture,
      ["task", "closeout", taskId, "--execution-id", executionId, "--from-file", path.basename(closeoutPacketPath)],
      workerEnvironment,
    );
    assert.deepEqual(
      (closeout.steps as Array<Record<string, unknown>>).map(({ stage }) => stage),
      ["submit", "review-execution", "review-consent", "complete"],
    );
  } else {
    await expectApplied(
      fixture,
      ["task", "submit", taskId, "--from-file", path.basename(submissionPath)],
      workerEnvironment,
    );
  }
  const review = facade
    ? null
    : await expectApplied(
        fixture,
        [
          "task",
          "review-execution",
          taskId,
          "--execution-id",
          executionId,
          "--review-id",
          `review-${taskId}`,
          "--json-input",
          JSON.stringify({
            verdict: "approved",
            reason: "Independent synthetic reviewer checked the submitted execution.",
            evidenceChecked: [packagePathFor(packagePath, "artifacts/chain.txt")],
          }),
        ],
        reviewerEnvironment,
      );
  if (!facade && review) {
    const reviewDigest = String(review.reviewDigest ?? ""),
      contentDigest = String(review.contentDigest ?? "");
    assert.match(reviewDigest, /^sha256:/u, JSON.stringify(review));
    assert.match(contentDigest, /^sha256:/u, JSON.stringify(review));
    assert.equal(review.outcome, "applied");
    await expectApplied(
      fixture,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        `review-${taskId}`,
        "--consent-id",
        `consent-${taskId}`,
        "--json-input",
        JSON.stringify({
          reviewDigest,
          contentDigest,
        }),
      ],
      workerEnvironment,
    );
    if (standard) {
      await expectApplied(fixture, ["task", "code-doc", "reconcile", taskId, "--path", "README.md"], workerEnvironment);
      await expectApplied(
        fixture,
        ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed"],
        workerEnvironment,
      );
    } else await expectApplied(fixture, ["task", "complete", taskId, "--execution-id", executionId], workerEnvironment);
  }
  const final = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
    finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
  assert.equal(finalEvidence.task?.status, "done");
  return { taskId, status: finalEvidence.task?.status ?? "missing", elapsedMs: Date.now() - startedAt };
}

async function startClient(fixture: Fixture): Promise<void> {
  const started = await runResult(fixture, ["daemon", "start", "--service"], actorEnvironment(fixture, 0, null));
  if (started.status === 0) {
    await expectApplied(
      fixture,
      ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
      actorEnvironment(fixture, 0, null),
    );
    await waitForAttached(fixture);
    return;
  }
  assert.match(started.stdout, /daemon_starting/u, started.stderr);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    if (status.status === 0) {
      await expectApplied(
        fixture,
        ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
        actorEnvironment(fixture, 0, null),
      );
      await waitForAttached(fixture);
      return;
    }
    await delay(50);
  }
  throw new Error(`daemon did not become ready: ${started.stdout}`);
}

async function waitForAttached(fixture: Fixture): Promise<void> {
  let lastStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    lastStatus = status.stdout;
    const receipt = JSON.parse(status.stdout) as {
      readonly repos?: ReadonlyArray<{ readonly repoId?: string; readonly state?: string }>;
    };
    if (receipt.repos?.some((repo) => repo.repoId === fixture.repoId && repo.state === "attached")) return;
    await delay(50);
  }
  throw new Error(`repository ${fixture.repoId} did not attach: ${lastStatus}`);
}

async function stopClient(fixture: Fixture): Promise<void> {
  if (!existsSync(fixture.userRoot)) return;
  await runResult(fixture, ["daemon", "stop"], actorEnvironment(fixture, 0, null));
}

function setup(index: number): Fixture {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-cli-stress-${index}-`)),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = `cli-stress-${index}`,
    repoId = `cli-stress-repo-${index}`;
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# CLI lifecycle stress fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  const roster = [
    "schema: harness-people/v1",
    "people:",
    "  - personId: owner",
    "    displayName: Owner",
    "    primaryEmail: owner@example.test",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "",
  ].join("\n");
  writeFileSync(path.join(root, "harness/people.yaml"), roster);
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "CLI lifecycle stress");
  git(root, "config", "user.email", "cli-lifecycle-stress@example.test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ rootDir: root, repoId });
  return { parent, root, userRoot, daemonId, repoId };
}

function actorLabel(index: number): string {
  return index % 3 === 0 ? "codex-auto" : index % 3 === 1 ? "claude-auto" : "explicit-agent";
}

function actorEnvironment(fixture: Fixture, index: number, actor: string | null): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemon,
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _session,
    ...base
  } = process.env;
  const identity =
    actor === null
      ? {}
      : actor === "codex-auto"
        ? { CODEX_THREAD_ID: `codex-stress-${index}` }
        : actor === "claude-auto"
          ? { CLAUDE_CODE_SESSION_ID: `claude-stress-${index}` }
          : { HARNESS_ACTOR: actor.startsWith("agent:") ? actor : `agent:stress-${index}` };
  return {
    ...base,
    HOME: path.join(fixture.parent, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    HARNESS_DAEMON_ID: fixture.daemonId,
    ...identity,
  };
}

function packagePathFor(packagePath: string, relative: string): string {
  return path.posix.join(packagePath.replaceAll(path.sep, "/"), relative);
}

async function expectApplied(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "applied", result.stdout);
  return receipt;
}

async function expectNoop(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "no_changes", result.stdout);
  return receipt;
}

function runResult(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
      cwd: fixture.root,
      env: environment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (input !== undefined) child.stdin.end(input);
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
