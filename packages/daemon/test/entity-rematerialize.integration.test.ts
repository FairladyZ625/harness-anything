// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-rematerialize" },
        executor: { kind: "agent", id: "agent-rematerialize" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  secondNodeBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-rematerialize-edge-two" },
        executor: { kind: "agent", id: "agent-rematerialize-edge-two" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

test("entity rematerialize renders relative graph links and is idempotent at one cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-rematerialize-"));
  initRepo(rootDir);
  const repoId = workspaceId("entity-rematerialize"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "rematerialize-test" }),
    reader = makeTaskEventReader({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: reader });
  try {
    const taskCreated = await cell.run({ kind: "task-create", taskId: "task_remat", title: "Remat Task" }, binding),
      factRecorded = await cell.run(
        {
          kind: "fact-record",
          factId: "F-00000REM",
          statement: "Rematerialize observes current relations.",
          evidenceSource: "test:entity-rematerialize",
          confidence: "high",
          memoryClass: "semantic",
        },
        binding,
      );
    assert.equal(taskCreated.outcome, "applied");
    assert.equal(factRecorded.outcome, "applied");
    const originalTaskEvent = reader.readEvent(taskCreated.opId),
      originalFactEvent = reader.readEvent(factRecorded.opId);
    assert.ok(originalTaskEvent);
    assert.ok(originalFactEvent);
    const proposed = await proposeDecision(cell, "Rematerialize Decision"),
      secondProposed = await proposeDecision(cell, "Second Rematerialize Decision");
    const decisionId = proposed.decisionId,
      secondDecisionId = secondProposed.decisionId,
      decisionPath = `decisions/decision-${decisionId}/decision.md`;
    for (const [sourceRef, targetRef, relationType] of [
      [`decision/${decisionId}/C1`, "fact/F-00000REM", "evidenced-by"],
      [`decision/${decisionId}/CH1`, "task/task_remat", "derives"],
      [`decision/${secondDecisionId}/C1`, "fact/F-00000REM", "evidenced-by"],
    ] as const) {
      const related = await cell.run(
        {
          kind: "relation-relate",
          sourceRef,
          targetRef,
          relationType,
          rationale: "Graph link fixture.",
          expectedVersion: 0,
        },
        binding,
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
    }
    const accepted = await cell.run(
        {
          kind: "decision-accept",
          decisionId,
          rationale: "The linked graph was independently reviewed.",
          judgmentOnlyRationale: "The linked graph was independently reviewed.",
        },
        secondNodeBinding,
      ),
      originalAcceptedEvent = reader.readEvent(accepted.opId),
      decisionBefore = projection.readDecisionDocumentState?.(decisionId),
      pinsBefore = decisionBefore?.contentPins;
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.ok(originalAcceptedEvent);
    assert.ok(pinsBefore?.length);
    const rendered = projection.readDocument(decisionPath).document!.body;
    assert.match(rendered, /## 关联图谱 \(Causal Graph\)/u);
    assert.match(rendered, /\]\(\.\.\/\.\.\/facts\/F-00000REM\.md\)/u);
    assert.match(rendered, /\]\(\.\.\/task_remat[^)]*INDEX\.md\)|\]\(\.\.\/\.\.\/tasks?[^)]*INDEX\.md\)/u);
    const previewHead = reader.readHead()?.revision ?? 0,
      preview = await cell.run({ kind: "decision-rematerialize", all: true, dryRun: true } as never, binding),
      previewReport = JSON.parse(String(preview.evidence)) as RematerializeReport;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(previewReport.writeStatus, "not_requested");
    assert.equal(previewReport.targetCount, 2);
    assert.ok(previewReport.changedCount >= 1, JSON.stringify(previewReport));
    assert.equal(reader.readHead()?.revision, previewHead, "preview must not append an event");
    const relationAfterPreview = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${secondDecisionId}/CH1`,
        targetRef: "task/task_remat",
        relationType: "derives",
        rationale: "Inserted after preview so apply must re-read the current cut.",
        expectedVersion: 0,
      },
      secondNodeBinding,
    );
    assert.equal(relationAfterPreview.outcome, "applied", JSON.stringify(relationAfterPreview));
    const crossDecisionAfterPreview = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${decisionId}`,
        targetRef: `decision/${secondDecisionId}`,
        relationType: "refines",
        rationale: "Both decision documents must be refreshed in one accepted batch.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(crossDecisionAfterPreview.outcome, "applied", JSON.stringify(crossDecisionAfterPreview));
    const headBeforeBatch = reader.readHead()?.revision ?? 0,
      concurrent = await Promise.all([
        cell.run({ kind: "decision-rematerialize", all: true } as never, binding),
        cell.run({ kind: "decision-rematerialize", all: true } as never, secondNodeBinding),
      ]);
    assert.deepEqual(
      concurrent.map(({ outcome }) => outcome).sort(),
      ["applied", "no_changes"],
      JSON.stringify(concurrent),
    );
    assert.equal(reader.readHead()?.revision, headBeforeBatch + 1, "two edge requests must append one batch event");
    const batchEvent = reader.read().events.at(-1);
    assert.equal(batchEvent?.schema, "entity-document-event/v1");
    if (batchEvent?.schema === "entity-document-event/v1") {
      assert.deepEqual(
        batchEvent.payload.entityRefs,
        [`decision/${decisionId}`, `decision/${secondDecisionId}`].sort(),
      );
      assert.equal(batchEvent.workspaceRevision, headBeforeBatch + 1);
      const secondClaim = batchEvent.payload.documentClaims.find(
        ({ path: target }) => target === `decisions/decision-${secondDecisionId}/decision.md`,
      );
      assert.ok(secondClaim);
      const acceptedBody = Buffer.from(reader.readContentBlob(secondClaim.sha256) ?? []).toString("utf8");
      assert.match(acceptedBody, /task_remat/u, "apply must include the relation inserted after preview");
    }
    assert.equal(
      (await cell.run({ kind: "decision-rematerialize", all: true } as never, binding)).outcome,
      "no_changes",
    );
    // The first refresh for each remaining kind may restamp managed fields; the next run at the
    // same cut must be byte-for-byte idempotent.
    const headAfterDecisionBatch = reader.readHead()?.revision ?? 0;
    for (const action of [
      { kind: "fact-rematerialize", factId: "F-00000REM" },
      { kind: "fact-rematerialize", all: true },
      { kind: "task-rematerialize", taskId: "task_remat" },
      { kind: "task-rematerialize", all: true },
    ] as const) {
      const first = await cell.run(action as never, binding);
      assert.ok(
        first.outcome === "applied" || first.outcome === "no_changes",
        `${action.kind}: ${JSON.stringify(first)}`,
      );
      const dry = await cell.run({ ...action, dryRun: true } as never, binding);
      assert.equal(dry.outcome, "no_changes", `dry-run ${action.kind}: ${JSON.stringify(dry)}`);
      const second = await cell.run(action as never, binding);
      assert.equal(second.outcome, "no_changes", `${action.kind}: ${JSON.stringify(second)}`);
    }
    const headAfterRemat = reader.readHead()?.revision ?? 0;
    assert.ok(
      headAfterRemat >= headAfterDecisionBatch && headAfterRemat <= headAfterDecisionBatch + 2,
      `refresh appended ${headAfterRemat - headAfterDecisionBatch} events; at most one per remaining entity kind`,
    );
    const decisionAfter = projection.readDecisionDocumentState?.(decisionId);
    assert.equal(decisionAfter?.workspaceRevision, decisionBefore?.workspaceRevision);
    assert.deepEqual(decisionAfter?.contentPins, pinsBefore);
    assert.match(
      projection.readDocument(decisionPath).document!.body,
      new RegExp(`workspaceRevision: ${decisionBefore?.workspaceRevision}`, "u"),
    );
    assert.deepEqual(reader.readEvent(accepted.opId), originalAcceptedEvent);
    assert.deepEqual(reader.readEvent(taskCreated.opId), originalTaskEvent);
    assert.deepEqual(reader.readEvent(factRecorded.opId), originalFactEvent);
    // A dirty authored document is reported as a worktree conflict without a new canonical write.
    const file = path.join(rootDir, "harness", decisionPath);
    appendFileSync(file, "\nlocal dirty draft\n");
    const dirtyHead = reader.readHead()?.revision ?? 0,
      dirtyReceipt = await cell.run({ kind: "decision-rematerialize", decisionId } as never, binding),
      dirtyReport = JSON.parse(String(dirtyReceipt.evidence)) as RematerializeReport;
    assert.equal(dirtyReceipt.outcome, "pending", JSON.stringify(dirtyReceipt));
    assert.equal(dirtyReport.writeStatus, "not_needed");
    assert.deepEqual(dirtyReport.targets[0]?.conflictPaths, [decisionPath]);
    assert.equal(reader.readHead()?.revision, dirtyHead, "a same-cut dirty conflict must not append an event");
    assert.match(readFileSync(file, "utf8"), /local dirty draft\n$/u);
    // A dirty path with real pending changes is excluded from the batch instead of clobbered.
    const incomingToDirty = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${secondDecisionId}`,
        targetRef: `decision/${decisionId}`,
        relationType: "refines",
        rationale: "An incoming edge makes the dirty document stale relative to the canonical render.",
        expectedVersion: 0,
      },
      secondNodeBinding,
    );
    assert.equal(incomingToDirty.status, "accepted_durable", JSON.stringify(incomingToDirty));
    const canonicalBefore = projection.readDocument(decisionPath).document!.blobSha256,
      staleHead = reader.readHead()?.revision ?? 0,
      staleReceipt = await cell.run({ kind: "decision-rematerialize", decisionId } as never, binding),
      staleReport = JSON.parse(String(staleReceipt.evidence)) as RematerializeReport;
    assert.equal(staleReceipt.outcome, "pending", JSON.stringify(staleReceipt));
    assert.equal(staleReport.changedCount, 0);
    assert.deepEqual(staleReport.targets[0]?.conflictPaths, [decisionPath]);
    assert.equal(reader.readHead()?.revision, staleHead, "a dirty target must not enter the appended event");
    assert.equal(
      projection.readDocument(decisionPath).document!.blobSha256,
      canonicalBefore,
      "the dirty path must not be republished over the draft",
    );
    assert.match(readFileSync(file, "utf8"), /local dirty draft\n$/u);
  } finally {
    projection.close();
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

type RematerializeReport = {
  readonly writeStatus: string;
  readonly targetCount: number;
  readonly changedCount: number;
  readonly targets: readonly { readonly conflictPaths: readonly string[] }[];
};

async function proposeDecision(cell: Awaited<ReturnType<typeof openRepoCell>>, title: string) {
  const receipt = await cell.run(
    {
      kind: "decision-propose",
      body: `# ${title}\n\nCurrent decision prose remains authored.\n`,
      jsonInput: JSON.stringify({
        title,
        question: "Are current relations linked in the managed document?",
        riskTier: "medium",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Link the neighborhood" }],
        rejected: [{ id: "RJ1", text: "Keep bare refs", whyNot: "The graph must self-link." }],
        claims: [{ id: "C1", text: "Links resolve to canonical paths.", loadBearing: true }],
        fulfillments: [],
      }),
    },
    binding,
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  return {
    receipt,
    decisionId: (JSON.parse(String(receipt.evidence)) as { readonly decisionId: string }).decisionId,
  };
}
