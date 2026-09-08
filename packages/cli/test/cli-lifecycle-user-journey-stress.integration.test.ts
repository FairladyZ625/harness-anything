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
  await expectApplied(
    fixture,
    ["task", "submit", taskId, "--from-file", path.basename(submissionPath)],
    workerEnvironment,
  );
  const review = await expectApplied(
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
    ),
    reviewDigest = String(review.reviewDigest ?? ""),
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
