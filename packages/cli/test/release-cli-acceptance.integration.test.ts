// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, sha256Bytes } from "../../kernel/src/index.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  daemonId = "release-acc-e2e";

/**
 * Release CLI black-box acceptance: every write goes through the real thin CLI against an isolated
 * daemon, with distinct authenticated principals (owner person, agent:release-worker executor,
 * agent:release-reviewer reviewer). Ledger reads only assert what the CLI already accepted.
 */

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Release Acceptance");
  git(root, "config", "user.email", "release-acceptance@example.test");
  git(root, "add", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "release acceptance fixture");
}
function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function gitBytes(root: string, ref: string): Buffer {
  return execFileSync("git", ["-C", root, "cat-file", "-p", ref], { maxBuffer: 64 * 1024 * 1024 });
}
function gitHasPath(root: string, ref: string): boolean {
  return spawnSync("git", ["-C", root, "cat-file", "-e", ref]).status === 0;
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
    HARNESS_DAEMON_ID: daemonId,
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (runMaybe(root, userRoot, ["daemon", "status"]).status === 0) return;
  }
  throw new Error(String(receipt.nextAction));
}
function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = runMaybe(root, userRoot, args, actor);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function runMaybe(
  root: string,
  userRoot: string,
  args: readonly string[],
  actor?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, actor),
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
/**
 * Offline storage commands (backup/restore/events) parse the leading token positionally, so they run
 * with the repository as cwd instead of a --root flag.
 */
