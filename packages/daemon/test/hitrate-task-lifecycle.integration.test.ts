// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
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
    assert.equal(
      (await cell.run({ kind: "task-create", taskId, title: "Lifecycle hit rate" }, holder)).outcome,
      "applied",
    );
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
    if (event?.type === "code_doc_reconciled")
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
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
