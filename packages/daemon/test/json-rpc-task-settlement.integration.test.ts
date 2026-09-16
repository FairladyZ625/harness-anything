// harness-test-tier: integration
import { readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { fetchCiObservations, ingestCiObservations } from "../src/ci-observation-actions.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  activateEmptyCanonicalGeneration,
  type AgentRuntimeEventV1,
  type FrozenWritePlan,
} from "../../kernel/src/index.ts";
import { WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";
import { validateWriteReceipt } from "../../kernel/test/contracts/receipt-acceptance.fixtures.ts";
import {
  canonicalRoot,
  validateDaemonDecisionList,
  validateDaemonRelationGraph,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizedDecisionBody, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell, seedSettingsEvent } from "./repo-settings.fixture.ts";
const ciBin = mkdtempSync(path.join(tmpdir(), "ha-protocol-ci-")),
  originalPath = process.env.PATH;
before(() => {
  writeFileSync(path.join(ciBin, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});
function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}
async function waitForAcceptedReceipt(
  cell: Awaited<ReturnType<typeof openProductRepoCell>>,
  accepted: { readonly opId: string; readonly acceptance?: { readonly revisionTo?: number } | null },
  binding = repoWriteBinding,
  waitFor: readonly ("accepted_durable" | "projection_visible" | "git_verified" | "worktree_visible")[] = [
    "accepted_durable",
    "projection_visible",
    "git_verified",
    "worktree_visible",
  ],
): Promise<Awaited<ReturnType<typeof cell.run>>> {
  const shown = await cell.run({ kind: "receipt-show", opId: accepted.opId, waitFor, timeoutMs: 5_000 }, binding);
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.acceptance?.revisionTo, accepted.acceptance?.revisionTo);
  return shown;
}
const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const repoWriteBinding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
// prettier-ignore

test("milestone-closeout uses the normal completion facade, review, and gates exactly once", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-completion-facade-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task-complete",
    executionId = "execution-complete",
    packagePath = "tasks/task-complete-completion-facade",
    binding = repoWriteBinding,
    ownerFromAnotherAgent = withRoleBinding({
      actor: {
        principal: actor.principal,
        executor: { kind: "agent" as const, id: "other-owner-agent" },
      },
      source: "local" as const,
    }, "repo-write");
  try {
    initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n  closeout:\n    profile: strict\n"); /* The completion facade is a strict-profile closeout gate. */ cell = await openRepoCell({ repoId: workspaceId("completion-facade"), rootDir: canonicalRoot(rootDir), ownerId: "completion-daemon" }); const store = () => makeTaskEventReader({ repoId: "completion-facade", rootDir });
    const created = await cell.run({ kind: "task-create", taskId, title: "Completion facade", presetId: "milestone-closeout" }, binding); const createdVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding)); await cell.run({ kind: "task-start", taskId, executionId }, binding);
    const activeRow = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!,
      guiActive = (await cell.read("repo.tasks.completion.read", { taskId })).completionNext, eventsBefore = store().read().events,
      dispatchesBefore = readDispatchStreamHeaders(rootDir).length;
    const shown = await cell.run({ kind: "task-show", taskId }, binding);
    assert.deepEqual(JSON.parse(shown.evidence!).completionNext, guiActive);
    assert.equal(Object.hasOwn(activeRow, "completionNext"), false);
    const activeRevision = store().read().revision, active = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: active.outcome, code: active.code, stoppedAt: active.stoppedAt, next: active.next }, { outcome: "op_rejected", code: "not_in_review", stoppedAt: "not_in_review", next: [{ action: `Fill harness/${packagePath}/closeout.md with the verified delivery, then submit execution ${executionId}.`, reason: `Execution is held by ${actor.executor!.id}.`, authority: actor.executor!.id, readCut: { revision: (active.next as { readCut: { revision: number } }[])[0]!.readCut.revision, iteration: 0, executionId } }] }); assert.equal(store().read().revision, activeRevision); assert.deepEqual((active.next as unknown[])[0], guiActive);
    const carriedActive = await cell.run({ kind: "task-complete", taskId, docChanges: [] }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual(carriedActive.next, active.next);
    assert.deepEqual(store().read().events, eventsBefore);
    assert.deepEqual((await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!.snapshot.lease, activeRow.snapshot.lease);
    assert.equal(readDispatchStreamHeaders(rootDir).length, dispatchesBefore);

    await cell.run({ kind: "task-progress-append", taskId, text: "implementation complete", evidence: [] }, binding); await cell.run({ kind: "fact-record", taskId, statement: "Completion uses canonical witnesses.", evidenceSource: "test:completion", confidence: "high", memoryClass: "semantic", memoryTags: [] }, binding);
    const closeoutPath = `${packagePath}/closeout.md`, artifactPath = `${packagePath}/artifacts/evidence.md`; writeFileSync(path.join(rootDir, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nComplete.\n\n## Verification\n\nAll checks passed.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n"); writeFileSync(path.join(rootDir, "harness", artifactPath), "# Evidence\n\nCanonical flow.\n");
    const commitSha = await writeCloseout(
      () => cell!.settlePendingMaterialization("closeout git commit"),
      rootDir,
      packagePath,
      "All required outputs are complete.",
      "All checks passed.",
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    const missingCi = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingCi.outcome, code: missingCi.code, steps: missingCi.steps }, { outcome: "op_rejected", code: "ci_missing", steps: [] }); await publishCiObservation("completion-facade", rootDir, executionId, commitSha, "run-completion-facade");
    const beforeReviewBlock = store().read().revision,
      missingReview = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: missingReview.outcome, code: missingReview.code }, { outcome: "op_rejected", code: "review_missing" });
    assert.deepEqual((missingReview.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type), ["completion_gate_verified"]);
    assert.equal(store().read().revision, beforeReviewBlock + 1);
    const reviewBinding = (id: string) => withRoleBinding({ actor: { principal: { personId: `person-${id}` }, executor: { kind: "agent" as const, id } }, source: "local" as const }, "arbiter");
    const recordReview = async (reviewId: string, verdict: "approved" | "dismissed") => { writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict, reason: `${reviewId} ${verdict}.`, evidenceChecked: ["tests"] })); const receipt = await cell!.run({ kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" }, reviewBinding(reviewId)); assert.equal(receipt.outcome, "applied", JSON.stringify(receipt)); const visible = await waitForAcceptedReceipt(cell!, receipt, binding); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); return receipt; };
    await recordReview("review-dismissed", "dismissed");
    assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/INDEX.md`), "utf8"), /ha task complete/u, "a dismissed Review must leave the execution awaiting review");
    await recordReview("review-unselected", "approved");
    await recordReview("review-complete", "approved");
    const reviewEvents = store().read().events.filter((event) => event.type === "review_recorded"); assert.deepEqual(reviewEvents.map((event) => event.payload.review.reviewId), ["review-dismissed", "review-unselected", "review-complete"]);
    const executionPath = path.join(rootDir, "harness", `${packagePath}/executions/${executionId}.md`); assert.match(readFileSync(executionPath, "utf8"), /Reviews: review-dismissed\/dismissed, review-unselected\/approved, review-complete\/approved[\s\S]*Selected review: pending/u);
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "duplicate id", evidenceChecked: ["tests"] })); const duplicateReview = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-complete", fromFile: "review.json" }, reviewBinding("duplicate-reviewer")); assert.equal(duplicateReview.outcome, "op_rejected"); assert.equal(duplicateReview.code, "invalid_transition"); assert.deepEqual(duplicateReview.diagnostic, { kind: "failure", code: "invalid_transition" });
    const missingConsent = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: missingConsent.outcome, code: missingConsent.code, steps: missingConsent.steps }, { outcome: "op_rejected", code: "consent_missing", steps: [] }); const rejectedShow = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as { task: { status: string; currentNode: string } }; assert.deepEqual({ status: rejectedShow.task.status, currentNode: rejectedShow.task.currentNode }, { status: "in_review", currentNode: "review" });
    const consented = await cell.run(
      {
        kind: "task-review-consent",
        taskId,
        executionId,
        reviewId: "review-complete",
      },
      ownerFromAnotherAgent,
    ) as unknown as Record<string, unknown>;
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    assert.equal(consented.reviewId, "review-complete");
    const consentVisible = await waitForAcceptedReceipt(cell, consented as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(consentVisible.wait?.state, "satisfied", JSON.stringify(consentVisible));
    assert.match(readFileSync(executionPath, "utf8"), /Selected review: review-complete[\s\S]*Consent: consent-[0-9a-f]+/u); assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/reviews/review-unselected.md`), "utf8"), /Consent: pending/u); assert.match(readFileSync(path.join(rootDir, "harness", `${packagePath}/reviews/review-complete.md`), "utf8"), /Consent: consent-[0-9a-f]+/u);

    const completed = await cell.run(
      { kind: "task-complete", taskId, executionId },
      ownerFromAnotherAgent,
    ) as unknown as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(completed.reviewId, "review-complete");
    assert.equal(completed.stoppedAt, undefined);
    assert.deepEqual(
      (completed.steps as { opId: string }[]).map((step) => store().readEvent(step.opId)?.type),
      ["task_completed"],
    );
    assert.deepEqual(completed.gateChecks, [
      {
        gate: "ci",
        status: "pass",
        witnessRef: (completed.gateChecks as { witnessRef: string }[])[0]!.witnessRef,
      },
      {
        gate: "code-doc-reconciliation",
        status: "pass",
        witnessRef: (completed.gateChecks as { witnessRef: string }[])[1]!.witnessRef,
      },
    ]);
    assert.deepEqual(completed.next, []);
    assert.equal(readFileSync(path.join(rootDir, "harness", closeoutPath), "utf8").includes("All checks passed"), true);
    assert.equal(readFileSync(path.join(rootDir, "harness", artifactPath), "utf8").includes("Canonical flow"), true);
    assert.equal((completed.authorizationDecision as Record<string, unknown>).policyRef, "default@5");
    assert.equal((completed.authorizationDecision as Record<string, unknown>).outcome, "allowed");
    assert.deepEqual(
      (completed.authorizationDecision as { bindingsUsed: readonly Readonly<Record<string, unknown>>[] }).bindingsUsed,
      [
        {
          predicate: "hasRoleBinding",
          satisfied: true,
          role: "repo-write",
          matched: {
            actor: { kind: "person", id: actor.principal.personId },
            role: "repo-write",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        },
      ],
    );
    const completeEvent = store().readEvent(String(completed.opId)); assert.equal(completeEvent?.type, "task_completed"); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(store().read().events.filter((event) => event.type !== "task_completed").every((event) => event.schema !== "task-event/v1" || event.payload.task.status !== "done"), true); const revision = store().read().revision, repeated = await cell.run({ kind: "task-complete", taskId, executionId }, binding); assert.equal(repeated.opId, completed.opId); assert.equal(store().read().revision, revision);
    const completedShow = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as { task: { status: string; currentNode: string } }, completedList = JSON.parse(String((await cell.run({ kind: "task-list" }, binding)).evidence)) as { rows: { taskId: string; status: string }[] }; assert.deepEqual({ status: completedShow.task.status, currentNode: completedShow.task.currentNode }, { status: "done", currentNode: "review" }); assert.equal(completedList.rows.find((row) => row.taskId === taskId)?.status, "done");
    await cell.close(); cell = undefined; const rebuilt = makeTaskProjection({ rootDir, eventStore: store() }); rebuilt.close(); rmSync(rebuilt.path, { force: true }); rebuilt.rebuild(); assert.equal(rebuilt.read(taskId).snapshot.task?.status, "done"); assert.equal(rebuilt.read(taskId).snapshot.task?.currentNode, "review"); assert.equal(rebuilt.read(taskId).snapshot.gateWitnesses.length, 1); rebuilt.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("CompleteTask response loss settles by stable receipt and never publishes a second completion", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-unknown-")), taskId = "task-unknown-complete", executionId = "execution-unknown-complete", repoId = workspaceId("complete-unknown"); let armed = false, cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); mkdirSync(path.join(rootDir, "harness"), { recursive: true }); writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n"); /* CI witnessing is opt-in per repository */ cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-one", killpoint: (point) => { if (armed && point === "before_response_write" && makeTaskEventReader({ repoId, rootDir }).read().events.some((event) => event.type === "task_completed")) { armed = false; throw new Error("response lost"); } } }); await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "Unknown complete"); const store = () => makeTaskEventReader({ repoId, rootDir }), before = store().read().revision; armed = true;
    const unknown = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding) as unknown as Record<string, unknown>; assert.deepEqual({ outcome: unknown.outcome, status: unknown.status, code: unknown.code, stoppedAt: unknown.stoppedAt }, { outcome: "applied", status: "accepted_durable", code: "publication_indeterminate", stoppedAt: "complete-settlement" }); assert.match(String((unknown.next as { command: string }[])[0]?.command), new RegExp(`receipt show ${unknown.opId}`, "u")); assert.equal(store().read().revision, before + 2); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1); assert.equal(cell.status().state, "attached"); await cell.close(); cell = undefined;
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-unknown-two" }); const settled = await cell.run({ kind: "receipt-show", opId: String(unknown.opId) }, repoWriteBinding), retried = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding); assert.equal(settled.outcome, "applied", JSON.stringify(settled)); assert.equal(retried.outcome, "applied", JSON.stringify(retried)); assert.equal(retried.opId, unknown.opId); assert.equal(store().read().revision, before + 2); assert.equal(store().read().events.filter((event) => event.type === "task_completed").length, 1);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("Fact record publishes one event, L2 row, authored facts document, and supersession history", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-invalid-fact-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("invalid-fact"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const baselineHead = makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead(), baselineRevision = baselineHead?.revision ?? 0;
    const receipt = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Observed", evidenceSource: "test", confidence: "high", memoryClass: "semantic", memoryTags: [],
      supersedes: { factRef: "fact/F-ABCDEFGH", rationale: "x".repeat(200) } }, repoWriteBinding);
    assert.deepEqual({ outcome: receipt.outcome, code: receipt.code, state: cell.status().state }, { outcome: "op_rejected", code: "task_not_found", state: "attached" });
    assert.deepEqual(makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead(), baselineHead);
    const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-fact", title: "Fact History" }, binding); assert.equal(created.outcome, "applied"); const taskVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(taskVisible.wait?.state, "satisfied", JSON.stringify(taskVisible));
    const firstAction = { kind: "fact-record", taskId: "task-fact", statement: "Canonical facts are event-backed.", evidenceSource: "test:first", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"] }, first = await cell.run(firstAction, binding) as Record<string, unknown>; assert.equal(first.outcome, "applied", JSON.stringify(first)); assert.match(String(first.path), /^facts\/F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u); assert.equal(first.status, "accepted_durable"); assert.equal(typeof first.cut, "object"); const firstVisible = await waitForAcceptedReceipt(cell, first as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(firstVisible.wait?.state, "satisfied", JSON.stringify(firstVisible)); const firstId = String(first.factId), factsPath = `facts/${firstId}.md`, factsFile = path.join(rootDir, "harness", factsPath); assert.equal(readFileSync(factsFile, "utf8").includes(`### ${firstId}`), true); const replay = await cell.run(firstAction, binding); assert.equal(replay.outcome, "applied", JSON.stringify(replay)); assert.equal(replay.status, "accepted_durable"); assert.equal(replay.opId, first.opId); assert.deepEqual(replay.acceptance, first.acceptance); const firstEvent = makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readEvent(String(first.opId)); assert.equal(firstEvent?.schema, "fact-event/v1"); if (firstEvent?.schema === "fact-event/v1") { assert.equal(firstEvent.payload.factsDocumentClaim.path, factsPath); assert.equal(firstEvent.workspaceRevision, first.revision); }
    const second = await cell.run({ kind: "fact-record", taskId: "task-fact", statement: "Canonical facts also have per-fact documents.", evidenceSource: "test:second", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], supersedes: { factRef: `fact/${firstId}`, rationale: "The stronger observation supersedes the first." } }, binding) as Record<string, unknown>; assert.equal(second.outcome, "applied", JSON.stringify(second)); const secondVisible = await waitForAcceptedReceipt(cell, second as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(secondVisible.wait?.state, "satisfied", JSON.stringify(secondVisible)); const secondId = String(second.factId), secondPath = `facts/${secondId}.md`; assert.equal(readFileSync(path.join(rootDir, "harness", secondPath), "utf8").includes(`### ${secondId}`), true); const shown = await cell.run({ kind: "fact-show", factId: firstId }, binding); assert.equal((JSON.parse(String(shown.evidence)) as { fact: { state: string } }).fact.state, "superseded_fact"); assert.equal(makeTaskEventReader({ repoId: "invalid-fact", rootDir }).readHead()?.revision, baselineRevision + 3);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("invalid Decision payload stays invalid_command and reckon records exact projected basis", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-cell"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = repoWriteBinding;
    const created = await cell.run({ kind: "task-create", taskId: "task-decision", title: "Decision evidence" }, binding); assert.equal(created.outcome, "applied"); const taskVisible = await waitForAcceptedReceipt(cell, created, binding); assert.equal(taskVisible.wait?.state, "satisfied", JSON.stringify(taskVisible));
    const beforeMissing = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()!.revision, missing = await cell.run({ kind: "decision-reckon", decisionId: "dec_MISSING", taskId: "task-decision" }, binding);
    assert.deepEqual({ outcome: missing.outcome, code: missing.code, state: cell.status().state }, { outcome: "op_rejected", code: "entity_not_found", state: "attached" }); assert.equal(makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeMissing);
    const proposal = decisionProposal("Canonical", "Should reckon use the exact basis?"), proposed = await cell.run(proposal, binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); const proposedVisible = await waitForAcceptedReceipt(cell, proposed, binding); assert.equal(proposedVisible.wait?.state, "satisfied", JSON.stringify(proposedVisible)); const decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, related = await cell.run({ kind: "relation-relate", sourceRef: `decision/${decisionId}/CH1`, targetRef: "task/task-decision", relationType: "derives", rationale: "Decision creates this task.", expectedVersion: 0 }, binding); assert.equal(related.outcome, "applied", JSON.stringify(related)); const decisionPath = `decisions/decision-${decisionId}/decision.md`, decisionFile = path.join(rootDir, "harness", decisionPath), beforeInvalid = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()!.revision;
    assert.equal((proposed as Record<string, unknown>).path, decisionPath); assert.equal(proposed.status, "accepted_durable");
    const placement = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === "task-decision")!.placement; assert.equal(placement.moduleKeys.includes("daemon"), true, JSON.stringify(placement)); assert.equal(placement.provenance.some(({ kind }) => kind === "decision-relation"), true, JSON.stringify(placement));
    const decisionBody = readFileSync(decisionFile, "utf8"); assert.match(decisionBody, /^---\nschema: decision-package\/v1[\s\S]*\nstate: proposed[\s\S]*\n---\n# Canonical\n\nUse the canonical event-backed flow for this fixture\.\n$/u); const decisionEvent = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readEvent(proposed.opId); assert.equal(decisionEvent?.schema, "decision-event/v1"); if (decisionEvent?.schema === "decision-event/v1") { assert.equal(decisionEvent.payload.decisionDocumentClaim.path, decisionPath); assert.equal(decisionEvent.payload.decisionDocumentClaim.sha256, String((proposed as Record<string, unknown>).documentSha256)); }
    const invalid = await cell.run({ kind: "decision-accept", decisionId, rationale: "x".repeat(200) }, withRoleBinding({ actor: { principal: { personId: "person-arbiter" }, executor: null }, source: "local" }, "arbiter"));
    assert.deepEqual({ outcome: invalid.outcome, code: invalid.code, state: cell.status().state }, { outcome: "op_rejected", code: "invalid_command", state: "attached" }); assert.equal(makeTaskEventReader({ repoId: "decision-cell", rootDir }).readHead()?.revision, beforeInvalid);
    const reckon = await cell.run({ kind: "decision-reckon", decisionId, taskId: "task-decision" }, binding); assert.equal(reckon.outcome, "applied", JSON.stringify(reckon)); const fact = JSON.parse(reckon.evidence) as { evidenceSource: string; statement: string; workspaceRevision: number };
    assert.equal(fact.evidenceSource, `decision/${decisionId}@${beforeInvalid}`); assert.match(fact.statement, new RegExp(`basisRevision ${beforeInvalid}`, "u")); assert.equal(fact.workspaceRevision, beforeInvalid + 1);
    const stable = await cell.run({ kind: "receipt-show", opId: proposed.opId }, binding) as Record<string, unknown>; assert.deepEqual({ consentId: stable.consentId, path: stable.path, cut: stable.cut, documentSha256: stable.documentSha256 }, { consentId: (proposed as Record<string, unknown>).consentId, path: (proposed as Record<string, unknown>).path, cut: (proposed as Record<string, unknown>).cut, documentSha256: (proposed as Record<string, unknown>).documentSha256 }); assert.equal((stable.git as { state: string }).state, "verified"); assert.equal((stable.worktree as { state: string }).state, "verified");
    const event = makeTaskEventReader({ repoId: "decision-cell", rootDir }).readEvent(reckon.opId); assert.equal(event?.schema, "fact-event/v1"); if (event?.schema === "fact-event/v1") assert.equal(event.payload.evidenceSource, fact.evidenceSource);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("Decision proposal packet defaults optional fields, checks boundaries before reads, and leaves the Task INDEX untouched", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-packet-")), outside = `${rootDir}-outside.json`; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-packet"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const binding = repoWriteBinding, created = await cell.run({ kind: "task-create", taskId: "task-related", title: "Related Task" }, binding) as Record<string, unknown>, createdVisible = await waitForAcceptedReceipt(cell, created as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible)); const index = path.join(rootDir, "harness", String(created.packagePath), "INDEX.md"), indexBefore = readFileSync(index); const packet = { title: "Atomic proposal", question: "Can one event publish the whole proposal?", riskTier: "medium", urgency: "high", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Publish once" }], rejected: [{ id: "RJ1", text: "Patch later", whyNot: "It exposes partial state" }], claims: [{ id: "C1", text: "The packet is atomic.", loadBearing: true }], fulfillments: [{ claimId: "C1", mode: "delivered" }] }, minimalPacket = (({ vertical: _vertical, preset: _preset, appliesTo: _appliesTo, fulfillments: _fulfillments, ...minimal }) => minimal)(packet), before = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()!.revision;
    // Unknown fields and missing substantive fields remain rejected.
    for (const { action, code, field } of [
      { action: { kind: "decision-propose", jsonInput: JSON.stringify({ ...packet, unknown: true }) }, code: "invalid_command", field: undefined },
      { action: { kind: "decision-propose", jsonInput: JSON.stringify({ title: packet.title }) }, code: "missing_field", field: "question" },
      { action: { kind: "decision-propose", jsonInput: JSON.stringify(packet), body: "inline", bodyFile: "body.md" }, code: "invalid_command", field: undefined },
    ] as const) {
      const rejected = await cell.run(action, binding);
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, code);
      if (field !== undefined) {
        assert.equal((rejected.diagnostic as { readonly field?: string } | undefined)?.field, field);
      }
      assert.equal(makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()?.revision, before);
    }
    const defaulted = await cell.run({ kind: "decision-propose", jsonInput: JSON.stringify(minimalPacket) }, binding) as Record<string, unknown>;
    assert.equal(defaulted.outcome, "applied", JSON.stringify(defaulted));
    assert.deepEqual(JSON.parse(String(defaulted.evidence)).defaultedFields, ["vertical", "preset", "appliesTo", "fulfillments", "relations"]);
    const defaultedEvent = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readEvent(String(defaulted.opId));
    if (defaultedEvent?.schema === "decision-event/v1" && defaultedEvent.type === "decision_proposed") {
      assert.equal(defaultedEvent.payload.vertical, "software/coding"); assert.equal(defaultedEvent.payload.preset, "decision-conformance"); assert.deepEqual(defaultedEvent.payload.appliesTo, { modules: [], productLines: [] }); assert.deepEqual(defaultedEvent.payload.fulfillments, []); assert.deepEqual(defaultedEvent.payload.relations, []);
    } else assert.fail("defaulted decision proposal event was not recorded");
    const afterDefault = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()!.revision;
    const badJson = await cell.run({ kind: "decision-propose", jsonInput: "{" }, binding); assert.equal(badJson.code, "invalid_command"); assert.deepEqual(badJson.diagnostic, { kind: "failure", code: "invalid_command" });
    writeFileSync(path.join(rootDir, "proposal.json"), JSON.stringify(minimalPacket)); const outsidePacket = await cell.run({ kind: "decision-propose", fromFile: outside }, binding); assert.equal(outsidePacket.code, "invalid_command"); assert.deepEqual(outsidePacket.diagnostic, { kind: "workspace-boundary", field: "fromFile", workspaceRoot: realpathSync(rootDir) });
    writeFileSync(path.join(rootDir, "bad.md"), Buffer.from([0xff])); const invalidUtf8 = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "bad.md" }, binding); assert.equal(invalidUtf8.code, "invalid_command"); assert.equal(makeTaskEventReader({ repoId: "decision-packet", rootDir }).readHead()?.revision, afterDefault);
    const prose = `${realizedDecisionBody("Atomic proposal")}\n初始正文。\n`; writeFileSync(path.join(rootDir, "body.md"), prose); const proposed = await cell.run({ kind: "decision-propose", fromFile: "proposal.json", bodyFile: "body.md" }, binding) as Record<string, unknown>; assert.equal(proposed.outcome, "applied", JSON.stringify(proposed)); assert.equal(proposed.revision, afterDefault + 1); const event = makeTaskEventReader({ repoId: "decision-packet", rootDir }).readEvent(String(proposed.opId)); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_proposed") { assert.deepEqual(event.payload.claims, packet.claims); assert.deepEqual(event.payload.fulfillments, []); assert.deepEqual(event.payload.relations, []); assert.equal(event.payload.body, prose); }
    const settled = await waitForAcceptedReceipt(cell, proposed as { opId: string; acceptance?: { revisionTo?: number } | null }, binding); assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled)); const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId, document = readFileSync(path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`), "utf8"), projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventReader({ repoId: "decision-packet", rootDir }) }), projected = projection.readDecision(decisionId).decision; assert.equal(document.endsWith(`---\n${prose}`), true); assert.deepEqual(projected?.claims, [{ ...packet.claims[0], fulfillment: null }]); assert.deepEqual(readFileSync(index), indexBefore); projection.close(); await cell.close(); cell = undefined;
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});
// prettier-ignore

test("Decision judgment keeps the transport arbiter gate and returns the embedded consent identity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-decision-consent-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("decision-consent"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" }); const human = { principal: { personId: "person-ceo" }, executor: null } as const, binding = withRoleBinding({ actor: human, source: "local" as const, authorizationBindingMode: "declared" as const }, "repo-write"), proposed = await cell.run(decisionProposal("Consent", "May the CEO judge this proposal?"), binding), decisionId = (JSON.parse(proposed.evidence) as { decisionId: string }).decisionId, before = makeTaskEventReader({ repoId: "decision-consent", rootDir }).readHead()!.revision;
    const denied = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, binding); assert.deepEqual({ outcome: denied.outcome, code: denied.code }, { outcome: "op_rejected", code: "authorization_denied" }); assert.equal(makeTaskEventReader({ repoId: "decision-consent", rootDir }).readHead()?.revision, before);
    const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "CEO approval", judgmentOnlyRationale: "Explicit CEO judgment." }, withRoleBinding(binding, "arbiter")); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted)); assert.match(String((accepted as Record<string, unknown>).consentId), /^djc_[0-9a-f]{26}$/u); const event = makeTaskEventReader({ repoId: "decision-consent", rootDir }).readEvent(accepted.opId); assert.equal(event?.schema, "decision-event/v1"); if (event?.schema === "decision-event/v1" && event.type === "decision_accepted") assert.equal(event.payload.judgmentConsent.consentId, (accepted as Record<string, unknown>).consentId);
    assert.equal(accepted.authorizationDecision?.policyRef, "default@5");
    assert.equal(accepted.authorizationDecision?.outcome, "allowed");
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
// prettier-ignore

test("Decision full vertical golden rebuilds proposal, prose, claim, relation, consent, list, and show", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-vertical-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { initRepo(rootDir); mkdirSync(path.join(rootDir, "packages/daemon"), { recursive: true }); writeFileSync(path.join(rootDir, "packages/daemon/index.ts"), "export const daemon = true;\n"); git(rootDir, "add", "."); git(rootDir, "commit", "--quiet", "-m", "add daemon scope"); cell = await openRepoCell({ repoId: workspaceId("decision-vertical"), rootDir: canonicalRoot(rootDir), ownerId: "decision-vertical" }); const binding = repoWriteBinding, proposal = await cell.run(decisionProposal("Vertical Decision", "Does the full Decision flow rebuild?"), binding), proposalVisible = await waitForAcceptedReceipt(cell, proposal, binding); assert.equal(proposalVisible.wait?.state, "satisfied", JSON.stringify(proposalVisible)); const decisionId = (JSON.parse(String(proposal.evidence)) as { decisionId: string }).decisionId, logical = `decisions/decision-${decisionId}/decision.md`, target = path.join(rootDir, "harness", logical), canonical = readFileSync(target, "utf8"), split = canonical.indexOf("\n---\n", 4) + 5, prose = `${realizedDecisionBody("Vertical Decision")}\nCanonical body from doc-sync.\n`; writeFileSync(target, `${canonical.slice(0, split)}${prose}`);
    const synced = await cell.run({ kind: "doc-submit", paths: [logical] }, binding); assert.equal(synced.outcome, "applied", JSON.stringify(synced)); assert.equal((await cell.run({ kind: "decision-claim-add", decisionId, claimId: "C1", text: "The vertical flow is event-derived.", loadBearing: true }, binding)).outcome, "applied"); assert.equal((await cell.run({ kind: "relation-relate", sourceRef: `decision/${decisionId}/C1`, relationType: "supports", targetRef: `decision/${decisionId}/CH1`, rationale: "The chosen option demonstrates the claim.", expectedVersion: 0 }, binding)).outcome, "applied"); const accepted = await cell.run({ kind: "decision-accept", decisionId, rationale: "Evidence relation reviewed.", judgmentOnlyRationale: null }, withRoleBinding({ actor: { principal: { personId: "person-ceo" }, executor: null }, source: "local" }, "arbiter")); assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const invalidList = await cell.run({ kind: "decision-list", legacyRange: { start: 10, end: 2 }, authoredFallback: true }, binding); assert.equal(invalidList.code, "invalid_command"); const listed = JSON.parse(String((await cell.run({ kind: "decision-list", search: "Canonical body" }, binding)).evidence)) as { decisions: readonly Record<string, unknown>[] }, shown = JSON.parse(String((await cell.run({ kind: "decision-show", decisionId, includeBody: true }, binding)).evidence)) as { decision: { state: string; body: { body: string }; claims: readonly unknown[]; judgmentConsents: readonly unknown[] } }; assert.deepEqual(listed.decisions.map(({ decisionId: id }) => id), [decisionId]); const pagedList = JSON.parse(String((await cell.run({ kind: "decision-list", limit: 1 }, binding)).evidence)) as { decisions: readonly { decisionId: string }[]; page?: { limit: number; cursor: string | null; nextCursor: string | null } }; assert.deepEqual(pagedList.decisions.map(({ decisionId: id }) => id), [decisionId]); assert.deepEqual(pagedList.page, { limit: 1, cursor: null, nextCursor: null }); assert.equal(Object.hasOwn(listed.decisions[0]!, "body"), false); assert.deepEqual({ state: shown.decision.state, body: shown.decision.body.body, claims: shown.decision.claims.length, consents: shown.decision.judgmentConsents.length }, { state: "in_effect", body: prose, claims: 1, consents: 1 }); const gui = await cell.read("repo.decisions.list"), graph = await cell.read("repo.triadic.relationGraph", { limit: 500 }); assert.deepEqual(gui.decisions.map(({ decisionId: id }) => id), listed.decisions.map(({ decisionId: id }) => id)); assert.equal(gui.decisions[0]?.readiness?.conflictMarker.state, "clear"); assert.deepEqual(gui.decisions[0]?.capabilities.filter(({ available }) => available).map(({ id }) => id), ["supersede", "retire"]); assert.equal(gui.decisions[0]?.claimsOpen, true); assert.deepEqual(validateDaemonDecisionList(gui), []); const support = graph.edges.find((edge) => edge.sourceRef === `decision/${decisionId}/C1` && edge.targetRef === `decision/${decisionId}/CH1`); assert.deepEqual({ state: support?.state, freshness: support?.freshness, strength: support?.strength, current: support?.current }, { state: "active", freshness: "suspect", strength: "strong", current: false }); process.stdout.write(`[RELATION-CURRENT-DIVERGENCE] state=${support?.state} freshness=${support?.freshness} strength=${support?.strength} current=${support?.current}\n`); assert.deepEqual(validateDaemonRelationGraph(graph), []); // the read carries the kernel's uncovered-cause classification on every uncovered row
    // (here: claim C1 declares no fulfillment mode), so consumers never re-derive the judgment;
    assert.deepEqual(graph.coverageRows.map((row) => ({ claimRef: row.claimRef, status: row.status, covered: row.covered, freshnessReason: row.freshnessReason })), [{ claimRef: `decision/${decisionId}/C1`, status: "uncovered", covered: false, freshnessReason: "fulfillment-undeclared" }]); // #1542: event-backed truth already answers this read (all three projections are ready),
    // so an unmaterialized generated cache is not a gap in what was served and must not
    // leak through as a permanent hard-fail warning on an otherwise fully-answered read.
    assert.deepEqual(graph.warnings, []);
    const store = makeTaskEventReader({ repoId: "decision-vertical", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }), before = { decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }; projection.close(); rmSync(projection.path); projection.rebuild(); assert.deepEqual({ decision: projection.readDecision(decisionId).decision, document: projection.readDocument(logical).document, graph: projection.readDecisionGraph() }, before); projection.close();
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
for (const killpoint of ["before_event_write", "after_event_write"] as const) {
  test(`RepoCell rolls back event and outcome together at ${killpoint}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-preaccept-crash-")),
      repoId = workspaceId("preaccept-crash"),
      action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
        first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.outcome, "op_rejected", JSON.stringify(first));
      assert.equal(first.status, "rejected");
      assert.equal(first.acceptance, null);
      assertValidWriteReceipt(first);
      const rolledBack = makeTaskEventReader({ repoId, rootDir });
      assert.equal(rolledBack.read().revision, baselineRevision);
      assert.equal(rolledBack.readCommandOutcome(first.opId), null);
      await rolledBack.drain();

      await crashed.close();
      crashed = undefined;
      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-two",
      });
      const missing = await recovered.run({ kind: "receipt-show", opId: first.opId }, repoWriteBinding);
      assert.equal(missing.status, "rejected");
      assert.equal(missing.acceptance, null);
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      assertValidWriteReceipt(retried);
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.opId === first.opId).length, 1);
      assert.equal(reader.readCommandOutcome(first.opId)?.status, "accepted_durable");
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
for (const killpoint of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell records durable acceptance before the ${killpoint} failure`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-postaccept-crash-")),
      repoId = workspaceId("postaccept-crash"),
      action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
        first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.status, "accepted_durable", JSON.stringify(first));
      assert.equal(first.acceptance?.revisionFrom, baselineRevision + 1);
      assert.equal(first.acceptance?.revisionTo, baselineRevision + 1);
      assertValidWriteReceipt(first);
      const committed = makeTaskEventReader({ repoId, rootDir });
      assert.equal(committed.read().revision, baselineRevision + 1);
      assert.equal(committed.readCommandOutcome(first.opId)?.status, "accepted_durable");
      await committed.drain();

      await crashed.close();
      crashed = undefined;
      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "generation-two",
      });
      const settled = await recovered.run(
        {
          kind: "receipt-show",
          opId: first.opId,
          waitFor: ["accepted_durable", "projection_visible", "git_verified"],
          timeoutMs: 5_000,
        },
        repoWriteBinding,
      );
      assert.equal(settled.outcome, "applied", JSON.stringify(settled));
      assert.equal(settled.wait?.state, "satisfied");
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.opId === first.opId).length, 1);
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
test("a post-accept Git failure leaves SQLite writable and the receipt independently recoverable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-git-follower-failure-")),
    repoId = workspaceId("git-follower-failure");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    failGit = true;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "git-follower-writer",
      killpoint: (point) => {
        if (failGit && point === "after_git_commit") throw new Error("simulated Git follower failure");
      },
    });
    const first = await cell.run(
      { kind: "task-create", taskId: "task-git-follower-one", title: "Accepted before Git" },
      repoWriteBinding,
    );
    assert.equal(first.status, "accepted_durable", JSON.stringify(first));
    assertValidWriteReceipt(first);
    const pending = await cell.run(
      { kind: "receipt-show", opId: first.opId, waitFor: ["git_verified"], timeoutMs: 0 },
      repoWriteBinding,
    );
    assert.equal(pending.status, "accepted_durable");
    assert.equal(pending.git.state, "pending");
    assert.deepEqual(pending.wait, { state: "timed_out", unsatisfied: ["git_verified"] });

    const second = await cell.run(
      { kind: "task-create", taskId: "task-git-follower-two", title: "Accepted while Git is pending" },
      repoWriteBinding,
    );
    assert.equal(second.status, "accepted_durable", JSON.stringify(second));
    assert.notEqual(second.outcome, "op_rejected");

    failGit = false;
    await cell.settlePendingMaterialization("recover Git follower");
    const settled = await cell.run(
      {
        kind: "receipt-show",
        opId: first.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified"],
        timeoutMs: 5_000,
      },
      repoWriteBinding,
    );
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(settled.git.state, "verified");
    assert.equal(settled.worktree.state, "verified");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
for (const killpoint of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  // harness-contract: daemon.recovery-publishes-once
  test(`Decision response recovery handles ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-response-crash-")),
      repoId = workspaceId("decision-response-crash"),
      action = decisionProposal("Recover Decision", "Does the receipt settle once?");
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
      recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir);
      crashed = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "decision-generation-one",
        killpoint: (point) => {
          if (point === killpoint) throw new Error(`crash:${point}`);
        },
      });
      const first = await crashed.run(action, repoWriteBinding);
      assert.equal(first.status, "accepted_durable", JSON.stringify(first));
      assert.equal(first.outcome, first.projection.state === "verified" ? "applied" : "pending");
      assert.equal(first.code, "publication_indeterminate");
      assert.equal(first.rejectionExplanation, undefined);
      assertValidWriteReceipt(first);
      const acceptedReader = makeTaskEventReader({ repoId, rootDir }),
        acceptedEvents = acceptedReader.read().events.filter((event) => event.schema === "decision-event/v1");
      assert.equal(acceptedEvents.length, 1);
      const acceptedOpId = acceptedEvents[0]!.opId;
      assert.equal(first.opId, acceptedOpId);
      assert.deepEqual(first.acceptance?.memberOpIds, [acceptedOpId]);
      assert.equal(acceptedReader.readCommandOutcome(acceptedOpId)?.status, "accepted_durable");
      await acceptedReader.drain();
      await crashed.close();
      crashed = undefined;

      recovered = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "decision-generation-two",
      });
      const settled = await recovered.run(
        {
          kind: "receipt-show",
          opId: acceptedOpId,
          waitFor: ["accepted_durable", "projection_visible", "git_verified"],
          timeoutMs: 5_000,
        },
        repoWriteBinding,
      );
      assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
      const retried = await recovered.run(action, repoWriteBinding);
      assert.equal(retried.status, "accepted_durable", JSON.stringify(retried));
      assert.equal(retried.outcome, "applied");
      assert.equal(retried.opId, acceptedOpId);
      assert.deepEqual(retried.acceptance, first.acceptance);
      const reader = makeTaskEventReader({ repoId, rootDir });
      assert.equal(reader.read().events.filter((event) => event.schema === "decision-event/v1").length, 1);
      await reader.drain();
    } finally {
      await crashed?.close();
      await recovered?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
// prettier-ignore

test("Policy rejects a principal without a durable-action RoleBinding", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-surfaces-")), root = path.join(parent, "repo"), second = path.join(parent, "second"), userRoot = path.join(parent, "user");
  const ids = { reader: 4101, writer: 4102, arbiter: 4103, admin: 4104 }; [root, second].forEach((repo) => rbacRepo(repo, ids)); const authority = openPersistentWriterEpoch({ stateRoot: path.join(userRoot, "fleet"), holderId: "rbac-seed" }), lease = authority.acquire("rbac"); seedSettingsEvent({ repoId: "rbac", rootDir: root, writerEpochFence: { schema: "harness-writer-epoch-fence/v1", stateRoot: path.join(userRoot, "fleet"), repoId: "rbac", holderId: lease.holderId, epoch: lease.epoch } }); authority.close();
  const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const host = await openDaemonHost({ daemonId: "rbac", userRoot });
  try {
    assert.equal((await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: root, repoId: "rbac" })).outcome, "applied");
    const created = await host.run("rbac", { kind: "task-create", taskId: "task-rbac", title: "RBAC" }, auth(ids.writer)); assert.equal(created.outcome, "applied", JSON.stringify(created)); const visible = await host.run("rbac", { kind: "receipt-show", opId: created.opId, waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"], timeoutMs: 5_000 }, auth(ids.writer)); assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible)); assert.equal(visible.status, "accepted_durable"); await realizeTaskPlanFixture(root, String((created as Record<string, unknown>).packagePath), (planPath) => host.run("rbac", { kind: "doc-submit", paths: [planPath] }, auth(ids.writer)));
    const executionId = "exec-rbac"; assert.equal((await host.run("rbac", { kind: "task-start", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    assert.equal((await host.run("rbac", { kind: "task-show", taskId: "task-rbac" }, auth(ids.reader))).outcome, "applied");
    const deniedWrite = await host.run("rbac", { kind: "task-create", taskId: "task-denied", title: "Denied" }, auth(ids.reader));
    assert.equal(deniedWrite.outcome, "op_rejected"); assert.equal(deniedWrite.code, "authorization_denied");
    const deniedPresetRun = await host.presetRun("rbac", { kind: "preset-run-start", presetId: "missing", entrypoint: "run", idempotencyKey: "denied" }, auth(ids.reader)), readableStatus = await host.presetRun("rbac", { kind: "preset-run-status", runId: "run_missing" }, auth(ids.reader)); assert.equal(deniedPresetRun.code, "authorization_denied"); assert.equal(readableStatus.code, "run_not_found");
    const missingStatus = await host.run("rbac", { kind: "doc-status", paths: ["context/notes.md"] }, auth(ids.reader)); assert.equal(missingStatus.outcome, "op_rejected"); assert.equal(missingStatus.code, "document_not_found");
    mkdirSync(path.join(root, "harness/context"), { recursive: true }); writeFileSync(path.join(root, "harness/context/notes.md"), "# Reader denied\n");
    const readerDoc = await host.run("rbac", { kind: "doc-submit", executionId, paths: ["context/notes.md"] }, auth(ids.reader));
    assert.equal(readerDoc.code, "authorization_denied"); assert.equal(readerDoc.authorizationDecision.outcome, "denied");
    const deniedReview = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac" }, auth(ids.reader));
    assert.equal(deniedReview.outcome, "op_rejected"); assert.equal(deniedReview.code, "authorization_denied");
    const deniedAdmin = await rpc(host, auth(ids.reader), "daemon.repo.register", { rootDir: second, repoId: "second" });
    assert.equal(deniedAdmin.outcome, "op_rejected"); assert.equal(deniedAdmin.code, "authorization_denied");
    await writeCloseout(
      () => host.run("rbac", { kind: "doc-materialize", paths: [], all: true }, auth(ids.writer)),
      root,
      String((created as Record<string, unknown>).packagePath),
      "Role-bound delivery complete.",
    );
    assert.equal((await host.run("rbac", { kind: "task-submit", taskId: "task-rbac", executionId }, auth(ids.writer))).outcome, "applied");
    writeFileSync(path.join(root, "review.json"), JSON.stringify({ verdict: "approved", reason: "checked", evidenceChecked: [] }));
    const review = await host.run("rbac", { kind: "task-review-execution", taskId: "task-rbac", executionId, reviewId: "review-rbac", fromFile: "review.json" }, auth(ids.arbiter)); assert.equal(review.outcome, "applied", JSON.stringify(review));
    const attached = await rpc(host, auth(ids.admin), "daemon.repo.register", { rootDir: second, repoId: "second", mode: "remote-edge" }); assert.equal(attached.outcome, "applied"); assert.equal((attached.repo as Record<string, unknown>).mode, "remote-edge");
    const deniedEdgePreset = await rpc(host, auth(ids.writer), "repo.preset.run.start", { repo: { repoId: "second" }, payload: { presetId: "standard-task", entrypoint: "run", idempotencyKey: "edge-preset" } }); assert.equal(deniedEdgePreset.outcome, "op_rejected"); assert.equal(deniedEdgePreset.code, "repo_mode_read_only");
    const deniedUnbind = await rpc(host, auth(ids.reader), "daemon.repo.unbind", { repoId: "second" }); assert.equal(deniedUnbind.outcome, "op_rejected"); assert.equal(deniedUnbind.code, "authorization_denied"); const deniedPurge = await rpc(host, auth(ids.reader), "daemon.repo.purge", { repoId: "second", scope: "cache" }); assert.equal(deniedPurge.outcome, "op_rejected"); assert.equal(deniedPurge.code, "authorization_denied");
    for (const [method, params] of [["daemon.repo.backup", { rootDir: second, backupDir: path.join(parent, "denied-backup") }], ["daemon.repo.restoreDrill", { rootDir: second, backupDir: path.join(parent, "denied-backup") }]] as const) { const denied = await rpc(host, auth(ids.reader), method, params); assert.deepEqual({ outcome: denied.outcome, code: denied.code }, { outcome: "op_rejected", code: "authorization_denied" }, method); }
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});
// prettier-ignore

test("runtime witness issuance binds the server principal without transport role authorization", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-witness-rbac-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), ids = { writer: 4201, admin: 4202, dualAdmin: 4203, dualArbiter: 4204 }; rbacRepo(root, ids); const auth = (ownerUid: number) => ({ transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" } } as const);
  const runtimeActor = { principal: { personId: "fixture" }, executor: null } as const, definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "instance-runtime", installationId: "installation-runtime", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: null, authMode: "subscription" } as const, store = makeTaskEventStore({ repoId: "runtime-witness", rootDir: root, activationPreflight: activateEmptyCanonicalGeneration }), events = [{ schema: "agent-runtime-event/v1", eventId: "runtime-installation", workspaceRevision: 1, opId: "runtime-installation", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", type: "runtime_installation_observed", payload: { installationId: "installation-runtime", kindId: "codex", protocolFamily: "codex", hostRef: "host:local", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] } }, { schema: "agent-runtime-event/v1", eventId: "runtime-dispatch", workspaceRevision: 2, opId: "runtime-dispatch", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:01.000Z", type: "runtime_dispatch_requested", payload: { dispatchId: "dispatch-runtime", runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, idempotencyKey: "runtime-witness", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition } }, { schema: "agent-runtime-event/v1", eventId: "runtime-session", workspaceRevision: 3, opId: "runtime-session", actor: runtimeActor, source: "local", occurredAt: "2026-08-13T00:00:02.000Z", type: "runtime_session_started", payload: { runtimeSessionId: "session-runtime", instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, definitionSnapshotRef: "artifact:runtime-definition/test", launchGeneration: 1, attachable: true } }] as const satisfies readonly AgentRuntimeEventV1[]; for (const event of events) store.append({ event, plan: runtimeWritePlan(event), blobs: [] }); await store.drain();
    const host = await openDaemonHost({ daemonId: "runtime-witness", userRoot }); try { await host.admin({ kind: "register", rootDir: root, repoId: "runtime-witness" }, auth(ids.admin)); const issued = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ids.writer)), bound = host.bindRuntimeWitness("runtime-witness", issued.token); assert.equal(bound.actor.principal.personId, "writer"); assert.deepEqual(bound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); assert.equal(host.publishRuntimeWitness("runtime-witness", issued.token, { type: "activity", activity: "tool" }).type, "activity"); assert.equal(host.publishRuntimeWitness("runtime-witness", issued.token, { type: "heartbeat", actor: "provider-supplied" } as never).type, "heartbeat"); const assignment = { transportKind: "unix-socket", assignmentBinding: { nodeId: "node-runtime", repoId: "runtime-witness", taskId: "task-runtime", executionId: "execution-runtime", assignmentId: "assignment-runtime", paths: [], actor: { principal: { personId: "worker" }, executor: null } } } as const, assignmentToken = await host.issueRuntimeWitness("runtime-witness", "session-runtime", assignment), assignmentBound = host.bindRuntimeWitness("runtime-witness", assignmentToken.token); assert.deepEqual(assignmentBound.source, { kind: "assignment", nodeId: "node-runtime", assignmentId: "assignment-runtime" }); assert.deepEqual(assignmentBound.actor.executor, { kind: "agent", id: "runtime-session:session-runtime" }); for (const [personId, ownerUid] of [["dualAdmin", ids.dualAdmin], ["dualArbiter", ids.dualArbiter]] as const) { const token = await host.issueRuntimeWitness("runtime-witness", "session-runtime", auth(ownerUid)); assert.equal(host.bindRuntimeWitness("runtime-witness", token.token).actor.principal.personId, personId); } } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});
test("task mutation rejections name the missing field and current execution status", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-rejection-diagnostics-")),
    taskId = "task-rejection-diagnostics",
    executionId = "execution-rejection-diagnostics";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-rejection-diagnostics"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-rejection-diagnostics",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Rejection diagnostics" }, repoWriteBinding);
    const createdVisible = await waitForAcceptedReceipt(cell, created, repoWriteBinding);
    assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, repoWriteBinding),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, repoWriteBinding);
    writeFileSync(
      path.join(rootDir, "harness", String((created as Record<string, unknown>).packagePath), "closeout.md"),
      "# Closeout\n\n## Summary\n\nReady.\n",
    );
    const invalidSubmission = await cell.run({ kind: "task-submit", taskId, executionId }, repoWriteBinding);
    assert.equal(invalidSubmission.code, "closeout_placeholder", JSON.stringify(invalidSubmission));
    assert.match(JSON.stringify(invalidSubmission.next), /closeout.md/u);
    context.diagnostic(`invalid_submission receipt=${JSON.stringify(invalidSubmission)}`);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Premature review.", evidenceChecked: ["fixture"] }),
    );
    const prematureReview = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-premature",
        fromFile: "review.json",
      },
      withRoleBinding(
        {
          actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
          source: "local",
        },
        "arbiter",
      ),
    );
    assert.equal(prematureReview.code, "invalid_transition", JSON.stringify(prematureReview));
    assert.deepEqual(prematureReview.diagnostic, {
      kind: "validation",
      entity: `execution ${executionId}`,
      field: "status",
      actual: "active",
      expectation: "Execution status must be submitted on the current task iteration before review",
    });
    const derivedPrematureReview = await cell.run(
      { kind: "task-review-execution", taskId, reviewId: "review-derived-premature", fromFile: "review.json" },
      withRoleBinding(
        {
          actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
          source: "local",
        },
        "arbiter",
      ),
    );
    assert.equal(derivedPrematureReview.code, "invalid_command", JSON.stringify(derivedPrematureReview));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
