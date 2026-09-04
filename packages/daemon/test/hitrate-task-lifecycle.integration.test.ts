// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, submissionDigest } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test("task start, inline submit, and code-doc reconcile reuse daemon-known lifecycle state", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-hitrate-lifecycle-")),
    rootDir = path.join(parent, "repo"),
    taskId = "task-hitrate-lifecycle",
    executionId = "execution-hitrate-lifecycle",
    repoId = workspaceId("hitrate-lifecycle"),
    holder = {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent" as const, id: "worker-owner" },
      },
      source: "local" as const,
    },
    foreign = {
      actor: {
        principal: { personId: "person-other" },
        executor: { kind: "agent" as const, id: "worker-other" },
      },
      source: "local" as const,
    };
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "add lifecycle fixture");
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "hitrate-lifecycle",
  });
  try {
    const created = await cell.run({ kind: "task-create", taskId, title: "Lifecycle hit rate" }, holder);
    assert.equal(created.outcome, "applied");
    const fact = await cell.run(
      {
        kind: "fact-record",
        taskId,
        statement: "The lifecycle fixture exercises one canonical code-doc witness cut.",
        evidenceSource: "test:hitrate-lifecycle",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
      },
      holder,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    const packagePath = String((created as { readonly packagePath?: unknown }).packagePath),
      planPath = `${packagePath}/task_plan.md`,
      oneSectionMissing = realizedTaskPlan("Lifecycle hit rate").replace(
        /\n\n## CI\/Gate Authority Stop Condition\n\n[^\n]+/u,
        "",
      );
    writeFileSync(path.join(rootDir, "harness", planPath), oneSectionMissing);
    const placeholder = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(placeholder.outcome, "op_rejected", JSON.stringify(placeholder));
    assert.equal(placeholder.code, "plan_placeholder");
    assert.deepEqual(placeholder.diagnostic, {
      kind: "missing-sections",
      documentPath: planPath,
      diskDiffers: true,
      missingSections: [{ section: "CI/Gate Authority Stop Condition", reason: "empty" }],
    });
    const closeoutPath = `${packagePath}/closeout.md`;
    await realizeTaskPlanFixture(
      rootDir,
      packagePath,
      (pathToSubmit) => cell.run({ kind: "doc-submit", paths: [pathToSubmit] }, holder),
      "Lifecycle hit rate",
    );
    writeFileSync(
      path.join(rootDir, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo other path in this fixture.\n",
    );
    const synced = await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, holder);
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const events = () => makeTaskEventReader({ repoId, rootDir }).read().events,
      startedEvents = events().length,
      repeated = (await cell.run(
        { kind: "task-start", taskId, executionId: "ignored-new-execution" },
        holder,
      )) as Record<string, unknown>;
    assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
    assert.equal(repeated.executionId, executionId);
    assert.match(String(repeated.opId), /^noop:/u);
    assert.deepEqual(JSON.parse(String(repeated.evidence)), { noOp: true, taskId, executionId });
    assert.equal(events().length, startedEvents, "same-holder retry must not append an event");

    const rejected = (await cell.run({ kind: "task-start", taskId }, foreign)) as Record<string, unknown>;
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "lease_conflict");
    assert.equal(events().length, startedEvents, "foreign retry must not append an event");

    const commitSha = git(rootDir, "rev-parse", "HEAD"),
      incorrectCommitSha = "b".repeat(40),
      submission = {
        completionClaim: "Lifecycle behavior is implemented.",
        deliverables: ["README.md"],
        outputs: ["README.md"],
        verificationNotes: ["integration test"],
        knownGaps: [],
        residualRisks: [],
        commitSha: incorrectCommitSha,
      },
      externalPacket = path.join(parent, "submission.json");
    writeFileSync(externalPacket, JSON.stringify(submission));
    const external = (await cell.run({ kind: "task-submit", taskId, fromFile: externalPacket }, holder)) as Record<
      string,
      unknown
    >;
    assert.equal(external.outcome, "op_rejected", JSON.stringify(external));
    assert.equal(external.code, "invalid_command");

    const submitted = await cell.run({ kind: "task-submit", taskId, jsonInput: JSON.stringify(submission) }, holder);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    const repeatedSubmit = (await cell.run(
      { kind: "task-submit", taskId, executionId, jsonInput: JSON.stringify({ ...submission, commitSha }) },
      holder,
    )) as Record<string, unknown>;
    assert.equal(repeatedSubmit.outcome, "op_rejected", JSON.stringify(repeatedSubmit));
    assert.equal(repeatedSubmit.code, "invalid_transition");

    const reconcileBeforeAmend = (await cell.run(
      { kind: "task-code-doc-reconcile", taskId, paths: ["README.md"] },
      holder,
    )) as Record<string, unknown>;
    assert.equal(reconcileBeforeAmend.outcome, "op_rejected", JSON.stringify(reconcileBeforeAmend));
    assert.equal(reconcileBeforeAmend.code, "invalid_proof");

    const wrongExecutionAmend = (await cell.run(
      {
        kind: "task-submit",
        taskId,
        executionId: "execution-not-current",
        amend: true,
        jsonInput: JSON.stringify({ ...submission, completionClaim: "Wrong execution.", commitSha }),
      },
      holder,
    )) as Record<string, unknown>;
    assert.equal(wrongExecutionAmend.outcome, "op_rejected", JSON.stringify(wrongExecutionAmend));
    assert.equal(wrongExecutionAmend.code, "invalid_transition");
    assert.deepEqual(wrongExecutionAmend.diagnostic, {
      kind: "validation",
      entity: `task ${taskId}`,
      field: "executionId",
      actual: "execution-not-current",
      expectation:
        `Current submitted execution is ${executionId}; retry ha task submit ${taskId} ` +
        `--execution-id ${executionId} --amend --json-input '<submission-json>'`,
    });

    const noOpAmend = (await cell.run(
      {
        kind: "task-submit",
        taskId,
        executionId,
        amend: true,
        jsonInput: JSON.stringify(submission),
      },
      holder,
    )) as Record<string, unknown>;
    assert.equal(noOpAmend.outcome, "op_rejected", JSON.stringify(noOpAmend));
    assert.equal(noOpAmend.code, "invalid_transition");

    const crossActorAmend = (await cell.run(
      {
        kind: "task-submit",
        taskId,
        executionId,
        amend: true,
        jsonInput: JSON.stringify({ ...submission, completionClaim: "Foreign correction.", commitSha }),
      },
      foreign,
    )) as Record<string, unknown>;
    assert.equal(crossActorAmend.outcome, "op_rejected", JSON.stringify(crossActorAmend));
    assert.equal(crossActorAmend.code, "lease_required");

    const amendRevision = Number(submitted.revision),
      amendmentPackets = [
        { ...submission, completionClaim: "Corrected lifecycle cut A.", commitSha },
        { ...submission, completionClaim: "Corrected lifecycle cut B.", commitSha },
      ],
      amendmentResults = (await Promise.all(
        amendmentPackets.map((packet) =>
          cell.run(
            {
              kind: "task-submit",
              taskId,
              executionId,
              amend: true,
              expectedVersion: amendRevision,
              jsonInput: JSON.stringify(packet),
            },
            holder,
          ),
        ),
      )) as readonly Record<string, unknown>[],
      appliedAmendments = amendmentResults.filter(({ outcome }) => outcome === "applied"),
      rejectedAmendments = amendmentResults.filter(({ outcome }) => outcome === "op_rejected"),
      amended = appliedAmendments[0]!,
      amendedPacket = amendmentPackets[amendmentResults.indexOf(amended)]!;
    assert.equal(appliedAmendments.length, 1, JSON.stringify(amendmentResults));
    assert.equal(rejectedAmendments.length, 1, JSON.stringify(amendmentResults));
    assert.equal(rejectedAmendments[0]?.code, "invalid_transition", JSON.stringify(amendmentResults));
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.match(String(amended.summary), /prior Review and consent pins are stale/u);
    const submissionEvents = events().filter((candidate) => candidate.type === "execution_submitted");
    assert.equal(submissionEvents.length, 2);
    const initialSubmission = submissionEvents[0];
    if (initialSubmission?.type !== "execution_submitted" || !initialSubmission.payload.execution.submission)
      throw new Error("initial submission event missing");
    assert.equal(
      submissionEvents[1]?.payload.supersedesSubmissionId,
      `submission:${submissionDigest(initialSubmission.payload.execution.submission)}`,
    );

    const obsolete = (await cell.run(
      {
        kind: "task-code-doc-reconcile",
        taskId,
        executionId,
        commitSha,
        iteration: 0,
        paths: ["README.md"],
      },
      holder,
    )) as Record<string, unknown>;
    assert.equal(obsolete.outcome, "op_rejected", JSON.stringify(obsolete));
    assert.equal(obsolete.code, "invalid_command");

    const reconciled = (await cell.run(
      { kind: "task-code-doc-reconcile", taskId, paths: ["README.md"] },
      holder,
    )) as Record<string, unknown>;
    assert.equal(reconciled.outcome, "applied", JSON.stringify(reconciled));
    assert.equal(reconciled.executionId, executionId);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(reconciled.opId));
    assert.equal(event?.type, "code_doc_reconciled");
    if (event?.type !== "code_doc_reconciled") throw new Error("reconcile event missing");
    assert.deepEqual(event.payload.witness, {
      schema: "code-doc-witness/v1",
      witnessId: event.payload.witness.witnessId,
      taskId,
      executionId,
      commitSha,
      iteration: 0,
      paths: ["README.md"],
      actor: holder.actor,
      source: "local",
      reconciledAt: event.occurredAt,
    });

    const reviewer = withRoleBinding(
        {
          actor: {
            principal: { personId: "person-reviewer" },
            executor: { kind: "agent" as const, id: "worker-reviewer" },
          },
          source: "local" as const,
        },
        "arbiter",
      ),
      reviewed = await cell.run(
        {
          kind: "task-review-execution",
          taskId,
          reviewId: "review-hitrate-lifecycle",
          jsonInput: JSON.stringify({
            verdict: "approved",
            reason: "Independent review passed.",
            evidenceChecked: ["tests"],
          }),
        },
        reviewer,
      );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const consented = await cell.run(
      {
        kind: "task-review-consent",
        taskId,
        reviewId: "review-hitrate-lifecycle",
        consentId: "consent-hitrate-lifecycle",
      },
      holder,
    );
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const consentEvent = makeTaskEventReader({ repoId, rootDir }).readEvent(String(consented.opId));
    assert.equal(
      consentEvent?.type === "review_consent_recorded" ? consentEvent.payload.consent.submissionDigest : null,
      submissionDigest(amendedPacket),
    );
    const completed = await cell.run({ kind: "task-complete", taskId, ci: "passed" }, holder);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));

    const amendCompleted = (await cell.run(
      {
        kind: "task-submit",
        taskId,
        executionId,
        amend: true,
        jsonInput: JSON.stringify({ ...submission, completionClaim: "Too late.", commitSha }),
      },
      holder,
    )) as Record<string, unknown>;
    assert.equal(amendCompleted.outcome, "op_rejected", JSON.stringify(amendCompleted));
    assert.equal(amendCompleted.code, "invalid_transition");

    const beforeDrift = events().length,
      drifted = await cell.run(
        {
          kind: "task-code-doc-repoint",
          taskId,
          record: event.payload.witness.witnessId,
          commitSha: "b".repeat(40),
          paths: ["README.md"],
          reason: "Caller cut must not override the submission",
        },
        holder,
      );
    assert.equal(drifted.outcome, "op_rejected", JSON.stringify(drifted));
    assert.equal(drifted.code, "invalid_command");
    assert.equal(events().length, beforeDrift, "retired caller cut must not append an event");

    const repointed = await cell.run(
      {
        kind: "task-code-doc-repoint",
        taskId,
        record: event.payload.witness.witnessId,
        paths: ["README.md"],
        reason: "Correct witness from the canonical submission cut",
      },
      holder,
    );
    assert.equal(repointed.outcome, "applied", JSON.stringify(repointed));
    const repointEvent = makeTaskEventReader({ repoId, rootDir }).readEvent(String(repointed.opId));
    assert.equal(repointEvent?.type, "code_doc_repointed");
    if (repointEvent?.type === "code_doc_repointed") {
      assert.equal(repointEvent.payload.record.commitSha, commitSha);
      assert.deepEqual(repointEvent.payload.record.paths, event.payload.witness.paths);
    }
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
