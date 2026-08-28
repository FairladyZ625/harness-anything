// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

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
    const placeholder = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(placeholder.outcome, "op_rejected", JSON.stringify(placeholder));
    assert.equal(placeholder.code, "plan_placeholder");
    assert.match(placeholder.nextAction ?? "", /task_plan\.md/u);
    const packagePath = String((created as { readonly packagePath?: unknown }).packagePath),
      planPath = `${packagePath}/task_plan.md`,
      closeoutPath = `${packagePath}/closeout.md`;
    writeFileSync(path.join(rootDir, "harness", planPath), realizedPlan());
    writeFileSync(
      path.join(rootDir, "harness", closeoutPath),
      "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo other path in this fixture.\n",
    );
    const synced = await cell.run({ kind: "doc-submit", paths: [planPath, closeoutPath] }, holder);
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const events = () => makeTaskEventStore({ repoId, rootDir }).read().events,
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
    assert.match(String(rejected.nextAction), /personId=person-owner, executor=agent:worker-owner/u);
    assert.match(String(rejected.nextAction), /ha task release task-hitrate-lifecycle/u);
    assert.match(String(rejected.nextAction), /wait for release/u);
    assert.equal(events().length, startedEvents, "foreign retry must not append an event");

    const commitSha = git(rootDir, "rev-parse", "HEAD"),
      submission = {
        completionClaim: "Lifecycle behavior is implemented.",
        deliverables: ["README.md"],
        outputs: ["README.md"],
        verificationNotes: ["integration test"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
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
    assert.match(String(obsolete.nextAction), /ha task code-doc reconcile task-hitrate-lifecycle/u);

    const reconciled = (await cell.run({ kind: "task-code-doc-reconcile", taskId }, holder)) as Record<string, unknown>;
    assert.equal(reconciled.outcome, "applied", JSON.stringify(reconciled));
    assert.equal(reconciled.executionId, executionId);
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(reconciled.opId));
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

    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] }),
    );
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
          fromFile: "review.json",
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
    const completed = await cell.run({ kind: "task-complete", taskId, ci: "passed" }, holder);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));

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
    assert.match(drifted.nextAction ?? "", /without commitSha; the submitted execution supplies the witness cut/u);
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
    const repointEvent = makeTaskEventStore({ repoId, rootDir }).readEvent(String(repointed.opId));
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

function realizedPlan(): string {
  const headings = [
    "Brief",
    "Goal",
    "Context",
    "Required Reading",
    "Entry Conditions",
    "Dependencies",
    "Execution Surface",
    "Constraints",
    "Checkpoint",
    "CI/Gate Authority Stop Condition",
    "Implementation Plan",
    "Deliverable Contract",
    "Evidence Protocol",
    "Verification",
  ];
  return `# Lifecycle hit rate\n\n${headings.map((heading) => `## ${heading}\n\nRealized ${heading}.`).join("\n\n")}\n`;
}
