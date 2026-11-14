import assert from "node:assert/strict";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { compileFactWrite, compileFactArchiveWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  compileDecisionWrite,
  decisionReviewContentDigest,
  reduceDecisionDocument,
} from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import type {
  DecisionDocumentState,
  DecisionEventDraftV1,
} from "@harness-anything/kernel/internal/domain/decision-event-types.ts";
import {
  compileRelationCreatedEvent,
  compileRelationRetiredEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import {
  deriveRelationId,
  relationStrengthForType,
  type EntityRelationRecord,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { CanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import {
  docSyncWritePlan,
  ledgerCommitSha,
  type DocEventV1,
  type DocumentState,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type { FactProjectionRow } from "@harness-anything/kernel";
import { fact, proposal, taskCreated, actor } from "./store/relation-graph-projection.fixtures.ts";

/** One event/claim contract, executed by real SQLite and PostgreSQL-dialect accepting stores. */
export async function assertTerminalMaterialization(input: {
  readonly append: (bundle: CanonicalWriteBundle) => void | Promise<unknown>;
  /** Replay a previously accepted historical write, bypassing today's canonical admission. */
  readonly replayAcceptedDocument?: (bundle: CanonicalWriteBundle) => void | Promise<unknown>;
  readonly document: (path: string) => DocumentState | null | Promise<DocumentState | null>;
  readonly history: (path: string) => DocumentState | null | Promise<DocumentState | null>;
  readonly fact: (id: string) => FactProjectionRow | null | Promise<FactProjectionRow | null>;
  readonly decision: (
    id: string,
  ) => { readonly materializationState: string } | null | Promise<{ readonly materializationState: string } | null>;
}) {
  let revision = 1;
  const append = async (bundle: CanonicalWriteBundle) => {
      await input.append(bundle);
      revision++;
    },
    taskId = "task-materialization-holder",
    factId = "F-DEADBEEF",
    factPath = `facts/${factId}.md`,
    decisionId = "dec_MATERIALIZATION_HOLDER",
    targetId = "dec_MATERIALIZATION_TARGET",
    decisions = new Map<string, { state: DecisionDocumentState; body: string; sha256: string }>(),
    relations: EntityRelationRecord[] = [];
  const decision = async (draft: DecisionEventDraftV1, blobs: CanonicalWriteBundle["blobs"] = []) => {
    const previous = decisions.get(draft.decisionId),
      compiled = compileDecisionWrite({
        event:
          draft.type === "decision_proposed"
            ? { ...draft, payload: { ...draft.payload, provenance: fact(revision).payload.provenance } }
            : draft,
        currentDecision: previous?.state ?? null,
        currentRelations: relations.filter(
          (relation) =>
            relation.state === "active" &&
            (relation.source === `decision/${draft.decisionId}` ||
              relation.source.startsWith(`decision/${draft.decisionId}/`)),
        ),
        currentDocument: previous ? { blobSha256: previous.sha256, body: previous.body } : null,
        decisionReviewRequirement: "off",
      });
    await append({ ...compiled, blobs: [...compiled.blobs, ...blobs] });
    decisions.set(draft.decisionId, {
      state: reduceDecisionDocument(previous?.state ?? null, compiled.event),
      body: compiled.body,
      sha256: compiled.event.payload.decisionDocumentClaim.sha256,
    });
  };
  const relate = async (
    source: string,
    type: "produces" | "evidenced-by" | "implements" | "derives",
    target: string,
  ) => {
    const identity = { source, type, target, direction: "directed" as const },
      relation: EntityRelationRecord = {
        relation_id: deriveRelationId(identity),
        ...identity,
        strength: relationStrengthForType(type),
        origin: "declared",
        state: "active",
        rationale: "materialization hold",
      },
      event = compileRelationCreatedEvent({
        record: {
          relation_id: relation.relation_id,
          source: relation.source,
          target: relation.target,
          type: relation.type,
          direction: relation.direction,
          origin: relation.origin,
          state: relation.state,
          rationale: relation.rationale,
          targetObservedVersion: null,
        },
        actor,
        source: "local",
        opId: `op-${revision}`,
        workspaceRevision: revision,
        occurredAt: "2026-08-13T00:00:00.000Z",
      });
    await append({ event, plan: relationEventWritePlan(event), blobs: [] });
    relations.push(relation);
    return event.relationId;
  };
  const retire = async (relationId: string) => {
    const event = compileRelationRetiredEvent({
      relationId,
      reason: "release",
      actor,
      source: "local",
      opId: `op-${revision}`,
      workspaceRevision: revision,
      occurredAt: "2026-08-13T00:00:00.000Z",
    });
    await append({ event, plan: relationEventWritePlan(event), blobs: [] });
    const index = relations.findIndex((relation) => relation.relation_id === relationId);
    if (index >= 0) relations[index] = { ...relations[index]!, state: "retired" };
  };
  const reject = (id: string): DecisionEventDraftV1 => ({
    ...proposal(revision, id),
    type: "decision_rejected",
    payload: { reason: "terminal materialization fixture" },
    actor: { principal: { personId: "arbiter" }, executor: null },
  });
  const created = taskCreated(revision, taskId);
  if (created.type !== "task_created") throw new Error("expected task_created fixture");
  await append({ event: created, plan: taskLifecycleWritePlan(created), blobs: [] });
  await decision(proposal(revision, decisionId));
  await decision(proposal(revision, targetId));
  const observation = fact(revision),
    recorded = compileFactWrite({ event: observation });
  await append(recorded);
  const taskHold = await relate(`task/${taskId}`, "produces", `fact/${factId}`);
  await relate(`decision/${decisionId}`, "evidenced-by", `fact/${factId}`);
  await append(
    compileFactArchiveWrite({
      event: {
        ...fact(revision),
        type: "fact_archived",
        payload: { ...observation.payload, archiveReason: "archive while held" },
      },
      retiredDocumentSha256: recorded.event.payload.factsDocumentClaim!.sha256,
    }),
  );
  assert.ok(await input.document(factPath), "two active canonical holds block premature retirement");
  await retire(taskHold);
  assert.ok(await input.document(factPath), "one remaining proposed Decision still holds the Fact");
  await decision(reject(decisionId));
  assert.equal(await input.document(factPath), null, "Decision terminal transition automatically unlocks its Fact");
  assert.equal((await input.history(factPath))?.body, recorded.body, "retirement preserves content");
  assert.equal((await input.fact(factId))?.materializationState, "dematerialized_terminal");

  const derives = await relate(`decision/${targetId}/CH1`, "derives", `task/${taskId}`);
  await relate(`task/${taskId}`, "implements", `decision/${targetId}/CH1`);
  const reportPath = `decisions/decision-${targetId}/artifacts/review.md`,
    reportBody = "# Review\n\nThe original evidence remains available after retirement.\n",
    report = { sha256: sha256Text(reportBody), size: Buffer.byteLength(reportBody), mediaType: "text/markdown" };
  await decision(
    {
      ...proposal(revision, targetId),
      type: "decision_review_recorded",
      payload: {
        reviewId: "review-materialization",
        reviewContentDigest: decisionReviewContentDigest(
          {
            ...decisions.get(targetId)!.state,
            relations: relations.filter(
              (relation) =>
                relation.state === "active" &&
                (relation.source === `decision/${targetId}` || relation.source.startsWith(`decision/${targetId}/`)),
            ),
          },
          decisions.get(targetId)!.body,
        ),
        verdict: "approved",
        reason: "Verified materialization boundary",
        findings: [],
        evidenceChecked: ["CH1"],
        reportRef: reportPath,
        carriedDocumentClaims: [
          {
            path: reportPath,
            baseBlobSha256: null,
            candidate: report,
            policyId: "opaque-textual-whole-file/v1",
            regionProofs: [],
          },
        ],
      },
    },
    [{ ...report, body: reportBody }],
  );
  await decision(reject(targetId));
  const targetPath = `decisions/decision-${targetId}/decision.md`;
  assert.ok(await input.document(targetPath), "outgoing derives and incoming implements use clause-normalized holds");
  assert.equal((await input.document(reportPath))?.body, reportBody, "carried review stays with a held Decision");
  await retire(derives);
  assert.ok(await input.document(targetPath), "implements keeps a rejected Decision materialized");
  const taskDocumentPath = `tasks/${taskId}-cycle-task/closeout.md`,
    taskDocumentBody = "# Task closeout\n",
    taskCandidate = {
      sha256: sha256Text(taskDocumentBody),
      size: Buffer.byteLength(taskDocumentBody),
      mediaType: "text/markdown",
    };
  const cancelled = {
    ...created,
    workspaceRevision: revision,
    eventId: `event-${revision}`,
    opId: `op-${revision}`,
    type: "task_transitioned" as const,
    payload: {
      task: { ...created.payload.task, status: "cancelled" as const },
      mutation: { command: "transition", reason: "release final implements hold", fields: ["status"] },
      documentClaims: [],
      carriedDocumentClaims: [
        {
          path: taskDocumentPath,
          baseBlobSha256: null,
          candidate: taskCandidate,
          policyId: "opaque-textual-whole-file/v1",
          regionProofs: [],
        },
      ],
    },
  };
  await append({
    event: cancelled,
    plan: taskLifecycleWritePlan(cancelled),
    blobs: [{ ...taskCandidate, body: taskDocumentBody }],
  });
  assert.equal(
    await input.document(targetPath),
    null,
    "Task cancellation unlocks the last hold without retiring the relation",
  );
  assert.equal((await input.decision(targetId))?.materializationState, "dematerialized_terminal");
  assert.match((await input.history(targetPath))?.body ?? "", /rejected/u);
  assert.equal(await input.document(reportPath), null, "last hold removal also retires the carried review");
  assert.equal((await input.history(reportPath))?.body, reportBody, "carried review remains in object history");

  const oldDraft = { ...fact(revision), factId: "F-00000001" },
    old = compileFactWrite({ event: oldDraft });
  await append(old);
  const replacement = compileFactWrite({
    event: {
      ...fact(revision),
      factId: "F-00000002",
      payload: { ...oldDraft.payload, supersedes: { factRef: "fact/F-00000001", rationale: "new evidence" } },
    },
    supersededFact: {
      factId: oldDraft.factId,
      baseDocumentSha256: old.event.payload.factsDocumentClaim!.sha256,
      taskId: oldDraft.taskId,
      ...oldDraft.payload,
    },
  });
  await append(replacement);
  assert.equal(await input.document(old.path), null, "unheld superseded Fact is absent from the active working set");
  assert.ok(await input.history(old.path));
  assert.equal((await input.fact(oldDraft.factId))?.materializationState, "dematerialized_terminal");

  // Old ledgers contain generic writes accepted after retirement. Their base is still the
  // logical document head, even though it now lives outside the active working-set index.
  if (input.replayAcceptedDocument)
    for (const path of [targetPath, reportPath, old.path, taskDocumentPath]) {
      const previous = await input.history(path);
      assert.ok(previous);
      const body = `${previous.body}\nHistorical accepted update.\n`,
        candidate = { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: previous.mediaType },
        event: DocEventV1 = {
          schema: "doc-event/v1",
          type: "documents_written",
          eventId: `event-${revision}`,
          opId: `op-${revision}`,
          workspaceRevision: revision++,
          actor,
          source: "local",
          occurredAt: "2026-08-13T00:00:00.000Z",
          payload: {
            executionId: null,
            baseLedgerSha: ledgerCommitSha("terminal-materialization", "a".repeat(40)),
            changes: [
              {
                path: previous.path,
                baseBlobSha256: previous.blobSha256,
                candidate,
                policyId: previous.policyId,
                regionProofs: [],
              },
            ],
          },
        };
      await input.replayAcceptedDocument({ event, plan: docSyncWritePlan(event), blobs: [{ ...candidate, body }] });
      assert.equal(await input.document(path), null, "replay must not resurrect a terminal document");
      assert.equal((await input.history(path))?.body, body, "history advances to the accepted content");
    }
  if (input.replayAcceptedDocument) {
    const previous = await input.history(taskDocumentPath);
    assert.ok(previous);
    const body = `${previous.body}\nHistorical carried update.\n`,
      candidate = { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: previous.mediaType },
      event = {
        ...cancelled,
        eventId: `event-${revision}`,
        opId: `op-${revision}`,
        workspaceRevision: revision++,
        type: "task_amended" as const,
        payload: {
          ...cancelled.payload,
          mutation: { command: "amend", reason: "historical prose update", fields: ["title"] },
          carriedDocumentClaims: [
            {
              path: taskDocumentPath,
              baseBlobSha256: previous.blobSha256,
              candidate,
              policyId: previous.policyId,
              regionProofs: [],
            },
          ],
        },
      };
    await input.replayAcceptedDocument({ event, plan: taskLifecycleWritePlan(event), blobs: [{ ...candidate, body }] });
    assert.equal(await input.document(taskDocumentPath), null);
    assert.equal((await input.history(taskDocumentPath))?.body, body, "Task carried claims also use the logical head");
  }
}
