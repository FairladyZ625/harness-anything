// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { initializeGitRepo, runGit, runJson, withTempRoot, writeCloseout } from "./helpers/task-document-gates-fixtures.ts";

test("task submit facade sends the exact six-field packet through execution submit", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Structured Submit", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "codex-structured-submit";
    const homeDir = path.join(rootDir, "home");
    const sessionDir = path.join(homeDir, ".codex/sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-07-18T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "submit task" } }),
      JSON.stringify({ timestamp: "2026-07-18T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
    ].join("\n"), "utf8");
    const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
    runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
    writeCloseout(rootDir, path.basename(created.packagePath), [
      "## Summary", "", "Implemented the structured completion facade.", "",
      "## Verification", "", "node --test completion-facade-cli.test.ts passed.", "",
      "## Residual Risk", "", "Review remains an independent human judgment."
    ]);
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
    writeFileSync(path.join(rootDir, "evidence/facade.txt"), "completion facade evidence\n", "utf8");
    runGit(rootDir, "add", "evidence/facade.txt");
    runGit(rootDir, "commit", "-m", "seed completion facade evidence");
    const evidenceSha = runGit(rootDir, "rev-parse", "HEAD");
    const packetPath = path.join(rootDir, "submission.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "The structured facade preserves execution submission semantics.",
      deliverables: ["task submit facade"],
      outputs: ["integration passed"],
      verificationNotes: ["node --test completion-facade-cli.test.ts"],
      knownGaps: [],
      residualRisks: ["review remains independent"],
      codeDoc: { commit: evidenceSha, paths: ["evidence/facade.txt"] }
    }), "utf8");

    const submitted = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], true, env);
    assert.equal(submitted.command, "task-submit");
    assert.equal(submitted.report.schema, "task-submit-result/v1");
    assert.equal(submitted.report.steps.length, 2);
    assert.equal(submitted.report.steps[0].command, "task code doc reconcile");
    assert.equal(submitted.report.steps[1].command, "task transition");
    assert.equal(submitted.report.steps[1].details.data.executionId, claimed.executionId);
    assert.equal(submitted.report.steps[1].details.data.status, "in_review");
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "code-doc-anchors.json")), true);
    const execution = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "executions", `${claimed.executionId}.md`), "utf8"));
    assert.deepEqual(execution.submission, {
      completion_claim: "The structured facade preserves execution submission semantics.",
      deliverables: ["task submit facade"],
      evidence_refs: ["ev_cli_1"],
      verification_notes: ["node --test completion-facade-cli.test.ts"],
      known_gaps: [],
      residual_risks: ["review remains independent"]
    });
    assert.equal(execution.outputs[0].locator.text, "integration passed");

    const reviewPacketPath = path.join(rootDir, "review.json");
    writeFileSync(reviewPacketPath, JSON.stringify({
      verdict: "approved",
      findings: "The structured submission satisfies the acceptance checks.",
      rationale: "The evidence and verification note cover the Task intent.",
      evidenceChecked: ["ev_cli_1"],
      archiveWarningsAcknowledged: false,
      consentUtterance: "I approve this exact submitted content.",
      consentActions: ["approve_execution", "complete_task"]
    }), "utf8");
    const reviewed = runJson(rootDir, [
      "task", "review-execution", created.taskId, "--from-file", reviewPacketPath
    ], true, { HARNESS_ACTOR: "agent:reviewer" });
    assert.equal(reviewed.command, "task-review-execution");
    assert.equal(reviewed.executionId, claimed.executionId);
  });
});

test("task submit dry-run lists exact steps and a code-doc rejection stops before execution submission", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Submit Stop Point", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "codex-submit-stop-point";
    const homeDir = path.join(rootDir, "home");
    mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
    writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), JSON.stringify({
      timestamp: "2026-07-18T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "submit task" }
    }), "utf8");
    const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
    runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
    const packetPath = path.join(rootDir, "submission-invalid-anchor.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "Ready only if code-doc reconciliation succeeds.",
      deliverables: ["facade"], outputs: ["evidence"], verificationNotes: ["tests"], knownGaps: [], residualRisks: [],
      codeDoc: { commit: "f".repeat(40), paths: ["missing.txt"] }
    }), "utf8");

    const dryRun = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath, "--dry-run"], true, env);
    assert.equal(dryRun.command, "task-submit");
    assert.deepEqual(dryRun.report.steps, ["task-code-doc-reconcile", "status-set"]);
    assert.equal(dryRun.report.preview.schema, "command-dry-run-preview/v1");
    assert.equal(dryRun.report.preview.operation, "task-submit");

    const rejected = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], false, env);
    assert.equal(rejected.command, "task-code-doc-reconcile");
    assert.equal(rejected.error.code, "code_doc_reconciliation_failed");
    assert.match(rejected.error.hint, /commit|sha/u);
    const execution = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "executions", `${claimed.executionId}.md`), "utf8"));
    assert.equal(execution.state, "active");
    assert.equal(execution.submission, null);
  });
});

