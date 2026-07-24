// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { initializeGitRepo, runGit, runJson, withTempRoot, writeCloseout } from "./helpers/task-document-gates-fixtures.ts";

const workerEnv = { HARNESS_ACTOR: "agent:facade-worker" };

test("task start returns the reusable execution lease and stops at active", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Facade Start", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const prepared = prepareSession(rootDir, "codex-facade-start");
    const started = runJson(rootDir, ["task", "start", created.taskId], true, prepared);
    assert.equal(started.command, "task-start");
    assert.equal(started.status, "active");
    assert.match(started.executionId, /^exe_/u);
    assert.equal(started.report.executionId, started.executionId);
    assert.match(started.report.leaseToken, /^[0-9a-f]{64}$/u);
    assert.match(started.report.leaseExpiresAt, /^20/u);
    assert.deepEqual(started.report.steps.map((step: Record<string, unknown>) => step.command), ["task claim", "task transition"]);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
  });
});

test("closeout facade, explicit-wire facade, and manual chain have equivalent terminal state", () => {
  withTempRoot((manualRoot) => withTempRoot((implicitRoot) => withTempRoot((explicitRoot) => {
    const manual = executeChain(manualRoot, "manual");
    const implicit = executeChain(implicitRoot, "implicit");
    const explicit = executeChain(explicitRoot, "explicit");
    assert.deepEqual(implicit.snapshot, manual.snapshot);
    assert.deepEqual(explicit.snapshot, manual.snapshot);
    assert.equal(implicit.receipt.report.steps.length, 4);
    assert.equal(explicit.receipt.report.steps.length, 4);
    assert.equal(implicit.receipt.report.commit.length, 40);
    assert.equal(explicit.receipt.report.commit, explicit.sha);
  })));
});

test("approved closeout without consent is rejected before any lifecycle write", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Missing Consent");
    const packet = writeCloseoutPacket(rootDir, { omitConsent: true });
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");
    const executionPath = path.join(taskRoot, "executions", `${fixture.executionId}.md`);
    const executionBefore = readFileSync(executionPath, "utf8");
    const holderPath = path.join(rootDir, ".harness/task-holders", `${fixture.taskId}.json`);
    const holderBefore = readFileSync(holderPath, "utf8");

    const rejected = runJson(rootDir, ["task", "closeout", fixture.taskId, "--from-file", packet], false, fixture.env);

    assert.equal(rejected.error.code, "invalid_task_metadata");
    assert.match(rejected.error.hint, /approved closeout requires exactly one consent source/iu);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), indexBefore);
    assert.equal(readFileSync(executionPath, "utf8"), executionBefore);
    assert.equal(readFileSync(holderPath, "utf8"), holderBefore);
    const reviewsRoot = path.join(taskRoot, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  });
});

test("closeout dry-run satisfies its receipt contract without inventing execution state", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Dry Run Contract");
    const packet = writeCloseoutPacket(rootDir);
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");

    const previewed = runJson(rootDir, ["task", "closeout", fixture.taskId, "--from-file", packet, "--dry-run"], true, fixture.env);

    assert.equal(previewed.ok, true);
    assert.equal(previewed.command, "task-closeout");
    assert.equal(previewed.taskId, fixture.taskId);
    assert.equal(previewed.executionId, undefined);
    assert.equal(previewed.status, undefined);
    assert.equal(previewed.report.schema, "task-closeout-dry-run/v1");
    assert.equal(previewed.report.dryRun, true);
    assert.equal(previewed.report.preview.schema, "command-dry-run-preview/v1");
    assert.deepEqual(previewed.report.steps, ["status-set", "task-review-execution", "task-code-doc-reconcile", "task-complete"]);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), indexBefore);
  });
});

