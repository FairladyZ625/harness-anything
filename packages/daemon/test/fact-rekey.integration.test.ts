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
  deriveRelationId,
  eventObjectRelativePath,
  makeTaskEventStore,
  migrationImportWritePlan,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
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
    initRepo(scratch);
    const seedStore = makeTaskEventStore({ repoId: "fact-rekey-fixture", rootDir: scratch });
    const compiled = compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: "event-legacy-fact",
        workspaceRevision: 1,
        opId: "op-legacy-fact",
        type: "fact_recorded",
        actor,
        source: "local",
        occurredAt: "2026-01-02T00:00:00.000Z",
        taskId: "task_legacy",
        factId: "F-ABCDEFGH",
        payload: {
          statement: "Observed migration",
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
      workspaceRevision: 2,
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
    seedStore.append({ event: legacyRelationEvent, plan: migrationImportWritePlan(legacyRelationEvent), blobs: [] });
    await seedStore.drain();
    const legacyFactBody = readFileSync(path.join(scratch, "harness/tasks/task_legacy-old/facts.md"), "utf8");
    const legacyFactSha = sha256Text(legacyFactBody);
    const legacyBlobPath = path.join(scratch, "harness", contentObjectRelativePath(legacyFactSha, seedStore.layout()));
    mkdirSync(path.dirname(legacyBlobPath), { recursive: true });
    writeFileSync(legacyBlobPath, legacyFactBody);
    const legacyEvent = {
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
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
      workspaceRevision: 3,
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
    const legacyBody = serializePersistedCanonicalEvent(legacyEvent);
    const eventPath = path.join(scratch, "harness", eventObjectRelativePath(legacyEvent.opId, seedStore.layout()));
    mkdirSync(path.dirname(eventPath), { recursive: true });
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
    writeFileSync(relationEventPath, persistedRelationBody);
    const importedFactBody = serializePersistedCanonicalEvent(importedFactEvent),
      importedFactEventPath = path.join(
        scratch,
        "harness",
        eventObjectRelativePath(importedFactEvent.opId, seedStore.layout()),
      );
    mkdirSync(path.dirname(importedFactEventPath), { recursive: true });
    writeFileSync(importedFactEventPath, importedFactBody);
    writeFileSync(
      path.join(scratch, "harness/events/head.json"),
      serializeEventHead({
        revision: 3,
        opId: importedFactEvent.opId,
        eventDigest: `sha256:${sha256Text(importedFactBody)}`,
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
    const preview = (await cell.run({ kind: "fact-rekey", dryRun: true }, binding)) as Record<string, unknown>;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    const previewEvidence = JSON.parse(String(preview.evidence)) as { readonly counts: Record<string, number> };
    assert.equal(previewEvidence.counts.rekeyedFacts, 2);
    assert.equal(previewEvidence.counts.producesEdges, 2);
    assert.equal(previewEvidence.counts.retargetedRelations, 2);

    const applied = (await cell.run({ kind: "fact-rekey" }, binding)) as Record<string, unknown>;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-ABCDEFGH.md")), true);
    assert.equal(existsSync(path.join(scratch, "harness/facts/F-BCDEFGHJ.md")), true);
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
    const fact = store.read().events.find((event) => event.schema === "fact-event/v1");
    assert.equal(fact?.schema, "fact-event/v1");
    if (fact?.schema === "fact-event/v1") {
      assert.equal(fact.payload.factsDocumentClaim.path, "facts/F-ABCDEFGH.md");
      assert.equal(fact.payload.provenance[0]?.transcriptReachability, "by_session_id");
      const body = readFileSync(path.join(scratch, "harness/facts/F-ABCDEFGH.md"), "utf8");
      assert.equal(sha256Text(body), fact.payload.factsDocumentClaim.sha256);
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
    assert.equal(store.readHead()?.revision, 4);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