test("structured facade and legacy flags produce field-equivalent completion documents and receipts", () => {
  withTempRoot((manualRoot) => withTempRoot((facadeRoot) => {
    const manual = runCompletionChain(manualRoot, "flags");
    const facade = runCompletionChain(facadeRoot, "facade");
    assert.deepEqual(normalizeCompletionSnapshot(manual), normalizeCompletionSnapshot(facade));
  }));
});

test("review facade preserves the approved-consent rejection code and logical stop point", () => {
  withTempRoot((manualRoot) => withTempRoot((facadeRoot) => {
    const manual = prepareSubmitted(manualRoot, "Consent Negative Manual", "flags");
    const facade = prepareSubmitted(facadeRoot, "Consent Negative Facade", "facade");
    const manualNotReviewed = runJson(manualRoot, [
      "task", "complete", manual.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
    ], false, { HARNESS_ACTOR: "agent:commander" });
    const facadeNotReviewed = runJson(facadeRoot, [
      "task", "complete", facade.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
    ], false, { HARNESS_ACTOR: "agent:commander" });
    assert.equal(facadeNotReviewed.error.code, manualNotReviewed.error.code);
    assert.match(facadeNotReviewed.error.hint, /approved Review/u);
    const manualRejected = runJson(manualRoot, [
      "task", "review-execution", manual.taskId, "--execution-id", manual.executionId,
      "--verdict", "approved", "--findings", "Evidence is valid.",
      "--rationale", "Approval still requires explicit human consent."
    ], false, { HARNESS_ACTOR: "agent:reviewer" });
    const packetPath = path.join(facadeRoot, "review-no-consent.json");
    writeFileSync(packetPath, JSON.stringify({
      verdict: "approved", findings: "Evidence is valid.",
      rationale: "Approval still requires explicit human consent.", evidenceChecked: [],
      archiveWarningsAcknowledged: false
    }), "utf8");
    const facadeRejected = runJson(facadeRoot, [
      "task", "review-execution", facade.taskId, "--from-file", packetPath
    ], false, { HARNESS_ACTOR: "agent:reviewer" });
    assert.equal(facadeRejected.command, manualRejected.command);
    assert.equal(facadeRejected.error.code, manualRejected.error.code);
    assert.equal(normalizeDynamicText(facadeRejected.error.hint), normalizeDynamicText(manualRejected.error.hint));
    const reviewsRoot = path.join(facadeRoot, facade.packagePath, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  }));
});

test("task submit facade preserves the missing-holder rejection code and next action", () => {
  withTempRoot((manualRoot) => withTempRoot((facadeRoot) => {
    const manual = prepareActiveWithoutClaim(manualRoot);
    const facade = prepareActiveWithoutClaim(facadeRoot);
    const manualRejected = runJson(manualRoot, [
      "task", "transition", manual.taskId, "in_review", "--completion-claim", "ready"
    ], false, { HARNESS_ACTOR: "agent:worker" });
    const packetPath = path.join(facadeRoot, "submit-no-holder.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "ready", deliverables: [], outputs: [], verificationNotes: [], knownGaps: [], residualRisks: [],
      codeDoc: { commit: facade.evidenceSha, paths: ["evidence/missing-holder.txt"] }
    }), "utf8");
    const facadeRejected = runJson(facadeRoot, [
      "task", "submit", facade.taskId, "--from-file", packetPath
    ], false, { HARNESS_ACTOR: "agent:worker" });
    assert.equal(facadeRejected.command, manualRejected.command);
    assert.equal(facadeRejected.error.code, manualRejected.error.code);
    assert.equal(normalizeDynamicText(facadeRejected.error.hint), normalizeDynamicText(manualRejected.error.hint));
    assert.match(facadeRejected.error.hint, /task claim/u);
    assert.equal(facadeRejected.facade.schema, "task-submit-partial-failure/v1");
    assert.equal(facadeRejected.facade.completedSteps.length, 1);
    assert.equal(facadeRejected.facade.completedSteps[0].command, "task code doc reconcile");
    assert.equal(facadeRejected.facade.failedStep.error.code, manualRejected.error.code);
    assert.equal(existsSync(path.join(facadeRoot, facade.packagePath, "code-doc-anchors.json")), true);
  }));
});