test("closeout held by another worker recommends waiting or contacting the holder, never claim", () => {
  withTempRoot((leaseRoot) => {
    const fixture = prepareActiveTask(leaseRoot, "Lost Lease");
    const packet = writeCloseoutPacket(leaseRoot);
    const rejected = runJson(leaseRoot, [
      "task", "closeout", fixture.taskId, "--from-file", packet,
      "--execution-id", fixture.executionId, "--lease-token", fixture.leaseToken
    ], false, { HARNESS_ACTOR: "agent:different-worker" });
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /not held by the caller|requires an active lease/iu);
    assert.match(rejected.error.hint, /lease status active.+otherwise wait or contact the current holder/iu);
    assert.match(rejected.error.hint, new RegExp(`Next: run .+ha task holder ${fixture.taskId}`, "u"));
    assert.doesNotMatch(rejected.error.hint, /Next: run .+ha task claim/iu);
    assert.equal(rejected.facade.completedSteps.length, 0);
  });
});

test("closeout failures retain the true gate cause, partial receipts, and one copyable next command", () => {
  withTempRoot((gateRoot) => {
    const fixture = prepareActiveTask(gateRoot, "Failed CI");
    const packet = writeCloseoutPacket(gateRoot, { ci: "failed" });
    const rejected = runJson(gateRoot, ["task", "closeout", fixture.taskId, "--from-file", packet], false, fixture.env);
    assert.match(rejected.error.code, /ci/u);
    assert.match(rejected.error.hint, /CI|ci/u);
    assert.match(rejected.error.hint, new RegExp(`Next: run .+ha task complete ${fixture.taskId} --ci passed`, "u"));
    assert.equal(rejected.facade.completedSteps.length, 3);
    assert.deepEqual(rejected.facade.completedSteps.map((step: Record<string, unknown>) => step.command), [
      "task transition", "task review execution", "task code doc reconcile"
    ]);
  });
});