test("task complete rejects a passing observation for another submitted commit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-ci-binding-")),
    taskId = "task-complete-ci-binding",
    executionId = "execution-complete-ci-binding",
    repoId = workspaceId("complete-ci-binding");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n",
    ); // CI witnessing is opt-in
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-ci-binding" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "CI Binding", false, "f".repeat(40));
    const store = makeTaskEventReader({ repoId, rootDir }),
      submitted = store
        .read()
        .events.find(
          (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
        );
    assert.ok(submitted && submitted.type === "execution_submitted");
    const execution = submitted.payload.execution;
    const unrelatedCut = store.read().revision;
    const unrelated = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding);
    assert.equal(unrelated.code, "ci_missing", JSON.stringify(unrelated));
    assert.equal(store.read().revision, unrelatedCut);
    await publishCiObservation(
      repoId,
      rootDir,
      executionId,
      execution.submission.commitSha,
      "unverified-matching-sha",
      false,
    );
    const unverifiedCut = store.read().revision;
    await assert.rejects(
      cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding),
      { code: "invalid_proof" },
      "unverified matching observations cannot establish workflow verification",
    );
    assert.equal(
      store.read().revision,
      unverifiedCut,
      "unverified historical-style observations cannot append passing witnesses",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
test("task complete accepts a verified main run on a commit that contains the submission", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-complete-ci-descendant-")),
    taskId = "task-complete-ci-descendant",
    executionId = "execution-complete-ci-descendant",
    repoId = workspaceId("complete-ci-descendant");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "complete-ci-descendant" });
    await prepareReadyCompletion(cell, rootDir, repoId, taskId, executionId, "CI Descendant", false);
    const submitted = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.find(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
      );
    assert.ok(submitted && submitted.type === "execution_submitted");
    const submittedSha = String(submitted.payload.execution.submission?.commitSha),
      laterMain = git(rootDir, "commit-tree", `${submittedSha}^{tree}`, "-p", submittedSha, "-m", "later main");
    await publishCiObservation(repoId, rootDir, executionId, laterMain, "run-later-main");
    const attempt = await cell.run({ kind: "task-complete", taskId, executionId }, repoWriteBinding);
    assert.equal(attempt.outcome, "applied", JSON.stringify(attempt));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