type ChainMode = "flags" | "facade";

function prepareActiveWithoutClaim(rootDir: string): {
  readonly taskId: string; readonly packagePath: string; readonly evidenceSha: string;
} {
  const created = runJson(rootDir, ["task", "create", "--title", "Missing Holder", "--vertical", "software/coding", "--preset", "standard-task"]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  runJson(rootDir, ["task", "transition", created.taskId, "active"], true, { HARNESS_ACTOR: "agent:worker" });
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Prepared a partial-failure receipt probe.", "",
    "## Verification", "", "The code-doc step commits before the lease rejection.", "",
    "## Residual Risk", "", "The submission must remain rejected without a Holder."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/missing-holder.txt"), "partial failure evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/missing-holder.txt");
  runGit(rootDir, "commit", "-m", "seed partial failure evidence");
  return { taskId: created.taskId, packagePath: created.packagePath, evidenceSha: runGit(rootDir, "rev-parse", "HEAD") };
}

function prepareSubmitted(rootDir: string, title: string, mode: ChainMode): {
  readonly taskId: string; readonly packagePath: string; readonly executionId: string; readonly env: Record<string, string>;
  readonly submitSteps: ReadonlyArray<Record<string, unknown>>;
} {
  const created = runJson(rootDir, ["task", "create", "--title", title, "--vertical", "software/coding", "--preset", "standard-task"]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  const sessionId = "codex-completion-equivalence";
  const homeDir = path.join(rootDir, "home");
  mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
  writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), JSON.stringify({
    timestamp: "2026-07-18T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "complete task" }
  }), "utf8");
  const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
  const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
  const executionId = String(claimed.executionId);
  runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Implemented the completion facade.", "",
    "## Verification", "", "Integration passed.", "",
    "## Residual Risk", "", "Human approval remains required."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/equivalence.txt"), "equivalent evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/equivalence.txt");
  runGit(rootDir, "commit", "-m", "seed equivalent evidence");
  const sha = runGit(rootDir, "rev-parse", "HEAD");
  const submission = {
    completionClaim: "The completion chain is ready for independent review.",
    deliverables: ["structured completion facade"], outputs: ["integration evidence"],
    verificationNotes: ["completion facade integration passed"], knownGaps: ["none observed"],
    residualRisks: ["human approval remains required"]
  };
  let submitSteps: ReadonlyArray<Record<string, unknown>>;
  if (mode === "flags") {
    const codeDocReceipt = runJson(rootDir, [
      "task", "code-doc", "reconcile", created.taskId, "--commit", sha, "--path", "evidence/equivalence.txt"
    ], true, env);
    const submitReceipt = runJson(rootDir, [
      "task", "transition", created.taskId, "in_review", "--execution-id", executionId,
      "--completion-claim", submission.completionClaim, "--deliverable", submission.deliverables[0],
      "--output", submission.outputs[0], "--verification", submission.verificationNotes[0],
      "--known-gap", submission.knownGaps[0], "--residual-risk", submission.residualRisks[0]
    ], true, env);
    submitSteps = [codeDocReceipt, submitReceipt];
  } else {
    const packetPath = path.join(rootDir, "equivalent-submission.json");
    writeFileSync(packetPath, JSON.stringify({
      ...submission,
      codeDoc: { commit: sha, paths: ["evidence/equivalence.txt"] }
    }), "utf8");
    const submitReceipt = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], true, env);
    submitSteps = submitReceipt.report.steps;
  }
  return { taskId: created.taskId, packagePath: created.packagePath, executionId, env, submitSteps };
}