test("task retire-execution rejects live and submitted rounds, then records an audited stale retirement", () => {
  withTempRoot((liveRoot) => {
    const fixture = prepareActiveTask(liveRoot, "Retirement Live Lease");
    const taskRoot = path.join(liveRoot, fixture.packagePath);
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      readFileSync(path.join(taskRoot, "INDEX.md"), "utf8").replace(/^(  status:\s*)active$/mu, "$1in_review"),
      "utf8"
    );
    const liveRejected = runJson(liveRoot, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "abandoned worker claim"
    ], false, fixture.env);
    assert.equal(liveRejected.error.code, "write_rejected");
    assert.match(liveRejected.error.hint, /claim conflicts|live lease/iu);

    runJson(liveRoot, ["task", "release", fixture.taskId], true, fixture.env);
    const retired = runJson(liveRoot, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "abandoned worker claim"
    ], true, fixture.env);
    assert.equal(retired.executionId, fixture.executionId);
    assert.equal(retired.report.auditMarker, "STALE_EXECUTION_RETIRED_AUDIT");
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${fixture.executionId}.md`), "utf8")).state, "abandoned");
    const progress = readFileSync(path.join(taskRoot, "progress.md"), "utf8");
    assert.match(progress, new RegExp(`STALE_EXECUTION_RETIRED_AUDIT: execution=${fixture.executionId}`, "u"));
    assert.match(progress, /retiredBy=person:/u);
    assert.match(progress, /retiredAt=/u);
    assert.match(progress, /reason=abandoned worker claim/u);

    const claimed = runJson(liveRoot, ["task", "claim", fixture.taskId, "--execution"], true, fixture.env);
    assert.notEqual(claimed.executionId, fixture.executionId);
    runJson(liveRoot, [
      "task", "transition", fixture.taskId, "in_review",
      "--execution-id", claimed.executionId, "--completion-claim", "Replacement round is complete.",
      "--deliverable", "replacement", "--verification", "verified", "--residual-risk", "none"
    ], true, fixture.env);
    runJson(liveRoot, [
      "task", "review-execution", fixture.taskId, "--execution-id", claimed.executionId,
      "--verdict", "approved", "--findings", "Replacement round passes.",
      "--rationale", "The replacement evidence satisfies the task.",
      "--consent-asserted", "The human approved through an external channel.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, fixture.env);
    runJson(liveRoot, [
      "task", "code-doc", "reconcile", fixture.taskId,
      "--commit", fixture.sha, "--path", "evidence/facade.txt"
    ], true, fixture.env);
    const completed = runJson(liveRoot, [
      "task", "complete", fixture.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
    ], true, fixture.env);
    assert.equal(completed.status, "done");
  });

  withTempRoot((submittedRoot) => {
    const fixture = prepareActiveTask(submittedRoot, "Retirement Submitted");
    runJson(submittedRoot, [
      "task", "transition", fixture.taskId, "in_review",
      "--execution-id", fixture.executionId,
      "--completion-claim", "submitted round", "--residual-risk", "none"
    ], true, fixture.env);
    const rejected = runJson(submittedRoot, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "must not retire submitted"
    ], false, fixture.env);
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /is submitted; only an active Execution/iu);
  });
});

test("docs contract completes with not-applicable while a CI contract rejects it", () => {
  withTempRoot((docsRoot) => {
    const fixture = prepareActiveTask(docsRoot, "Docs No CI", "docs-task");
    runJson(docsRoot, [
      "task", "transition", fixture.taskId, "in_review",
      "--execution-id", fixture.executionId, "--completion-claim", "Docs are complete.",
      "--deliverable", "documentation", "--verification", "reviewed", "--residual-risk", "none"
    ], true, fixture.env);
    runJson(docsRoot, [
      "task", "review-execution", fixture.taskId, "--execution-id", fixture.executionId,
      "--verdict", "approved", "--findings", "Documentation requirements pass.",
      "--rationale", "The reviewed docs satisfy the contract.",
      "--consent-asserted", "The human approved through an external channel.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, fixture.env);
    const completed = runJson(docsRoot, [
      "task", "complete", fixture.taskId, "--ci", "not-applicable", "--reviewer", "person_reviewer"
    ], true, fixture.env);
    assert.equal(completed.status, "done");
  });

  withTempRoot((codingRoot) => {
    const fixture = prepareActiveTask(codingRoot, "Coding CI Required");
    const packet = writeCloseoutPacket(codingRoot, { ci: "not-applicable" });
    const rejected = runJson(codingRoot, ["task", "closeout", fixture.taskId, "--from-file", packet], false, fixture.env);
    assert.equal(rejected.error.code, "ci_not_applicable_for_contract");
    assert.match(rejected.error.hint, /declares a CI obligation; not-applicable is not allowed/iu);
  });
});

type ChainMode = "manual" | "implicit" | "explicit";

function executeChain(rootDir: string, mode: ChainMode): { readonly snapshot: Record<string, unknown>; readonly receipt: Record<string, any>; readonly sha: string } {
  const fixture = prepareActiveTask(rootDir, `Equivalent ${mode}`);
  const packet = writeCloseoutPacket(rootDir);
  let receipt: Record<string, any>;
  if (mode === "manual") {
    const submitted = runJson(rootDir, [
      "task", "transition", fixture.taskId, "in_review", "--execution-id", fixture.executionId,
      "--lease-token", fixture.leaseToken, "--completion-claim", "The implementation is ready for review.",
      "--deliverable", "lifecycle facade", "--output", "integration evidence", "--verification", "targeted tests passed",
      "--residual-risk", "none observed"
    ], true, fixture.env);
    const reviewed = runJson(rootDir, [
      "task", "review-execution", fixture.taskId, "--execution-id", fixture.executionId,
      "--verdict", "approved", "--findings", "Acceptance checks passed.",
      "--rationale", "The evidence satisfies the task intent.", "--evidence-checked", "ev_cli_1",
      "--consent-asserted", "The human approved through an external channel.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, fixture.env);
    const reconciled = runJson(rootDir, [
      "task", "code-doc", "reconcile", fixture.taskId, "--commit", fixture.sha, "--path", "evidence/facade.txt"
    ], true, fixture.env);
    const completed = runJson(rootDir, ["task", "complete", fixture.taskId, "--ci", "passed", "--reviewer", "person_reviewer"], true, fixture.env);
    receipt = { report: { steps: [submitted, reviewed, reconciled, completed], commit: fixture.sha } };
  } else {
    const args = ["task", "closeout", fixture.taskId, "--from-file", packet, "--reviewer", "person_reviewer"];
    if (mode === "explicit") args.push("--execution-id", fixture.executionId, "--lease-token", fixture.leaseToken, "--commit", fixture.sha.slice(0, 10));
    receipt = runJson(rootDir, args, true, fixture.env);
  }
  return { snapshot: terminalSnapshot(rootDir, fixture.packagePath, fixture.executionId), receipt, sha: fixture.sha };
}

function prepareActiveTask(rootDir: string, title: string, preset = "standard-task"): {
  readonly taskId: string; readonly packagePath: string; readonly executionId: string; readonly leaseToken: string;
  readonly sha: string; readonly env: Record<string, string>;
} {
  const created = runJson(rootDir, ["task", "create", "--title", title, "--vertical", "software/coding", "--preset", preset]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  const env = prepareSession(rootDir, `codex-${title.toLowerCase().replaceAll(" ", "-")}`);
  const started = runJson(rootDir, ["task", "start", created.taskId], true, env);
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Implemented the task lifecycle facade.", "",
    "## Verification", "", "Targeted integration tests passed.", "",
    "## Residual Risk", "", "No residual risk observed."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/facade.txt"), "facade evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/facade.txt");
  runGit(rootDir, "commit", "-m", "seed facade evidence");
  return {
    taskId: created.taskId,
    packagePath: created.packagePath,
    executionId: String(started.executionId),
    leaseToken: String(started.report.leaseToken),
    sha: runGit(rootDir, "rev-parse", "HEAD"),
    env
  };
}

function prepareSession(rootDir: string, sessionId: string): Record<string, string> {
  const homeDir = path.join(rootDir, "home");
  mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
  writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-20T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "work the task" } }),
    JSON.stringify({ timestamp: "2026-07-20T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
  ].join("\n"), "utf8");
  return { ...workerEnv, HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };
}

function writeCloseoutPacket(rootDir: string, overrides: { readonly ci?: "passed" | "failed" | "not-applicable"; readonly omitConsent?: boolean } = {}): string {
  const packet = path.join(rootDir, `closeout-${overrides.ci ?? "passed"}.json`);
  writeFileSync(packet, JSON.stringify({
    completionClaim: "The implementation is ready for review.",
    deliverables: ["lifecycle facade"], outputs: ["integration evidence"],
    verificationNotes: ["targeted tests passed"], knownGaps: [], residualRisks: ["none observed"],
    verdict: "approved", findings: "Acceptance checks passed.",
    rationale: "The evidence satisfies the task intent.", evidenceChecked: ["ev_cli_1"],
    ...(overrides.omitConsent ? {} : {
      consentAssertedRationale: "The human approved through an external channel.",
      consentActions: ["approve_execution", "complete_task"]
    }),
    ci: overrides.ci ?? "passed", paths: ["evidence/facade.txt"], reviewerId: "person_reviewer"
  }), "utf8");
  return packet;
}

function terminalSnapshot(rootDir: string, packagePath: string, executionId: string): Record<string, unknown> {
  const taskRoot = path.join(rootDir, packagePath);
  const index = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");
  const execution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"));
  const review = JSON.parse(readFileSync(path.join(taskRoot, "reviews", readdirSync(path.join(taskRoot, "reviews"))[0]!), "utf8"));
  const consent = JSON.parse(readFileSync(path.join(taskRoot, "consents", readdirSync(path.join(taskRoot, "consents"))[0]!), "utf8"));
  const codeDoc = JSON.parse(readFileSync(path.join(taskRoot, "code-doc-anchors.json"), "utf8"));
  return {
    status: index.match(/^  status:\s*(.+)$/mu)?.[1],
    execution: { state: execution.state, submission: execution.submission, outputs: execution.outputs.map((output: Record<string, unknown>) => ({ locator: output.locator })) },
    review: { verdict: review.verdict, findings: review.findings, rationale: review.rationale, evidence_checked: review.evidence_checked, approvalKind: review.approval_basis?.kind },
    consent: { state: consent.state, actions: consent.actions },
    codeDoc: codeDoc.records.map((record: Record<string, any>) => ({
      kind: record.kind,
      anchors: record.anchors.map((anchor: Record<string, unknown>) => ({ ...anchor, sha: "<full-sha>" }))
    }))
  };
}
