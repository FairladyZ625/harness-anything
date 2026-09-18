// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  declaredRelationTriples,
  deriveRelationId,
  makeTaskEventReader,
  makeTaskProjection,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-relation-action" },
        executor: { kind: "agent", id: "agent-relation-action" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  secondNodeBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-relation-action-secondary" },
        executor: { kind: "agent", id: "agent-relation-action-secondary" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

async function waitForAcceptedReceipt(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  accepted: { readonly opId: string; readonly acceptance?: { readonly revisionTo?: number } | null },
) {
  return cell.run(
    {
      kind: "receipt-show",
      opId: accepted.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
      timeoutMs: 5_000,
    },
    binding,
  );
}

test("immediate relate observes all newly created endpoints across twenty writer turns", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-immediate-"));
  initRepo(rootDir);
  const repoId = workspaceId("relation-immediate"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-immediate-test" }),
    reader = makeTaskEventReader({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: reader });
  try {
    const decision = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Immediate relation anchors",
          question: "Can a chosen option derive a newly created task?",
          riskTier: "medium",
          urgency: "high",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: Array.from({ length: 5 }, (_, index) => ({
            id: `CH${index + 1}`,
            text: `Create task group ${index + 1}`,
          })),
          rejected: [{ id: "RJ1", text: "Delay relation writes", whyNot: "The writer turn must expose its entities" }],
          claims: [{ id: "C1", text: "New entities are visible to the next writer turn.", loadBearing: true }],
          fulfillments: [],
        }),
      },
      binding,
    );
    assert.equal(decision.outcome, "applied", JSON.stringify(decision));
    const decisionId = (JSON.parse(String(decision.evidence)) as { decisionId: string }).decisionId,
      anchoredRelationIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const sourceRef = `task/task_immediate_source_${index}`,
        targetRef = `task/task_immediate_target_${index}`;
      for (const ref of [sourceRef, targetRef])
        assert.equal(
          (await cell.run({ kind: "task-create", taskId: ref.slice(5), title: ref }, binding)).outcome,
          "applied",
        );
      const anchoredSourceRef = `decision/${decisionId}/CH${(index % 5) + 1}`,
        anchorCut = projection.readCut(),
        anchorWriteRevision = reader.readHead()?.revision ?? 0,
        anchored = await cell.run(
          {
            kind: "relation-relate",
            sourceRef: anchoredSourceRef,
            targetRef,
            relationType: "derives",
            rationale: "Chosen option derives this task",
            expectedVersion: 0,
          },
          index % 2 === 0 ? binding : secondNodeBinding,
        );
      t.diagnostic(
        JSON.stringify({
          index,
          sourceRef: anchoredSourceRef,
          watermark: anchorCut.watermark,
          writeRevision: anchorWriteRevision,
          delta: anchorWriteRevision - anchorCut.watermark,
          outcome: anchored.outcome,
        }),
      );
      assert.equal(anchored.outcome, "applied", JSON.stringify(anchored));
      anchoredRelationIds.push(
        deriveRelationId({
          source: anchoredSourceRef,
          target: targetRef,
          type: "derives",
          direction: "directed",
        }),
      );
      assert.equal(anchorCut.watermark, anchorWriteRevision);
      const cut = projection.readCut(),
        writeRevision = reader.readHead()?.revision ?? 0,
        receipt = await cell.run(
          {
            kind: "relation-relate",
            sourceRef,
            targetRef,
            relationType: "depends-on",
            rationale: "Immediate dependency",
            expectedVersion: 0,
          },
          binding,
        );
      t.diagnostic(
        JSON.stringify({
          index,
          watermark: cut.watermark,
          writeRevision,
          delta: writeRevision - cut.watermark,
          outcome: receipt.outcome,
        }),
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(cut.watermark, writeRevision);
    }
    const lastEvent = reader.read().events.at(-2);
    assert.equal(lastEvent?.schema, "relation-event/v1");
    if (lastEvent?.schema === "relation-event/v1")
      assert.deepEqual(
        lastEvent.payload.documentClaims?.map(({ path: target }) => target),
        [`decisions/decision-${decisionId}/decision.md`],
      );
    const decisionPath = path.join(rootDir, "harness", `decisions/decision-${decisionId}/decision.md`),
      decisionBody = readFileSync(decisionPath, "utf8");
    for (const relationId of anchoredRelationIds) assert.equal(decisionBody.includes(relationId), true, relationId);
    projection.rebuild();
    assert.equal(projection.readDocument(`decisions/decision-${decisionId}/decision.md`).document?.body, decisionBody);
    const targetDecision = await cell.run(
        {
          kind: "decision-propose",
          jsonInput: JSON.stringify({
            title: "Incoming relation target",
            question: "Does the target preserve canonical relation direction?",
            riskTier: "medium",
            urgency: "medium",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: ["daemon"], productLines: [] },
            chosen: [{ id: "CH1", text: "Keep incoming edges in the neighborhood" }],
            rejected: [{ id: "RJ1", text: "Reverse the edge", whyNot: "That changes canonical meaning" }],
            claims: [{ id: "C1", text: "Direction remains canonical.", loadBearing: true }],
            fulfillments: [],
          }),
        },
        binding,
      ),
      targetDecisionId = (JSON.parse(String(targetDecision.evidence)) as { decisionId: string }).decisionId;
    assert.equal(targetDecision.outcome, "applied", JSON.stringify(targetDecision));
    assert.equal((await waitForAcceptedReceipt(cell, targetDecision)).wait?.state, "satisfied");
    const decisionRelationId = deriveRelationId({
        source: `decision/${decisionId}`,
        target: `decision/${targetDecisionId}`,
        type: "refines",
        direction: "directed",
      }),
      relatedDecisions = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `decision/${decisionId}`,
          targetRef: `decision/${targetDecisionId}`,
          relationType: "refines",
          rationale: "The source decision sharpens the target policy.",
          expectedVersion: 0,
        },
        secondNodeBinding,
      );
    assert.equal(relatedDecisions.outcome, "applied", JSON.stringify(relatedDecisions));
    assert.equal((await waitForAcceptedReceipt(cell, relatedDecisions)).wait?.state, "satisfied");
    const targetBody = readFileSync(
        path.join(rootDir, "harness", `decisions/decision-${targetDecisionId}/decision.md`),
        "utf8",
      ),
      targetFrontmatter = targetBody.slice(0, targetBody.indexOf("\n---\n", 4));
    assert.equal(targetFrontmatter.includes(decisionRelationId), false);
    assert.match(
      targetBody,
      new RegExp(`### 演进与关联决策 \\(Related Decisions\\)[\\s\\S]*${decisionId}[^\\n]*\\(incoming refines\\)`, "u"),
    );
    const decisionRelationEvent = reader.readEvent(String(relatedDecisions.opId));
    assert.equal(decisionRelationEvent?.schema, "relation-event/v1");
    if (decisionRelationEvent?.schema === "relation-event/v1")
      assert.deepEqual(
        decisionRelationEvent.payload.documentClaims?.map(({ path: target }) => target).sort(),
        [`decisions/decision-${decisionId}/decision.md`, `decisions/decision-${targetDecisionId}/decision.md`].sort(),
      );
    for (const missing of ["source", "target"] as const) {
      const receipt = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: missing === "source" ? "task/missing_source" : "task/task_immediate_source_0",
          targetRef: missing === "target" ? "task/missing_target" : "task/task_immediate_target_0",
          relationType: "depends-on",
          rationale: "Missing endpoint control",
          expectedVersion: 0,
        },
        binding,
      );
      t.diagnostic(JSON.stringify({ missing, receipt }));
      assert.equal(receipt.code, "entity_not_found");
      assert.ok(
        String(receipt.rejectionExplanation).startsWith(`Relation ${missing} task/missing_${missing} does not exist (`),
        JSON.stringify(receipt.rejectionExplanation),
      );
      const cut = lookupCutOf(receipt.rejectionExplanation);
      assert.ok(cut, JSON.stringify(receipt.rejectionExplanation));
      assert.ok(cut.watermark <= cut.writeHead, JSON.stringify(cut));
      assert.equal(cut.writeHead, reader.readHead()?.revision ?? 0);
    }
    const dirtyBody = `${readFileSync(decisionPath, "utf8")}\nUser-authored draft that must not be overwritten.\n`;
    writeFileSync(decisionPath, dirtyBody);
    const dirtyRelation = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${decisionId}`,
        targetRef: "task/task_immediate_target_19",
        relationType: "derives",
        rationale: "The accepted relation remains durable while the draft blocks materialization.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(dirtyRelation.outcome, "pending", JSON.stringify(dirtyRelation));
    assert.equal(readFileSync(decisionPath, "utf8"), dirtyBody);
    const dirtyEvent = reader.readEvent(String(dirtyRelation.opId));
    assert.equal(dirtyEvent?.schema, "relation-event/v1");
    if (dirtyEvent?.schema === "relation-event/v1")
      assert.equal(
        dirtyEvent.payload.documentClaims?.some(
          ({ path: target }) => target === `decisions/decision-${decisionId}/decision.md`,
        ),
        true,
      );
    const dirtyReceipt = await cell.run({ kind: "receipt-show", opId: dirtyRelation.opId }, binding);
    assert.equal(dirtyReceipt.outcome, "pending", JSON.stringify(dirtyReceipt));
  } finally {
    projection.close();
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("supersedes-fact relation create and final retirement publish current Fact liveness", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-fact-document-"));
  initRepo(rootDir);
  const repoId = workspaceId("relation-fact-document"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-fact-document-test" });
  try {
    const first = await cell.run(
        {
          kind: "fact-record",
          statement: "The first observation remains historically available.",
          evidenceSource: "test:first",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: ["pattern"],
        },
        binding,
      ),
      second = await cell.run(
        {
          kind: "fact-record",
          statement: "The replacement observation has stronger evidence.",
          evidenceSource: "test:second",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: ["pattern"],
        },
        binding,
      ),
      third = await cell.run(
        {
          kind: "fact-record",
          statement: "An independent replacement observation remains active.",
          evidenceSource: "test:third",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: ["pattern"],
        },
        binding,
      );
    assert.equal((await waitForAcceptedReceipt(cell, first)).wait?.state, "satisfied");
    assert.equal((await waitForAcceptedReceipt(cell, second)).wait?.state, "satisfied");
    assert.equal((await waitForAcceptedReceipt(cell, third)).wait?.state, "satisfied");
    const firstId = String(first.factId),
      secondId = String(second.factId),
      thirdId = String(third.factId),
      secondRelationId = deriveRelationId({
        source: `fact/${secondId}`,
        target: `fact/${firstId}`,
        type: "supersedes-fact",
        direction: "directed",
      }),
      thirdRelationId = deriveRelationId({
        source: `fact/${thirdId}`,
        target: `fact/${firstId}`,
        type: "supersedes-fact",
        direction: "directed",
      }),
      secondRelated = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `fact/${secondId}`,
          targetRef: `fact/${firstId}`,
          relationType: "supersedes-fact",
          rationale: "The second observation uses the corrected source.",
          expectedVersion: 0,
        },
        binding,
      ),
      thirdRelated = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `fact/${thirdId}`,
          targetRef: `fact/${firstId}`,
          relationType: "supersedes-fact",
          rationale: "The independent replacement remains valid if the other edge retires.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(secondRelated.outcome, "applied", JSON.stringify(secondRelated));
    assert.equal(thirdRelated.outcome, "applied", JSON.stringify(thirdRelated));
    assert.equal((await waitForAcceptedReceipt(cell, secondRelated)).wait?.state, "satisfied");
    assert.equal((await waitForAcceptedReceipt(cell, thirdRelated)).wait?.state, "satisfied");
    const firstPath = path.join(rootDir, "harness", `facts/${firstId}.md`),
      superseded = readFileSync(firstPath, "utf8");
    assert.match(superseded, /State: superseded_fact/u);
    assert.match(superseded, new RegExp(`Superseded by: fact/${secondId}`, "u"));
    assert.match(superseded, new RegExp(`Superseded by: fact/${thirdId}`, "u"));
    assert.match(superseded, /corrected source/u);
    const firstRetired = await cell.run(
      {
        kind: "relation-unrelate",
        relationId: secondRelationId,
        reason: "The replacement evidence was withdrawn.",
        expectedVersion: secondRelated.revision,
      },
      binding,
    );
    assert.equal(firstRetired.outcome, "applied", JSON.stringify(firstRetired));
    assert.equal((await waitForAcceptedReceipt(cell, firstRetired)).wait?.state, "satisfied");
    const stillSuperseded = readFileSync(firstPath, "utf8");
    assert.match(stillSuperseded, /State: superseded_fact/u);
    assert.doesNotMatch(stillSuperseded, new RegExp(`Superseded by: fact/${secondId}`, "u"));
    assert.match(stillSuperseded, new RegExp(`Superseded by: fact/${thirdId}`, "u"));
    const finalRetired = await cell.run(
      {
        kind: "relation-unrelate",
        relationId: thirdRelationId,
        reason: "The final active replacement evidence was withdrawn.",
        expectedVersion: thirdRelated.revision,
      },
      binding,
    );
    assert.equal(finalRetired.outcome, "applied", JSON.stringify(finalRetired));
    assert.equal((await waitForAcceptedReceipt(cell, finalRetired)).wait?.state, "satisfied");
    const restored = readFileSync(firstPath, "utf8");
    assert.match(restored, /State: standing/u);
    assert.doesNotMatch(restored, /Superseded by:/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Relation triples read projects the canonical registry with endpoint filters", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-triples-"));
  initRepo(rootDir);
  const repoId = workspaceId("relation-triples"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-triples-test" });
  try {
    for (const sourceKind of ["fact", "decision", "task", "relation"]) {
      const receipt = await cell.run({ kind: "relation-triples", sourceKind }, binding),
        payload = JSON.parse(String(receipt.evidence)) as { readonly rows: unknown; readonly count: number };
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.deepEqual(payload.rows, declaredRelationTriples({ sourceKind }));
      assert.equal(payload.count, declaredRelationTriples({ sourceKind }).length);
    }
    const filtered = await cell.run({ kind: "relation-triples", sourceKind: "decision", targetKind: "fact" }, binding);
    assert.deepEqual(
      (JSON.parse(String(filtered.evidence)) as { readonly rows: unknown }).rows,
      declaredRelationTriples({ sourceKind: "decision", targetKind: "fact" }),
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Relation actions serialize aggregate revisions and reject cycles and stale writers", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-action-"));
  initRepo(rootDir);
  const repoId = workspaceId("relation-action"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-action-test" });
  try {
    for (const [taskId, title] of [
      ["task_relation_a", "Relation A"],
      ["task_relation_b", "Relation B"],
      ["task_relation_c", "Relation C"],
    ] as const)
      assert.equal((await cell.run({ kind: "task-create", taskId, title }, binding)).outcome, "applied");

    const beforeMissingEndpoints = makeTaskEventReader({ repoId, rootDir }).read().events.length,
      missingSource = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: "task/missing_source",
          targetRef: "task/task_relation_b",
          relationType: "depends-on",
          rationale: "A missing source must not publish a relation.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(missingSource.outcome, "op_rejected", JSON.stringify(missingSource));
    assert.equal(missingSource.code, "entity_not_found", JSON.stringify(missingSource));
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().events.length, beforeMissingEndpoints);
    const missingTarget = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_relation_a",
        targetRef: "task/missing_target",
        relationType: "depends-on",
        rationale: "A missing target must not publish a relation.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(missingTarget.outcome, "op_rejected", JSON.stringify(missingTarget));
    assert.equal(missingTarget.code, "entity_not_found", JSON.stringify(missingTarget));
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().events.length, beforeMissingEndpoints);

    const missingAggregate = await cell.run(
      {
        kind: "relation-unrelate",
        relationId: deriveRelationId({
          source: "task/task_relation_a",
          target: "task/task_relation_c",
          type: "depends-on",
          direction: "directed",
        }),
        reason: "A never-created aggregate must explain its lookup cut.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(missingAggregate.outcome, "op_rejected", JSON.stringify(missingAggregate));
    assert.equal(missingAggregate.code, "entity_not_found", JSON.stringify(missingAggregate));
    assert.match(
      String(missingAggregate.rejectionExplanation),
      /^Relation \S+ is not an active aggregate \(looked up at projection watermark \d+, write head \d+\)\.$/u,
    );
    const aggregateCut = lookupCutOf(missingAggregate.rejectionExplanation);
    assert.ok(aggregateCut, JSON.stringify(missingAggregate.rejectionExplanation));
    assert.ok(aggregateCut.watermark <= aggregateCut.writeHead, JSON.stringify(aggregateCut));

    const identity = {
        source: "task/task_relation_a",
        target: "task/task_relation_b",
        type: "depends-on" as const,
        direction: "directed" as const,
      },
      relationId = deriveRelationId(identity),
      created = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: identity.source,
          targetRef: identity.target,
          relationType: identity.type,
          direction: identity.direction,
          origin: "declared",
          rationale: "A waits for B.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.deepEqual(JSON.parse(String(created.evidence)), {
      schema: "relation-action-history/v1",
      relationId,
      eventType: "relation_created",
      aggregateRevision: created.revision,
      executor: binding.actor.executor,
      executionId: null,
    });
    assert.match(String(created.evidence), /agent-relation-action/u);

    const cycle = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: identity.target,
        targetRef: identity.source,
        relationType: "depends-on",
        rationale: "B must not wait for A.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(cycle.outcome, "op_rejected");
    assert.equal(cycle.code, "relation_cycle");

    const stale = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: identity.source,
        targetRef: identity.target,
        relationType: identity.type,
        rationale: "A different writer supplied stale aggregate state.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
    const secondaryIdentity = {
        source: "task/task_relation_c",
        target: identity.target,
        type: "relates" as const,
        direction: "directed" as const,
      },
      secondaryId = deriveRelationId(secondaryIdentity),
      secondary = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: secondaryIdentity.source,
          targetRef: secondaryIdentity.target,
          relationType: secondaryIdentity.type,
          rationale: "C remains contextually related to B.",
          expectedVersion: 0,
        },
        binding,
      );
    assert.equal(secondary.outcome, "applied", JSON.stringify(secondary));
    assert.equal(
      makeTaskEventReader({ repoId, rootDir })
        .read()
        .events.filter((event) => event.schema === "relation-event/v1").length,
      2,
    );

    const currentGraph = await cell.run({ kind: "relation-list", freshness: "current" }, binding),
      currentRows = relationRows(currentGraph);
    assert.deepEqual(
      currentRows.map(({ relationId: id, strength }) => ({ id, strength })),
      [
        { id: relationId, strength: "strong" },
        { id: secondaryId, strength: "weak" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(
      currentRows.every(
        ({ targetObservedVersion, currentTargetVersion }) => targetObservedVersion === currentTargetVersion,
      ),
      true,
    );
    const eventCountBeforeTargetUpdate = makeTaskEventReader({ repoId, rootDir }).read().events.length,
      relationEventCountBeforeTargetUpdate = relationEventCount(rootDir, repoId),
      targetUpdated = await cell.run(
        {
          kind: "task-amend",
          taskId: "task_relation_b",
          patches: [{ field: "pinned", value: "true" }],
        },
        binding,
      );
    assert.equal(targetUpdated.outcome, "applied", JSON.stringify(targetUpdated));
    assert.equal(makeTaskEventReader({ repoId, rootDir }).read().events.length, eventCountBeforeTargetUpdate + 1);
    assert.equal(relationEventCount(rootDir, repoId), relationEventCountBeforeTargetUpdate);
    const suspectRows = relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding));
    // The depends-on edge follows the target's presence, so only the pinned-target `relates` edge turns suspect.
    assert.deepEqual(
      suspectRows.map(({ relationId: id }) => id),
      [secondaryId],
    );
    assert.equal(
      suspectRows.every(
        ({ targetObservedVersion, currentTargetVersion }) => targetObservedVersion !== currentTargetVersion,
      ),
      true,
    );

    const [nodeOne, nodeTwo] = await Promise.all([
        cell.run(
          {
            kind: "relation-reconfirm",
            relationId: secondaryId,
            rationale: "Node one reviewed the updated target.",
            expectedVersion: secondary.revision,
          },
          binding,
        ),
        cell.run(
          {
            kind: "relation-reconfirm",
            relationId: secondaryId,
            rationale: "Node two independently reviewed the updated target.",
            expectedVersion: secondary.revision,
          },
          secondNodeBinding,
        ),
      ]),
      reconfirmations = [nodeOne, nodeTwo],
      accepted = reconfirmations.find(({ outcome }) => outcome === "applied"),
      conflicted = reconfirmations.find(({ outcome }) => outcome === "op_rejected");
    assert.ok(accepted, JSON.stringify(reconfirmations));
    assert.equal(conflicted?.code, "version_conflict", JSON.stringify(reconfirmations));
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "current" }, binding)).length, 2);
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding)).length, 0);
    const sameResult = await cell.run(
      {
        kind: "relation-reconfirm",
        relationId: secondaryId,
        rationale: "The current witness was already reviewed.",
        expectedVersion: accepted.revision,
      },
      binding,
    );
    assert.equal(sameResult.outcome, "no_changes", JSON.stringify(sameResult));
    assert.equal((await cell.run({ kind: "projection-rebuild" }, binding)).outcome, "applied");
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "current" }, binding)).length, 2);
    assert.equal(relationRows(await cell.run({ kind: "relation-list", freshness: "suspect" }, binding)).length, 0);

    const retired = await cell.run(
      {
        kind: "relation-unrelate",
        relationId,
        reason: "B completed independently.",
        expectedVersion: created.revision,
      },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const graph = await cell.run({ kind: "relation-list", entity: identity.source }, binding),
      rows = (JSON.parse(String(graph.evidence)) as { rows: readonly { relationId: string; state: string }[] }).rows;
    assert.deepEqual(
      rows.map(({ relationId: id, state }) => ({ id, state })),
      [{ id: relationId, state: "retired" }],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a depends-on cycle at the end of a long chain is rejected, and converging paths or a deep acyclic walk are not cycles", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-relation-cycle-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("relation-cycle"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "relation-cycle-test",
  });
  const dependsOn = (source: string, target: string) =>
    cell.run(
      {
        kind: "relation-relate",
        sourceRef: `task/task_cycle_${source}`,
        targetRef: `task/task_cycle_${target}`,
        relationType: "depends-on",
        rationale: `${source} waits for ${target}.`,
        expectedVersion: 0,
      },
      binding,
    );
  try {
    const chain = Array.from({ length: 12 }, (_, index) => `c${index + 1}`);
    for (const name of ["a", "b", "c", "d", ...chain, "x"])
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: `task_cycle_${name}`, title: name }, binding)).outcome,
        "applied",
      );
    // a -> b -> c, and a -> d -> c: two paths converge on c, which then runs c -> c1 -> ... -> c12.
    for (const [source, target] of [
      ["a", "b"],
      ["b", "c"],
      ["a", "d"],
      ["d", "c"],
      ...["c", ...chain.slice(0, -1)].map((name, index) => [name, chain[index]!]),
    ])
      assert.equal((await dependsOn(source!, target!)).outcome, "applied", `${source} -> ${target}`);
    // d -> b closes no loop: b cannot reach d.
    assert.equal((await dependsOn("d", "b")).outcome, "applied");
    // x -> a closes no loop: the walk from a covers the whole 16-task graph and never meets x.
    assert.equal((await dependsOn("x", "a")).outcome, "applied");
    // c12 -> a closes a 15-hop loop through either path.
    const cycle = await dependsOn("c12", "a");
    assert.equal(cycle.outcome, "op_rejected", JSON.stringify(cycle));
    assert.equal(cycle.code, "relation_cycle");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function relationRows(receipt: { readonly evidence?: unknown }): readonly {
  readonly relationId: string;
  readonly strength: string;
  readonly targetObservedVersion: string | number | null;
  readonly currentTargetVersion: string | number | null;
}[] {
  return (
    JSON.parse(String(receipt.evidence)) as {
      readonly rows: readonly {
        readonly relationId: string;
        readonly strength: string;
        readonly targetObservedVersion: string | number | null;
        readonly currentTargetVersion: string | number | null;
      }[];
    }
  ).rows;
}

function lookupCutOf(explanation: unknown): { readonly watermark: number; readonly writeHead: number } | null {
  if (typeof explanation !== "string") return null;
  const match = /looked up at projection watermark (\d+), write head (\d+)\)\.$/u.exec(explanation);
  return match ? { watermark: Number(match[1]), writeHead: Number(match[2]) } : null;
}

function relationEventCount(rootDir: string, repoId: string): number {
  return makeTaskEventReader({ repoId, rootDir })
    .read()
    .events.filter((event) => event.schema === "relation-event/v1").length;
}