function runCompletionChain(rootDir: string, mode: ChainMode): Record<string, unknown> {
  const chain = prepareSubmitted(rootDir, "Completion Equivalence", mode);
  const reviewInput = {
    verdict: "approved", findings: "All acceptance checks passed.", evidenceChecked: ["ev_cli_1"],
    rationale: "The submitted evidence satisfies the Task intent.", archiveWarningsAcknowledged: false,
    consentUtterance: "I approve this exact submitted content.",
    consentActions: ["approve_execution", "complete_task"]
  };
  const reviewReceipt = mode === "flags"
    ? runJson(rootDir, [
      "task", "review-execution", chain.taskId, "--execution-id", chain.executionId,
      "--verdict", reviewInput.verdict, "--findings", reviewInput.findings,
      "--evidence-checked", reviewInput.evidenceChecked[0], "--rationale", reviewInput.rationale,
      "--consent-utterance", reviewInput.consentUtterance,
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, { HARNESS_ACTOR: "agent:reviewer" })
    : (() => {
      const packetPath = path.join(rootDir, "equivalent-review.json");
      writeFileSync(packetPath, JSON.stringify(reviewInput), "utf8");
      return runJson(rootDir, ["task", "review-execution", chain.taskId, "--from-file", packetPath], true, { HARNESS_ACTOR: "agent:reviewer" });
    })();
  const missingCiReceipt = runJson(rootDir, [
    "task", "complete", chain.taskId, "--reviewer", "person_reviewer"
  ], false, { HARNESS_ACTOR: "agent:commander" });
  assert.equal(missingCiReceipt.error.code, "missing_ci_gate");
  const completeReceipt = runJson(rootDir, [
    "task", "complete", chain.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
  ], true, { HARNESS_ACTOR: "agent:commander" });
  const taskRoot = path.join(rootDir, chain.packagePath);
  const documents: Record<string, string> = {};
  for (const relative of ["INDEX.md", `executions/${chain.executionId}.md`, "code-doc-anchors.json", "facts.md"] as const) {
    const file = path.join(taskRoot, relative);
    if (existsSync(file)) documents[relative] = readFileSync(file, "utf8");
  }
  for (const directory of ["reviews", "consents"] as const) {
    for (const name of readdirSync(path.join(taskRoot, directory))) {
      documents[`${directory}/${name}`] = readFileSync(path.join(taskRoot, directory, name), "utf8");
    }
  }
  return {
    taskId: chain.taskId,
    documents,
    receipts: [...chain.submitSteps.map(receiptStepProjection), reviewReceipt, missingCiReceipt, completeReceipt],
    registryOperations: runGit(path.join(rootDir, "harness"), "log", "--format=%s").split("\n")
      .filter((subject) => /code-doc|review|complete/u.test(subject))
  };
}

function normalizeCompletionSnapshot(snapshot: Record<string, unknown>): unknown {
  const taskId = String(snapshot.taskId);
  return JSON.parse(normalizeDynamicText(JSON.stringify(snapshot)
    .replaceAll(taskId, "<TASK_ID>")
  ));
}

function receiptStepProjection(receipt: Record<string, any>): Record<string, unknown> {
  const data = receipt.details?.data ?? receipt;
  const paths = receipt.details?.pathsByRole ?? receipt.paths ?? {};
  return {
    ok: receipt.ok,
    taskId: data.taskId,
    executionId: data.executionId,
    status: data.status,
    report: data.report,
    paths: Array.isArray(paths)
      ? Object.fromEntries(paths.map((entry: { readonly role: string; readonly path: string }) => [entry.role, entry.path]))
      : paths,
    warnings: receipt.warnings ?? []
  };
}

function normalizeDynamicText(value: string): string {
  return value
    .replace(/(?:task|exe|rev|cns|cons)_[0-9A-HJKMNP-TV-Z]+/gu, "<DYNAMIC_ID>")
    .replace(/distill_\d+_[0-9a-f]+/gu, "<DISTILL_ID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/gu, "<TIMESTAMP>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<DIGEST>")
    .replace(/[0-9a-f]{64}/gu, "<DIGEST>")
    .replace(/[0-9a-f]{40}/gu, "<COMMIT_SHA>")
    .replace(/\d{13}-[0-9a-f-]+/gu, "<WATERMARK>");
}
