// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { executionDeclaration, type ExecutionRecord } from "../../kernel/src/index.ts";
import { parseArgs } from "../src/cli/parse-args.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { normalizeReviewConsentIdentity, normalizeReviewExecutionSelection } from "../src/cli/review-execution-normalizer.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { taskSubmitFacadeSteps } from "../src/commands/core/task-submit-facade.ts";

test("task submit parses the six-field Submission packet without inventing consent or review", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-submit-facade-"));
  const packetPath = path.join(root, "submission.json");
  writeFileSync(packetPath, JSON.stringify({
    completionClaim: "The completion facade preserves the frozen gates.",
    deliverables: ["Structured submission parser"],
    outputs: ["Fast parser test passed"],
    verificationNotes: ["node --test completion-facade.test.ts"],
    knownGaps: [],
    residualRisks: ["Canonical integration remains to run"],
    codeDoc: { commit: "a".repeat(40), paths: ["packages/cli/src/index.ts"] }
  }), "utf8");

  try {
    const parsed = parseArgs(["task", "submit", "task_01KXTE6GJPW73Y1EWCA0Q0798T", "--from-file", packetPath]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.action, {
      kind: "task-submit",
      taskId: "task_01KXTE6GJPW73Y1EWCA0Q0798T",
      submission: {
        completionClaim: "The completion facade preserves the frozen gates.",
        deliverables: ["Structured submission parser"],
        outputs: ["Fast parser test passed"],
        verificationNotes: ["node --test completion-facade.test.ts"],
        knownGaps: [],
        residualRisks: ["Canonical integration remains to run"]
      },
      codeDoc: { sha: "a".repeat(40), paths: ["packages/cli/src/index.ts"], force: false },
      dryRun: false
    });
    assert.equal("consentUtterance" in parsed.value.action, false);
    assert.equal("verdict" in parsed.value.action, false);
    const manualCodeDoc = parseArgs([
      "task", "code-doc", "reconcile", "task_01KXTE6GJPW73Y1EWCA0Q0798T",
      "--commit", "a".repeat(40), "--path", "packages/cli/src/index.ts"
    ]);
    const manualSubmit = parseArgs([
      "task", "transition", "task_01KXTE6GJPW73Y1EWCA0Q0798T", "in_review",
      "--completion-claim", "The completion facade preserves the frozen gates.",
      "--deliverable", "Structured submission parser", "--output", "Fast parser test passed",
      "--verification", "node --test completion-facade.test.ts",
      "--residual-risk", "Canonical integration remains to run"
    ]);
    assert.equal(manualCodeDoc.ok, true);
    assert.equal(manualSubmit.ok, true);
    if (!manualCodeDoc.ok || !manualSubmit.ok) return;
    assert.deepEqual(
      taskSubmitFacadeSteps(parsed.value as Parameters<typeof taskSubmitFacadeSteps>[0]).map((step) => step.action),
      [manualCodeDoc.value.action, manualSubmit.value.action],
      "facade must send byte-equivalent typed actions into canonical admission"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task submit declares the accepted new-command admission budget", () => {
  const spec = commandSpecs.find((candidate) => candidate.kind === "task-submit");
  assert.ok(spec);
  assert.equal(spec.options.length <= 8, true);
  assert.deepEqual(spec.admission, {
    nounOwnership: "Task lifecycle facade; it does not introduce a new top-level noun.",
    lifecycle: "permanent",
    decisionRef: "decision/dec_01KXQM6Y74WG8XERXKQS6QKPHH",
    chain: { stepCount: 7, submissionFieldCount: 6, structuredInput: true }
  });
  assert.equal(spec.options.some((option) => option.flag === "--from-file"), true);
});

test("review execution inference fails closed and points to execution list when submitted rounds are ambiguous", async () => {
  const action: Extract<ParsedCommand["action"], { readonly kind: "task-review-execution" }> = {
    kind: "task-review-execution", taskId: "task_01KXTE6GJPW73Y1EWCA0Q0798T",
    verdict: "dismissed", findings: "Ambiguity probe", evidenceChecked: [], rationale: "Select the exact round.",
    archiveWarningsAcknowledged: false
  };
  const command: ParsedCommand = { rootDir: "/fixture", json: true, action };
  const executions = ["exe_01KXTE6GJPW73Y1EWCA0Q0798V", "exe_01KXTE6GJPW73Y1EWCA0Q0798W"].map((executionId): ExecutionRecord => ({
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${action.taskId}`, state: "submitted",
    primary_actor: { principal: { personId: "person_test" }, executor: { kind: "agent", id: "worker" }, responsibleHuman: "person_test" },
    claimed_at: "2026-07-18T00:00:00.000Z", submitted_at: "2026-07-18T00:01:00.000Z", closed_at: null,
    session_bindings: [], outputs: [], submission: { completion_claim: "ready", deliverables: [], evidence_refs: [], verification_notes: [], known_gaps: [], residual_risks: [] }
  }));
  const normalized = await normalizeReviewExecutionSelection(command, {
    readTaskPackage: () => Effect.succeed({
      taskId: action.taskId, rootPath: "/fixture/task", disposition: "active",
      documents: executions.map((execution) => ({
        path: `executions/${execution.execution_id}.md`, kind: "document" as const,
        body: executionDeclaration.documentCodec.encode(execution)
      }))
    })
  });
  assert.equal(normalized.action.kind, "task-review-execution");
  if (normalized.action.kind !== "task-review-execution") return;
  assert.equal(normalized.action.executionId, undefined);
  assert.match(normalized.action.executionSelectionError ?? "", /found 2/u);
  assert.match(normalized.action.executionSelectionError ?? "", /ha execution list --task task_01KXTE6GJPW73Y1EWCA0Q0798T/u);
});

test("review-execution from-file maps explicit review and consent fields without defaults", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-review-facade-"));
  const packetPath = path.join(root, "review.json");
  writeFileSync(packetPath, JSON.stringify({
    executionId: "exe_01KXTE6GJPW73Y1EWCA0Q0798V",
    verdict: "approved",
    findings: "Acceptance checks passed.",
    rationale: "The evidence satisfies the Task intent.",
    evidenceChecked: ["ev_cli_1"],
    archiveWarningsAcknowledged: true,
    consentAssertedRationale: "Approval was received through an external channel.",
    consentActions: ["approve_execution", "complete_task"]
  }), "utf8");

  try {
    const parsed = parseArgs(["task", "review-execution", "task_01KXTE6GJPW73Y1EWCA0Q0798T", "--from-file", packetPath]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.action, {
      kind: "task-review-execution",
      taskId: "task_01KXTE6GJPW73Y1EWCA0Q0798T",
      executionId: "exe_01KXTE6GJPW73Y1EWCA0Q0798V",
      verdict: "approved",
      findings: "Acceptance checks passed.",
      rationale: "The evidence satisfies the Task intent.",
      evidenceChecked: ["ev_cli_1"],
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"]
    });
    const normalized = normalizeReviewConsentIdentity(parsed.value);
    assert.equal(normalized.action.kind, "task-review-execution");
    if (normalized.action.kind !== "task-review-execution") return;
    assert.match(normalized.action.generatedConsentId ?? "", /^cns_[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.deepEqual(normalizeReviewConsentIdentity(normalized), normalized, "daemon normalization must reuse the wire-stable consent id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
