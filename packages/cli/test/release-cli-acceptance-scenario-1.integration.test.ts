// harness-test-tier: integration
import test from "node:test";
import * as shared from "./release-cli-acceptance.fixture.ts";

const {
  assert,
  execFileSync,
  spawnSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  hostname,
  tmpdir,
  path,
  makeTaskEventReader,
  sha256Bytes,
  seedSettingsEvent,
  realizedPlan,
  cli,
  daemonId,
  initialize,
  git,
  gitBytes,
  gitHasPath,
  environment,
  startDaemon,
  run,
  runMaybe,
  runOffline,
  settle,
  writeCloseout,
  docStatusRows,
} = shared;

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
      ["task", "review-consent", taskId, "--execution-id", executionId, "--review-id", "review-release-acc-approved"],
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
    assert.equal(approved.outcome, "applied", JSON.stringify(approved));
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
