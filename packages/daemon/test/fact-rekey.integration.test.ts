// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileFactWrite,
  contentObjectRelativePath,
  decisionMachineDigest,
  deriveRelationId,
  eventObjectRelativePath,
  makeTaskEventStore,
  makeTaskProjection,
  renderDecisionDocument,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
  type DecisionDocumentState,
  type DecisionEventV1,
  type MigrationImportEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { actor, initRepo, legacyFixture } from "./migration-import.fixtures.ts";

test("fact rekey migrates task-local documents, relations, and is idempotent", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-fact-rekey-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    legacyFixture(scratch);
    const legacyFactsPath = path.join(scratch, "harness/tasks/task_legacy-old/facts.md");
    writeFileSync(
      legacyFactsPath,
      `${readFileSync(legacyFactsPath, "utf8")}\n- {fact_id: F-CDEFGHJK, statement: Document-only observation, source: legacy-test, observedAt: 2026-01-04T00:00:00.000Z, confidence: medium, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: docs-only, boundAt: 2026-01-04T00:00:00.000Z}]}\n`,
    );
    const crossTaskFactsPath = path.join(scratch, "harness/tasks/task_other-old/facts.md");
    mkdirSync(path.dirname(crossTaskFactsPath), { recursive: true });
    writeFileSync(path.join(path.dirname(crossTaskFactsPath), "INDEX.md"), "---\ntask_id: task_other\n---\n");
    writeFileSync(
      crossTaskFactsPath,
      "# Facts\n\n- {fact_id: F-DEFGHJKM, statement: Cross-task target, source: legacy-test, observedAt: 2026-01-04T01:00:00.000Z, confidence: medium, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: docs-only, boundAt: 2026-01-04T01:00:00.000Z}]}\n",
    );
    initRepo(scratch);
    const seedStore = makeTaskEventStore({ repoId: "fact-rekey-fixture", rootDir: scratch });
    const compiled = compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: "event-legacy-target",
        workspaceRevision: 1,
        opId: "op-legacy-target",
        type: "fact_recorded",
        actor,
        source: "local",
        occurredAt: "2026-01-02T00:00:00.000Z",
        taskId: "task_other",
        factId: "F-DEFGHJKM",
        payload: {
          statement: "Cross-task target",
          evidenceSource: "legacy-test",
          observedAt: "2026-01-02T00:00:00.000Z",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: ["pattern"],
          provenance: [
            {
              runtime: "codex",
              sessionId: "legacy-session",
              transcriptReachability: "by_session_id",
              boundAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        },
      },
    });
    seedStore.append(compiled);
    const legacyRelationEvent: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-legacy-relation",
      workspaceRevision: 3,
      opId: "op-legacy-relation",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-01-02T00:00:00.000Z",
      payload: {
        migratedFrom: "rel_legacy",
        generation: "v0",
        entity: {
          kind: "relation",
          ownerRef: "decision/dec_LEGACY",
          relation: {
            relation_id: deriveRelationId({
              source: "decision/dec_LEGACY/C1",
              target: "fact/task_legacy/F-ABCDEFGH",
              type: "evidenced-by",
              direction: "directed",
            }),
            source: "decision/dec_LEGACY/C1",
            target: "fact/task_legacy/F-ABCDEFGH",
            type: "evidenced-by",
            direction: "directed",
            strength: "strong",
            origin: "imported_snapshot",
            state: "active",
            rationale: "legacy evidence",
          },
        },
      },
    };
    await seedStore.drain();
    const legacyFactBody = readFileSync(path.join(scratch, "harness/tasks/task_legacy-old/facts.md"), "utf8");
    const legacyFactSha = sha256Text(legacyFactBody);
    const crossTaskFactBody = readFileSync(crossTaskFactsPath, "utf8");
    const crossTaskFactSha = sha256Text(crossTaskFactBody);
    const legacyBlobPath = path.join(scratch, "harness", contentObjectRelativePath(legacyFactSha, seedStore.layout()));
    mkdirSync(path.dirname(legacyBlobPath), { recursive: true });
    writeFileSync(legacyBlobPath, legacyFactBody);
    const crossTaskBlobPath = path.join(
      scratch,
      "harness",
      contentObjectRelativePath(crossTaskFactSha, seedStore.layout()),
    );
    mkdirSync(path.dirname(crossTaskBlobPath), { recursive: true });
    writeFileSync(crossTaskBlobPath, crossTaskFactBody);
    const legacyTarget = {
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
        factsDocumentClaim: {
          ...compiled.event.payload.factsDocumentClaim,
          path: "tasks/task_other-old/facts.md",
          sha256: crossTaskFactSha,
          size: Buffer.byteLength(crossTaskFactBody),
        },
      },
    };
    const legacyEvent = {
      ...compiled.event,
      eventId: "event-legacy-fact",
      workspaceRevision: 2,
      opId: "op-legacy-fact",
      taskId: "task_legacy",
      factId: "F-ABCDEFGH",
      payload: {
        ...compiled.event.payload,
        statement: "Observed migration",
        supersedes: {
          factRef: "fact/task_other/F-DEFGHJKM",
          rationale: "The legacy fact supersedes a fact owned by another task.",
        },
        provenance: [{ runtime: "codex", sessionId: "legacy-session", boundAt: "2026-01-02T00:00:00.000Z" }] as never,
        factsDocumentClaim: {
          ...compiled.event.payload.factsDocumentClaim,
          path: "tasks/task_legacy-old/facts.md",
          sha256: legacyFactSha,
          size: Buffer.byteLength(legacyFactBody),
        },
      },
    };
    const importedFactEvent: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-imported-legacy-fact",
      workspaceRevision: 4,
      opId: "op-imported-legacy-fact",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-01-03T00:00:00.000Z",
      payload: {
        migratedFrom: "fact/task_legacy/F-BCDEFGHJ",
        generation: "v0",
        entity: {
          kind: "fact",
          fact: {
            taskId: "task_legacy",
            factId: "F-BCDEFGHJ",
            statement: "Imported observation without a matching task document row",
            evidenceSource: "legacy-import-test",
            observedAt: "2026-01-03T00:00:00Z",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: ["pattern"],
            provenance: [
              {
                runtime: "codex",
                sessionId: "legacy-import-session",
                boundAt: "2026-01-03T00:00:00.000Z",
              },
            ],
          },
          documentClaim: {
            path: "tasks/task_legacy-old/facts.md",
            sha256: legacyFactSha,
            size: Buffer.byteLength(legacyFactBody),
            mediaType: "text/markdown",
            policyId: "typed-migration-import/v1",
          },
        },
      },
    };
    const importedDecision: DecisionDocumentState = {
      decisionId: "dec_IMPORTED_REKEY",
      state: "in_effect",
      title: "Imported decision",
      question: "Should imported decisions retain valid proof pins?",
      riskTier: "low",
      urgency: "low",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["kernel"], productLines: [] },
      proposer: actor,
      arbiter: actor,
      proposedAt: "2026-01-01T00:00:00.000Z",
      decidedAt: "2026-01-02T00:00:00.000Z",
      workspaceRevision: 5,
      chosen: [{ id: "CH1", text: "Retain valid proof pins" }],
      rejected: [{ id: "RJ1", text: "Drop proof pins", whyNot: "The projection rejects stale proof" }],
      claims: [{ id: "C1", text: "Imported proof remains valid", loadBearing: true, fulfillment: null }],
      relations: [],
      provenance: [],
      judgmentConsents: [],
    };
    const importedDecisionBody = renderDecisionDocument(
        importedDecision,
        null,
        "# Imported decision\n\nHistorical body.\n",
      ),
      importedDecisionClaim = {
        path: "decisions/decision-dec_IMPORTED_REKEY/decision.md",
        sha256: sha256Text(importedDecisionBody),
        size: Buffer.byteLength(importedDecisionBody),
        mediaType: "text/markdown" as const,
        policyId: "typed-migration-import/v1" as const,
      },
      retiredDecisionClaim = {
        ...importedDecisionClaim,
        policyId: "markdown-body-replaceable/v1" as const,
      },
      importedDecisionEvent: MigrationImportEventV1 = {
        schema: "migration-import-event/v1",
        eventId: "event-imported-decision",
        workspaceRevision: 5,
        opId: "op-imported-decision",
        type: "entity_migrated",
        actor,
        source: "migration-import/v1",
        occurredAt: "2026-01-02T00:00:00.000Z",
        payload: {
          migratedFrom: importedDecision.decisionId,
          generation: "v0",
          entity: { kind: "decision", decision: importedDecision, documentClaim: importedDecisionClaim },
        },
      };
    const retiredEventBase = {
      schema: "decision-event/v1" as const,
      eventId: "event-retire-imported-decision",
      workspaceRevision: 6,
      opId: "op-retire-imported-decision",
      type: "decision_retired" as const,
      actor,
      source: "local" as const,
      occurredAt: "2026-01-03T00:00:00.000Z",
      decisionId: importedDecision.decisionId,
      payload: {
        reason: "Retired during legacy migration",
        baseDocumentSha256: importedDecisionClaim.sha256,
        decisionDocumentClaim: retiredDecisionClaim,
        contentPin: {
          schema: "decision-content-pin/v1" as const,
          pinId: `dcp_${sha256Text("op-retire-imported-decision").slice(0, 26)}`,
          action: "retire" as const,
          state: importedDecision.state,
          pinnedAt: "2026-01-03T00:00:00.000Z",
          evidence: "Retired during legacy migration",
          actor,
          digest: decisionMachineDigest(importedDecision),
        },
      },
    } as unknown as DecisionEventV1;
    // The source event intentionally carries the pre-migration pin. Rekey must repin it
    // from the imported snapshot before projection admission validates the retired outcome.
    const retiredEvent = retiredEventBase;
    const legacyBody = `${JSON.stringify(legacyEvent)}\n`;
    const targetEventPath = path.join(
      scratch,
      "harness",
      eventObjectRelativePath(legacyTarget.opId, seedStore.layout()),
    );
    const eventPath = path.join(scratch, "harness", eventObjectRelativePath(legacyEvent.opId, seedStore.layout()));
    mkdirSync(path.dirname(eventPath), { recursive: true });
    writeFileSync(targetEventPath, `${JSON.stringify(legacyTarget)}\n`);
    writeFileSync(eventPath, legacyBody);
    const persistedRelationEvent = {
        ...legacyRelationEvent,
        occurredAt: "2026-01-02T08:00:00+08:00",
      } as MigrationImportEventV1,
      persistedRelationBody = serializePersistedCanonicalEvent(persistedRelationEvent),
      relationEventPath = path.join(
        scratch,
        "harness",
        eventObjectRelativePath(legacyRelationEvent.opId, seedStore.layout()),
      );
    mkdirSync(path.dirname(relationEventPath), { recursive: true });
    writeFileSync(relationEventPath, persistedRelationBody);
    const importedFactBody = serializePersistedCanonicalEvent(importedFactEvent),
      importedFactEventPath = path.join(
        scratch,
        "harness",
        eventObjectRelativePath(importedFactEvent.opId, seedStore.layout()),
      );
    mkdirSync(path.dirname(importedFactEventPath), { recursive: true });
    writeFileSync(importedFactEventPath, importedFactBody);
    const importedDecisionBodyEvent = serializePersistedCanonicalEvent(importedDecisionEvent),
      importedDecisionEventPath = path.join(
        scratch,
        "harness",
        eventObjectRelativePath(importedDecisionEvent.opId, seedStore.layout()),
      ),
      retiredBody = serializePersistedCanonicalEvent(retiredEvent),
      retiredEventPath = path.join(scratch, "harness", eventObjectRelativePath(retiredEvent.opId, seedStore.layout())),
      importedDecisionContentPath = path.join(
        scratch,
        "harness",
        contentObjectRelativePath(importedDecisionClaim.sha256, seedStore.layout()),
      );
    mkdirSync(path.dirname(importedDecisionEventPath), { recursive: true });
    mkdirSync(path.dirname(retiredEventPath), { recursive: true });
    writeFileSync(importedDecisionEventPath, importedDecisionBodyEvent);
    writeFileSync(retiredEventPath, retiredBody);
    mkdirSync(path.dirname(importedDecisionContentPath), { recursive: true });
    writeFileSync(importedDecisionContentPath, importedDecisionBody);
    writeFileSync(
      path.join(scratch, "harness/events/head.json"),
      serializeEventHead({
        revision: 6,
        opId: retiredEvent.opId,
        eventDigest: `sha256:${sha256Text(retiredBody)}`,
      }),
    );
    execFileSync("git", ["-C", scratch, "add", "harness/events", "harness/objects"]);
    execFileSync("git", ["-C", scratch, "commit", "-qm", "legacy fact event fixture"]);
    const legacyCommit = execFileSync("git", ["-C", scratch, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", scratch, "update-ref", "refs/ha/canonical", legacyCommit]);
    cell = await openRepoCell({
      repoId: workspaceId("fact-rekey-fixture"),
      rootDir: canonicalRoot(scratch),
      ownerId: "fact-rekey-test",
      now: () => "2026-08-28T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    const blockedRead = (await cell.run({ kind: "task-list" }, binding)) as Record<string, unknown>;
    assert.equal(blockedRead.outcome, "op_rejected", JSON.stringify(blockedRead));
    assert.equal(cell.status().state, "unavailable");
    const preview = (await cell.run({ kind: "fact-rekey", dryRun: true }, binding)) as Record<string, unknown>;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    const previewEvidence = JSON.parse(String(preview.evidence)) as { readonly counts: Record<string, number> };
    assert.equal(previewEvidence.counts.rekeyedFacts, 4);
    assert.equal(previewEvidence.counts.producesEdges, 4);
    assert.equal(previewEvidence.counts.retargetedRelations, 2);

    const applied = (await cell.run({ kind: "fact-rekey" }, binding)) as Record<string, unknown>;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-ABCDEFGH.md")), true);
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-BCDEFGHJ.md")), true);
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-CDEFGHJK.md")), true);
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-DEFGHJKM.md")), true);
    assert.equal(existsSync(path.join(scratch, "harness/tasks/task_legacy-old/facts.md")), false);
    assert.doesNotMatch(
      readFileSync(path.join(scratch, "harness/decisions/decision-dec_LEGACY/decision.md"), "utf8"),
      /fact\/task_legacy\/F-ABCDEFGH/u,
    );
    assert.match(
      readFileSync(path.join(scratch, "harness/decisions/decision-dec_LEGACY/decision.md"), "utf8"),
      /fact\/F-ABCDEFGH/u,
    );
    const store = makeTaskEventStore({ repoId: "fact-rekey-fixture", rootDir: scratch });
    const stream = store.read();
    const marker = stream.events.find(
      (event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "id-map",
    );
    assert.equal(marker?.workspaceRevision, 11);
    assert.equal(marker?.schema === "migration-import-event/v1" ? marker.payload.ledgerEpoch : undefined, 1);
    assert.equal(
      stream.events.some((event) => event.schema === "doc-event/v1" && event.workspaceRevision === 8),
      true,
    );
    assert.equal(stream.events.filter((event) => event.schema === "doc-event/v1").length, 3);
    const rewrittenRetired = stream.events.find(
      (event) => event.schema === "decision-event/v1" && event.opId === retiredEvent.opId,
    );
    assert.equal(rewrittenRetired?.schema, "decision-event/v1");
    if (rewrittenRetired?.schema === "decision-event/v1") {
      assert.equal(rewrittenRetired.payload.contentPin?.state, "outcome_retired");
      assert.equal(
        rewrittenRetired.payload.contentPin?.digest,
        decisionMachineDigest({
          ...importedDecision,
          state: "outcome_retired",
          decidedAt: retiredEvent.occurredAt,
          workspaceRevision: retiredEvent.workspaceRevision,
        }),
      );
    }
    assert.equal(
      stream.events.some((event) => event.schema === "fact-event/v1" && event.factId === "F-CDEFGHJK"),
      true,
    );
    const projection = makeTaskProjection({ rootDir: scratch, eventStore: store });
    try {
      const projected = projection.readDocument("decisions/decision-dec_LEGACY/decision.md");
      assert.equal(projected.status, "ready");
      assert.equal(projected.document?.workspaceRevision, 8);
      assert.equal(
        projected.document?.body,
        readFileSync(path.join(scratch, "harness/decisions/decision-dec_LEGACY/decision.md"), "utf8"),
      );
      assert.match(projected.document?.body ?? "", /fact\/F-ABCDEFGH/u);
    } finally {
      projection.close();
    }
    const fact = store.read().events.find((event) => event.schema === "fact-event/v1" && event.factId === "F-ABCDEFGH");
    assert.equal(fact?.schema, "fact-event/v1");
    if (fact?.schema === "fact-event/v1") {
      assert.equal(fact.payload.factsDocumentClaim.path, "facts/F-ABCDEFGH.md");
      assert.equal(fact.payload.provenance[0]?.transcriptReachability, "by_session_id");
      const body = readFileSync(path.join(scratch, "harness/facts/F-ABCDEFGH.md"), "utf8");
      assert.equal(sha256Text(body), fact.payload.factsDocumentClaim.sha256);
      assert.equal(fact.payload.supersedes?.factRef, "fact/F-DEFGHJKM");
    }
    const relationEvent = store.readEvent(legacyRelationEvent.opId);
    assert.equal(relationEvent?.schema, "migration-import-event/v1");
    if (relationEvent?.schema === "migration-import-event/v1" && relationEvent.payload.entity.kind === "relation") {
      assert.equal(relationEvent.occurredAt, persistedRelationEvent.occurredAt);
      assert.equal(relationEvent.payload.entity.relation.target, "fact/F-ABCDEFGH");
    }
    const importedFact = store.readEvent(importedFactEvent.opId);
    assert.equal(importedFact?.schema, "migration-import-event/v1");
    if (importedFact?.schema === "migration-import-event/v1" && importedFact.payload.entity.kind === "fact") {
      assert.equal(importedFact.payload.migratedFrom, "fact/F-BCDEFGHJ");
      assert.equal(importedFact.payload.entity.documentClaim.path, "facts/F-BCDEFGHJ.md");
      const body = readFileSync(path.join(scratch, "harness/facts/F-BCDEFGHJ.md"), "utf8");
      assert.equal(sha256Text(body), importedFact.payload.entity.documentClaim.sha256);
    }

    const repeat = (await cell.run({ kind: "fact-rekey" }, binding)) as Record<string, unknown>;
    assert.equal(repeat.outcome, "no_changes", JSON.stringify(repeat));
    assert.equal(store.readHead()?.revision, 11);
  } finally {
    await cell?.close();
    if (process.env.KEEP_FACT_REKEY_FIXTURE === "1") console.error(`fact-rekey fixture: ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
});