function runOffline(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    env: environment(root, userRoot),
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function settle(root: string, userRoot: string, opId: string, actor?: string): Record<string, unknown> {
  return run(
    root,
    userRoot,
    ["receipt", "show", opId, "--wait", "git_verified,worktree_visible", "--timeout-ms", "20000"],
    actor,
  );
}
function writeCloseout(root: string, packagePath: string, summary: string, risk = "None for the fixture."): void {
  writeFileSync(
    path.join(root, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary}\n\n## Verification\n\nVerified through the real CLI.\n\n` +
      `## Residual Risk\n\n${risk}\n\n## Same Mechanism Elsewhere\n\nNot applicable to the release acceptance fixture.\n`,
  );
}
function docStatusRows(receipt: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const evidence = String(receipt.evidence ?? "");
  assert.ok(evidence.startsWith("doc-scan:"), `doc status must report its scan, saw ${evidence.slice(0, 120)}`);
  const scan = JSON.parse(evidence.slice("doc-scan:".length)) as {
    rows: ReadonlyArray<Record<string, unknown>>;
  };
  return scan.rows;
}

test("release acceptance: attributed lifecycle chain create→start→fact→submit→reconcile→review→consent→complete reaches done", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acc-chain-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "release-acc-chain",
    taskId = "task-release-acc-chain",
    executionId = "execution-release-acc-chain",
    worker = "agent:release-worker",
    reviewer = "agent:release-reviewer";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId });
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
      "Release Acceptance Chain",
      "--preset",
      "docs-task",
    ]);
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    const packagePath = String(created.packagePath),
      settled = settle(root, userRoot, String(created.opId));
    assert.equal((settled.git as { state: string }).state, "verified");
    assert.equal((settled.worktree as { state: string }).state, "verified");
    assert.equal((settled.acceptance as { cut: { generation: number } }).cut.generation, 2, JSON.stringify(settled));

    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan("Release Acceptance Chain"));
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The release acceptance chain fixture drives every lifecycle stage through the real CLI.",
      "--source",
      `test:${taskId}`,
    ]);
    run(root, userRoot, ["task", "start", taskId, "--execution-id", executionId], worker);
    writeCloseout(root, packagePath, "The chain fixture executed once.");
    const reportFile = path.join(root, "harness", packagePath, "artifacts", "implementation.md");
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, "# Release acceptance\n\nThe public probe is the code-doc verification target.\n");
    run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], worker);

    // A real repository deliverable, committed by the fixture, so code-doc reconcile has a true path.
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "release-acc-probe.mjs"), 'export const probe = "chain";\n');
    git(root, "add", "scripts/release-acc-probe.mjs");
    git(root, "commit", "--quiet", "-m", "release acceptance probe script");
    const commitSha = git(root, "rev-parse", "HEAD");
    writeCloseout(root, packagePath, `The chain fixture is complete at ${commitSha}.`);
    run(root, userRoot, ["task", "submit", taskId, "--execution-id", executionId], worker);
    const reconciled = run(
      root,
      userRoot,
      ["task", "code-doc", "reconcile", taskId, "--path", "scripts/release-acc-probe.mjs"],
      worker,
    );
    assert.equal(reconciled.outcome, "applied", JSON.stringify(reconciled));

    const reviewed = run(
      root,
      userRoot,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        "review-release-acc-approved",
        "--json-input",
        JSON.stringify({
          verdict: "approved",
          reason: "Independent reviewer approved the chain fixture.",
          evidenceChecked: ["scripts/release-acc-probe.mjs"],
        }),
      ],
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const reviewDigest = String(reviewed.reviewDigest ?? ""),
      contentDigest = String(reviewed.contentDigest ?? "");
    assert.match(reviewDigest, /^sha256:/u, JSON.stringify(reviewed));
    assert.match(contentDigest, /^sha256:/u, JSON.stringify(reviewed));
    run(
      root,
      userRoot,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        executionId,
        "--review-id",
        "review-release-acc-approved",
        "--consent-id",
        "consent-release-acc",
        "--json-input",
        JSON.stringify({ reviewDigest, contentDigest }),
      ],
      worker,
    );
    const completed = run(root, userRoot, ["task", "complete", taskId, "--execution-id", executionId], worker);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const shown = run(root, userRoot, ["task", "show", taskId]),
      evidence = JSON.parse(String(shown.evidence)) as {
        task: { status: string };
        codeDocWitnesses: readonly { paths?: readonly string[] }[];
      };
    assert.equal(evidence.task.status, "done");
    assert.ok(
      evidence.codeDocWitnesses.some(
        (witness) => Array.isArray(witness.paths) && witness.paths.includes("scripts/release-acc-probe.mjs"),
      ),
      `reconcile must leave a code-doc witness, saw ${JSON.stringify(evidence.codeDocWitnesses)}`,
    );

    // Actor attribution: the executor and the reviewer are distinct authenticated principals in the ledger.
    const events = reader.read().events,
      started = events.find(
        (event) => event.type === "execution_started" && event.payload.execution?.executionId === executionId,
      ),
      review = events.find((event) => event.type === "review_recorded");
    assert.ok(started, "execution_started must be in the canonical ledger");
    assert.deepEqual(started.actor, {
      executor: { kind: "agent", id: "release-worker" },
      principal: { personId: "owner" },
    });
    assert.ok(review, "review_recorded must be in the canonical ledger");
    assert.deepEqual(review.actor, {
      executor: { kind: "agent", id: "release-reviewer" },
      principal: { personId: "owner" },
    });
    context.diagnostic(JSON.stringify({ schema: "release-acceptance-chain/v1", taskId, executionId, commitSha }));
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("release acceptance: changes_requested rework keeps both same-named reports and completes on the second round", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acc-rework-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "release-acc-rework",
    taskId = "task-release-acc-rework",
    firstExecutionId = "execution-release-acc-rework-1",
    secondExecutionId = "execution-release-acc-rework-2",
    worker = "agent:release-worker",
    reviewer = "agent:release-reviewer",
    firstBody = "# Rework report\n\nFirst execution finding.\n",
    secondBody = "# Rework report\n\nSecond execution finding after the returned review.\n";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId });
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
        "Release Acceptance Rework",
        "--preset",
        "docs-task",
      ]),
      packagePath = String(created.packagePath),
      reportLogical = `${packagePath}/artifacts/reports/implementation.md`,
      reportFile = path.join(root, "harness", reportLogical);
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    settle(root, userRoot, String(created.opId));
    writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan("Release Acceptance Rework"));
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The rework fixture publishes one report basename across two returned executions.",
      "--source",
      `test:${taskId}`,
    ]);
    writeCloseout(root, packagePath, "First round.", "已知缺口：The report needs a second execution.");
    mkdirSync(path.dirname(reportFile), { recursive: true });
    run(root, userRoot, ["task", "start", taskId, "--execution-id", firstExecutionId], worker);
    writeFileSync(reportFile, firstBody);
    const firstPublication = run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], worker);
    assert.equal(
      (settle(root, userRoot, String(firstPublication.opId), worker).git as { state: string }).state,
      "verified",
    );
    const firstCommit = git(root, "rev-parse", "HEAD");
    run(root, userRoot, ["task", "submit", taskId, "--execution-id", firstExecutionId], worker);
    const firstSubmission = reader
      .read()
      .events.find(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === firstExecutionId,
      );
    assert.ok(firstSubmission?.type === "execution_submitted");
    assert.ok(
      firstSubmission.payload.execution.submission?.knownGaps.includes(
        "已知缺口：The report needs a second execution.",
      ),
    );
    const returned = run(
      root,
      userRoot,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        firstExecutionId,
        "--review-id",
        "review-release-acc-rework",
        "--json-input",
        JSON.stringify({
          verdict: "changes_requested",
          reason: "The report needs a second execution.",
          evidenceChecked: [reportLogical],
        }),
      ],
      reviewer,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const afterReturn = JSON.parse(String(run(root, userRoot, ["task", "show", taskId]).evidence)) as {
      task: { status: string; iteration: number };
    };
    assert.equal(afterReturn.task.status, "active");
    assert.equal(afterReturn.task.iteration, 1, "a returned review opens the second round");

    run(root, userRoot, ["task", "start", taskId, "--execution-id", secondExecutionId], worker);
    writeFileSync(reportFile, secondBody);
    writeCloseout(root, packagePath, "The second execution addressed the returned review.");
    const secondPublication = run(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], worker);
    assert.equal(secondPublication.status, "accepted_durable", JSON.stringify(secondPublication));
    settle(root, userRoot, String(secondPublication.opId), worker);
    assert.deepEqual(gitBytes(root, `HEAD:harness/${reportLogical}`), Buffer.from(secondBody));
    assert.deepEqual(gitBytes(root, `${firstCommit}:harness/${reportLogical}`), Buffer.from(firstBody));

    const firstEvent = reader.readEvent(String(firstPublication.opId)),
      secondEvent = reader.readEvent(String(secondPublication.opId));
    assert.equal(firstEvent?.schema, "doc-event/v1");
    assert.equal(secondEvent?.schema, "doc-event/v1");
    if (firstEvent?.schema === "doc-event/v1" && secondEvent?.schema === "doc-event/v1") {
      const firstClaim = firstEvent.payload.changes.find((change) => change.path === reportLogical)?.candidate,
        secondClaim = secondEvent.payload.changes.find((change) => change.path === reportLogical)?.candidate;
      assert.ok(firstClaim && secondClaim, "both rounds must carry content claims");
      assert.notEqual(firstClaim.sha256, secondClaim.sha256);
      assert.deepEqual(Buffer.from(reader.readContentBlob(firstClaim.sha256) ?? []), Buffer.from(firstBody));
      assert.deepEqual(Buffer.from(reader.readContentBlob(secondClaim.sha256) ?? []), Buffer.from(secondBody));
      assert.equal(firstEvent.payload.executionId, firstExecutionId);
      assert.equal(secondEvent.payload.executionId, secondExecutionId);
    }
    run(root, userRoot, ["task", "submit", taskId, "--execution-id", secondExecutionId], worker);
    const secondSubmission = reader
      .read()
      .events.find(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === secondExecutionId,
      );
    assert.ok(secondSubmission?.type === "execution_submitted");
    assert.ok(!secondSubmission.payload.execution.submission?.knownGaps.some((gap) => gap.includes("已知缺口")));
    const approved = run(
      root,
      userRoot,
      [
        "task",
        "review-execution",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-release-acc-rework-2",
        "--json-input",
        JSON.stringify({
          verdict: "approved",
          reason: "The second execution satisfied the requested changes.",
          evidenceChecked: [reportLogical],
        }),
      ],
      reviewer,
    );
    run(
      root,
      userRoot,
      [
        "task",
        "review-consent",
        taskId,
        "--execution-id",
        secondExecutionId,
        "--review-id",
        "review-release-acc-rework-2",
        "--consent-id",
        "consent-release-acc-rework",
        "--json-input",
        JSON.stringify({
          reviewDigest: String(approved.reviewDigest),
          contentDigest: String(approved.contentDigest),
        }),
      ],
      worker,
    );
    run(root, userRoot, ["task", "complete", taskId, "--execution-id", secondExecutionId], worker);
    const evidence = JSON.parse(String(run(root, userRoot, ["task", "show", taskId]).evidence)) as {
      task: { status: string };
    };
    assert.equal(evidence.task.status, "done");
    context.diagnostic(JSON.stringify({ schema: "release-acceptance-rework/v1", taskId }));
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("release acceptance: JSON, PDF and binary artifacts publish byte-exact, route around doc sync, and survive backup drills", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acc-artifacts-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "release-acc-artifacts",
    taskId = "task-release-acc-artifacts",
    executionId = "execution-release-acc-artifacts",
    worker = "agent:release-worker";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId });
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
        "Release Acceptance Artifacts",
        "--preset",
        "docs-task",
      ]),
      packagePath = String(created.packagePath);
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    settle(root, userRoot, String(created.opId));
    writeFileSync(
      path.join(root, "harness", packagePath, "task_plan.md"),
      realizedPlan("Release Acceptance Artifacts"),
    );
    run(root, userRoot, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    run(root, userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The artifact fixture publishes JSON, PDF and binary bytes through the real CLI.",
      "--source",
      `test:${taskId}`,
    ]);
    run(root, userRoot, ["task", "start", taskId, "--execution-id", executionId], worker);

    const metricsJson = Buffer.from(`${JSON.stringify({ runs: [1, 2, 3], verdict: "green" }, null, 2)}\n`),
      evidencePdf = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.from([0xff, 0xd8, 0x00, 0x1a, 0x80, 0x0d, 0x0a]),
        Buffer.from("\n%%EOF\n"),
      ]),
      traceBin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x7f]),
      cases = [
        { source: "release-metrics.json", destination: "artifacts/metrics.json", bytes: metricsJson },
        { source: "release-evidence.pdf", destination: "artifacts/evidence/evidence.pdf", bytes: evidencePdf },
        { source: "release-trace.bin", destination: "artifacts/trace.bin", bytes: traceBin },
      ];
    for (const { source, destination, bytes } of cases) {
      writeFileSync(path.join(root, source), bytes);
      const added = run(
        root,
        userRoot,
        ["task", "artifact", "add", taskId, "--source", source, "--destination", destination],
        worker,
      );
      assert.equal(added.outcome, "applied", `${destination}: ${JSON.stringify(added)}`);
      const settledAdd = settle(root, userRoot, String(added.opId), worker);
      assert.equal((settledAdd.git as { state: string }).state, "verified", `${destination}: git`);
      assert.equal((settledAdd.worktree as { state: string }).state, "verified", `${destination}: worktree`);
      const logical = String(added.destination);
      assert.equal(logical, `${packagePath}/${destination}`, "the artifact keeps its real filename");
      assert.deepEqual(readFileSync(path.join(root, "harness", ...logical.split("/"))), bytes);
      assert.deepEqual(gitBytes(root, `HEAD:harness/${logical}`), bytes);
      const event = reader.readEvent(String(added.opId));
      assert.equal(event?.schema, "doc-event/v1", `${destination}: must enter a doc event`);
      if (event?.schema === "doc-event/v1") {
        const claim = event.payload.changes.find((change) => change.path === logical)?.candidate;
        assert.ok(claim, `${destination}: content claim`);
        assert.deepEqual([claim.sha256, claim.size], [sha256Bytes(bytes), bytes.byteLength]);
        assert.deepEqual(Buffer.from(reader.readContentBlob(claim.sha256) ?? []), bytes);
        assert.equal(event.payload.executionId, executionId, `${destination}: bound to the publishing execution`);
      }
    }

    // Routing: a raw file dropped under the task artifacts tree is doc-sync inapplicable and routed to
    // task artifact add instead of being published by doc sync.
    const unroutedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      unroutedLogical = `${packagePath}/artifacts/unrouted.png`;
    writeFileSync(path.join(root, "harness", unroutedLogical), unroutedBytes);
    const status = run(root, userRoot, ["doc", "status", "--task", taskId], worker),
      rows = docStatusRows(status),
      unrouted = rows.find((row) => String(row.path) === unroutedLogical);
    context.diagnostic(`release-acc-doc-status=${JSON.stringify(rows)}`);
    assert.ok(unrouted, `doc status must see the dropped artifact, saw ${JSON.stringify(rows)}`);
    assert.equal(unrouted.state, "inapplicable");
    assert.match(String(unrouted.reason ?? ""), /ha task artifact add/u);
    const synced = runMaybe(root, userRoot, ["doc", "sync", "--submit", "--task", taskId], worker);
    assert.equal(synced.status, 0, `doc sync must not fail on an inapplicable raw artifact: ${synced.stdout}`);
    assert.equal(
      gitHasPath(root, `HEAD:harness/${unroutedLogical}`),
      false,
      "doc sync must not publish the raw artifact behind artifact add's back",
    );

    // Collision: republishing a destination with different bytes is refused; identical bytes replay.
    writeFileSync(
      path.join(root, "release-evidence-v2.pdf"),
      Buffer.concat([evidencePdf, Buffer.from("%PDF-appended")]),
    );
    const collision = runMaybe(
      root,
      userRoot,
      [
        "task",
        "artifact",
        "add",
        taskId,
        "--source",
        "release-evidence-v2.pdf",
        "--destination",
        "artifacts/evidence/evidence.pdf",
      ],
      worker,
    );
    assert.notEqual(collision.status, 0, "a different-bytes republish must be refused");
    assert.equal((JSON.parse(collision.stdout) as { code?: string }).code, "artifact_collision", collision.stdout);
    const replay = runMaybe(
      root,
      userRoot,
      [
        "task",
        "artifact",
        "add",
        taskId,
        "--source",
        "release-evidence.pdf",
        "--destination",
        "artifacts/evidence/evidence.pdf",
      ],
      worker,
    );
    assert.equal(replay.status, 0, `same-bytes republish must replay: ${replay.stdout}`);

    // Backup and drill-restore through the real offline CLI.
    const backupDir = path.join(parent, "release-backup"),
      backup = runOffline(root, userRoot, ["backup", backupDir, "--json"]);
    assert.equal(backup.ok, true, JSON.stringify(backup));
    assert.equal(backup.schema, "ledger-backup-receipt/v1");
    const manifest = backup.manifest as { files: readonly { path: string }[] },
      manifestPaths = manifest.files.map(({ path: held }) => held).join("\n");
    for (const { destination } of cases)
      assert.match(manifestPaths, new RegExp(destination.replace(/^artifacts\//u, ""), "u"));
    const drill = runOffline(root, userRoot, [
      "restore",
      "--drill",
      backupDir,
      "--shadow-parent",
      path.join(parent, "drills"),
      "--json",
    ]);
    assert.equal(drill.ok, true, JSON.stringify(drill));
    const shadowRoot = String(drill.shadowRoot);
    for (const { destination, bytes } of cases) {
      const restored = readFileSync(path.join(shadowRoot, "harness", packagePath, destination));
      assert.deepEqual(restored, bytes, `${destination}: drill restore must return the original bytes`);
    }
    context.diagnostic(JSON.stringify({ schema: "release-acceptance-artifacts/v1", taskId, backupDir, shadowRoot }));
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("release acceptance: a fresh custom Artifact kind runs its file/folder lifecycle with Git-bound publication", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-acc-entity-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "release-acc-entity",
    customKind = "release-runbook";
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId });
  const reader = makeTaskEventReader({ rootDir: root, repoId });
  try {
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]);
    // A manually initialized fixture has no vertical declaration yet; the supported CLI materializes it.
    run(root, userRoot, ["migrate", "vertical-declaration"]);
    const kindDeclaration = {
      id: customKind,
      entityType: "artifact",
      idPrefix: "RLB",
      display: { singular: "Release Runbook", plural: "Release Runbooks" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/release-runbooks/{id}.json" },
      locatorKinds: ["repository-path"],
    };
    writeFileSync(path.join(root, "release-runbook-kind.json"), JSON.stringify(kindDeclaration));
    const upserted = run(root, userRoot, [
      "vertical",
      "entity-kind",
      "upsert",
      "--from-file",
      "release-runbook-kind.json",
    ]);
    assert.ok(String(upserted.opId ?? "").length > 0, `upsert must be accepted: ${JSON.stringify(upserted)}`);
    // The write surface addresses a kind by its stable opaque ref; the read surface also accepts the id.
    const kindRef = (JSON.parse(String(upserted.evidence)) as { kindRef: string }).kindRef;
    assert.match(kindRef, /^entity-kind\/KND-[a-f0-9]{32}$/u, String(upserted.evidence));
    context.diagnostic(`release-acc-kind-upsert=${JSON.stringify(upserted)}`);

    const sourcePath = "release-acc-sources/deploy-guide",
      absoluteSource = path.join(root, sourcePath),
      readmeBytes = "# Deploy guide\n\nRelease acceptance custom-kind material.\n",
      dataBytes = Buffer.from(`${JSON.stringify({ service: "edge", replicas: 2 }, null, 2)}\n`),
      binaryBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x7f]);
    mkdirSync(path.join(absoluteSource, "blobs"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "reserved"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), readmeBytes);
    writeFileSync(path.join(absoluteSource, "data.json"), dataBytes);
    writeFileSync(path.join(absoluteSource, "blobs", "binary.bin"), binaryBytes);
    git(root, "add", sourcePath);
    git(root, "commit", "--quiet", "-m", "custom kind source");

    const imported = run(root, userRoot, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
    ]);
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.match(entityId, /^RLB-[a-f0-9]{32}$/u, entityId);
    const settledImport = settle(root, userRoot, String(imported.opId));
    assert.equal((settledImport.git as { state: string }).state, "verified");
    assert.equal((settledImport.worktree as { state: string }).state, "verified");
    const contentRoot = `entities/release-runbooks/${entityId}`,
      held = (...segments: readonly string[]) => path.join(root, "harness", contentRoot, ...segments),
      importCommit = git(root, "rev-parse", "HEAD");
    assert.equal(readFileSync(held("README.md"), "utf8"), readmeBytes);
    assert.deepEqual(readFileSync(held("data.json")), dataBytes);
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes);
    assert.ok(statSync(held("reserved")).isDirectory(), "the empty directory must come back");
    assert.deepEqual(gitBytes(root, `HEAD:harness/${contentRoot}/blobs/binary.bin`), binaryBytes);
    assert.deepEqual(gitBytes(root, `HEAD:harness/${contentRoot}/README.md`), Buffer.from(readmeBytes));

    const retry = run(root, userRoot, [
      "entity",
      "import",
      "--kind",
      kindRef,
      "--locator",
      sourcePath,
      "--expected-version",
      "0",
    ]);
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    assert.equal(retry.opId, imported.opId, "a retry resolves through the source binding");

    const listed = run(root, userRoot, ["entity", "list", customKind]),
      listEvidence = JSON.parse(String(listed.evidence)) as {
        kind: string;
        entities: ReadonlyArray<{ id: string }>;
      },
      entities = listEvidence.entities;
    assert.equal(listEvidence.kind, kindRef, "the read surface resolves the display id to the stable kind");
    assert.ok(
      entities.some(({ id }) => id === entityId),
      JSON.stringify(entities),
    );
    const got = run(root, userRoot, ["entity", "get", customKind, "--id", entityId]),
      descriptor = (JSON.parse(String(got.evidence)) as { entity: { value?: { locator?: { value?: string } } } })
        .entity;
    assert.equal(descriptor.value?.locator?.value, sourcePath, JSON.stringify(descriptor));

    // The source goes away on disk and in Git; owned content must survive from the ledger alone.
    rmSync(absoluteSource, { recursive: true, force: true });
    git(root, "add", "-A", sourcePath);
    git(root, "commit", "--quiet", "-m", "remove the imported source");
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes);
    assert.deepEqual(readFileSync(held("README.md")), Buffer.from(readmeBytes));

    const importedRevision = Number(imported.revision),
      updated = run(root, userRoot, [
        "entity",
        "update",
        kindRef,
        "--id",
        entityId,
        "--expected-version",
        String(importedRevision),
        "--title",
        "Release runbook, retitled",
      ]);
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    settle(root, userRoot, String(updated.opId));
    const descriptorFile = path.join(root, "harness", `${contentRoot}.json`);
    assert.match(readFileSync(descriptorFile, "utf8"), /Release runbook, retitled/u);

    const stale = runMaybe(root, userRoot, [
      "entity",
      "update",
      kindRef,
      "--id",
      entityId,
      "--expected-version",
      String(importedRevision),
      "--title",
      "Stale fence",
    ]);
    assert.notEqual(stale.status, 0, "a stale fence must be refused");
    assert.equal((JSON.parse(stale.stdout) as { code?: string }).code, "revision_conflict", stale.stdout);

    const deleted = run(root, userRoot, [
      "entity",
      "delete",
      kindRef,
      "--id",
      entityId,
      "--reason",
      "release acceptance retirement",
      "--expected-version",
      String(updated.revision),
    ]);
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    settle(root, userRoot, String(deleted.opId));
    assert.equal(existsSync(descriptorFile), false);
    assert.equal(existsSync(held("README.md")), false);
    assert.equal(existsSync(held("blobs", "binary.bin")), false);
    // Original historical content stays recoverable: Git history and the ledger's own objects.
    assert.deepEqual(gitBytes(root, `${importCommit}:harness/${contentRoot}/blobs/binary.bin`), binaryBytes);
    const importEvent = reader.readEvent(String(imported.opId)),
      manifest =
        importEvent?.schema === "entity-event/v1"
          ? (importEvent.payload.ownedContent as {
              bindings: readonly { path: string; contentSha256: string }[];
            })
          : null;
    assert.ok(manifest, "the import must have left its owned-content manifest");
    const binaryBinding = manifest.bindings.find(({ path: bound }) => bound === `${contentRoot}/blobs/binary.bin`);
    assert.ok(binaryBinding, JSON.stringify(manifest.bindings));
    assert.deepEqual(Buffer.from(reader.readContentBlob(binaryBinding.contentSha256) ?? []), binaryBytes);
    context.diagnostic(JSON.stringify({ schema: "release-acceptance-entity/v1", customKind, entityId }));
  } finally {
    if (existsSync(userRoot)) runMaybe(root, userRoot, ["daemon", "stop"]);
    await reader.drain();
    rmSync(parent, { recursive: true, force: true });
  }
});