async function writeCloseout(
  drain: () => Promise<unknown>,
  rootDir: string,
  packagePath: string,
  summary: string,
  verification = "Verified.",
): Promise<string> {
  // The cell publishes ledger cuts to the same repo Git; drain its writer queue before this fixture
  // commit, or the two HEAD writers race and git dies with `cannot lock ref 'HEAD'`.
  await drain();
  writeFileSync(path.join(rootDir, "README.md"), "# Verified delivery\n");
  git(rootDir, "add", "README.md");
  execFileSync("git", ["-C", rootDir, "commit", "--quiet", "-m", "test: verified delivery"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T00:01:00Z", GIT_COMMITTER_DATE: "2026-08-14T00:01:00Z" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commitSha = git(rootDir, "rev-parse", "HEAD");
  writeFileSync(
    path.join(rootDir, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary} Commit ${commitSha}.\n\n## Verification\n\n${verification}\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n`,
  );
  return commitSha;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}
function decisionProposal(title: string, question: string) {
  return {
    kind: "decision-propose",
    body: `# ${title}\n\nUse the canonical event-backed flow for this fixture.\n`,
    jsonInput: JSON.stringify({
      title,
      question,
      riskTier: "medium",
      urgency: "medium",
      vertical: "default",
      preset: "default",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Use events" }],
      rejected: [{ id: "RJ1", text: "Use files", whyNot: "They are not canonical" }],
      claims: [],
      fulfillments: [],
    }),
  } as const;
}
async function prepareReadyCompletion(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  repoId: string,
  taskId: string,
  executionId: string,
  title: string,
  publishObservation = true,
  observationCommitSha?: string,
): Promise<string> {
  const binding = repoWriteBinding;
  const created = await cell.run({ kind: "task-create", taskId, title }, binding);
  const createdVisible = await waitForAcceptedReceipt(cell, created, binding);
  assert.equal(createdVisible.wait?.state, "satisfied", JSON.stringify(createdVisible));
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
  assert.equal((await waitForAcceptedReceipt(cell, started, binding)).wait?.state, "satisfied");
  const fact = await cell.run(
    {
      kind: "fact-record",
      taskId,
      statement: "Completion has a canonical task-owned observation.",
      evidenceSource: "test:completion",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
    },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, fact, binding)).wait?.state, "satisfied");
  const packagePath = `tasks/${taskId}-${title
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
  const commitSha = await writeCloseout(
    () => cell.settlePendingMaterialization("closeout git commit"),
    rootDir,
    packagePath,
    "Ready.",
  );
  const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  assert.equal((await waitForAcceptedReceipt(cell, submitted, binding)).wait?.state, "satisfied");
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  const reviewed = await cell.run(
    { kind: "task-review-execution", taskId, executionId, reviewId: "review-ready", fromFile: "review.json" },
    withRoleBinding(
      {
        actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "arbiter" } },
        source: "local",
      },
      "arbiter",
    ),
  );
  assert.equal((await waitForAcceptedReceipt(cell, reviewed, binding)).wait?.state, "satisfied");
  const consented = await cell.run(
    { kind: "task-review-consent", taskId, executionId, reviewId: "review-ready" },
    binding,
  );
  assert.equal((await waitForAcceptedReceipt(cell, consented, binding)).wait?.state, "satisfied");
  if (!publishObservation && !observationCommitSha) return "";
  const ciReceipt = await publishCiObservation(
    repoId,
    rootDir,
    executionId,
    observationCommitSha ?? commitSha,
    `run-${taskId}`,
  );
  return ciReceipt;
}
async function publishCiObservation(
  repoId: string,
  rootDir: string,
  executionId: string,
  commitSha: string,
  runId: string,
  verified = true,
): Promise<string> {
  const stateRoot = path.join(rootDir, ".harness", "fixture-writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "direct-store" }),
    lease = authority.current(repoId);
  assert.ok(lease, "the isolated repo cell owns a current writer epoch");
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      writerFence: () => ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        holderId: lease.holderId,
        epoch: lease.epoch,
      }),
    }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    databaseId = Number.parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16) + 1,
    observedRunId = `${databaseId}.${verified ? 1 : 2}`;
  try {
    const cell = {
      rootDir,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci", "rebuild-gates"] } }) },
      store,
      projection,
      now: () => "2026-09-09T00:00:00.000Z",
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as Parameters<typeof ingestCiObservations>[0];
    const fetched = await fetchCiObservations(cell, { kind: "ci-observe-pull", limit: 1 }, async (_command, args) => {
      if (args[1] === "list")
        return JSON.stringify([{ databaseId, headBranch: "main", createdAt: "2026-09-09T00:00:00.000Z" }]);
      if (args[1] === "view")
        return JSON.stringify({
          workflowName: "rewrite-ci",
          headSha: commitSha,
          headBranch: "main",
          status: "completed",
          conclusion: "success",
          attempt: 1,
          event: "push",
        });
      assert.equal(args[1], "download");
      const output = String(args[args.indexOf("--dir") + 1]);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        path.join(output, "observation.json"),
        JSON.stringify({
          schema: "ci-run-artifact/v1",
          run: {
            runId: observedRunId,
            sha: commitSha,
            branch: "main",
            prNumber: null,
            job: "full-check (24)",
            wallclockMs: 25,
            runner: "fixture-runner",
          },
          tests: [],
          gates: [{ gate: "ci", result: "pass", metrics: { runAttempt: 1 } }],
        }),
      );
      return "";
    });
    const receipt = ingestCiObservations(cell, repoWriteBinding, fetched);
    assert.equal(JSON.parse(receipt.evidence).imported, 1);
    const event = store
      .read()
      .events.find(
        (candidate) => candidate.type === "ci_run_observed" && candidate.payload.run.runId === observedRunId,
      );
    assert.ok(event && event.type === "ci_run_observed");
    assert.equal(event.payload.verification?.conclusion, verified ? "success" : undefined);
    assert.ok(
      store
        .read()
        .events.some(
          (candidate) =>
            candidate.type === "execution_submitted" && candidate.payload.execution.executionId === executionId,
        ),
    );
    await store.drain();
    const eventRefs = JSON.parse(receipt.evidence).eventRefs;
    assert.deepEqual(eventRefs, [`event:${event.opId}`]);
    return eventRefs[0];
  } finally {
    projection.close();
    await store.drain();
    authority.close();
  }
}
function rbacRepo(rootDir: string, ids: Readonly<Record<string, number>>): void {
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const policyRoles: Readonly<Record<string, readonly string[]>> = {
      reader: ["reader"],
      writer: ["repo-write"],
      arbiter: ["arbiter"],
      admin: ["admin"],
      dualAdmin: ["repo-write", "admin"],
      dualArbiter: ["repo-write", "arbiter"],
    },
    people = Object.entries(ids).map(([role, uid]) => ({
      personId: role,
      displayName: role,
      roles: policyRoles[role],
      credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
    }));
  const commands: Readonly<Record<string, readonly string[]>> = {
      reader: ["repo-read"],
      "repo-write": ["repo-write"],
      arbiter: ["arbiter"],
      admin: ["admin"],
    },
    roles = Object.keys(commands).map((roleId) => ({ roleId, commandClasses: commands[roleId] }));
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "add RBAC fixture");
}
async function rpc(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params });
  assert.ok(response && !Array.isArray(response) && "result" in response);
  return (response as { result: Record<string, unknown> }).result;
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function runtimeWritePlan(event: AgentRuntimeEventV1): FrozenWritePlan {
  return canonicalEventWritePlan(event, "agent-runtime/v1", event.opId);
}
