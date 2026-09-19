// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FactEventV1 } from "../../src/domain/fact-event.ts";
import {
  createFactProjectionTables,
  FactProjectionError,
  readFactRow,
  reduceFactEvent,
} from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

const actor = { principal: { personId: "fact-admission" }, executor: null } as const;

test("Fact admission accepts superseding a standing target", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    reduceFactEvent(db, fact(2, "F-BCDEFGHJ", "fact/F-ABCDEFGH"));
    assert.equal(readFactRow(db, "F-ABCDEFGH")?.state, "superseded_fact");
    assert.equal(readFactRow(db, "F-BCDEFGHJ")?.state, "standing");
  } finally {
    db.close();
  }
});

test("Fact admission rejects superseding an already-superseded target", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    reduceFactEvent(db, fact(2, "F-BCDEFGHJ", "fact/F-ABCDEFGH"));
    assert.throws(
      () => reduceFactEvent(db, fact(3, "F-CDEFGHJK", "fact/F-ABCDEFGH")),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "relation_invalid" &&
        /already superseded/u.test(error.message),
    );
  } finally {
    db.close();
  }
});

test("Fact admission names an unregistered domain type instead of a relation failure", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    assert.throws(
      () => reduceFactEvent(db, fact(2, "F-BCDEFGHJ", undefined, ["architecture"])),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "fact_type_unregistered" &&
        /Fact domain type architecture is not registered/u.test(error.message),
    );
  } finally {
    db.close();
  }
});

test("Fact admission lists the registered domain types when rejecting an unregistered one", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    assert.throws(
      () => reduceFactEvent(db, fact(1, "F-ABCDEFGH", undefined, ["observation"])),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "fact_type_unregistered" &&
        /Fact domain type observation is not registered\. Registered: none yet\./u.test(
          (error as FactProjectionError).message,
        ),
    );
    const registration = fact(2, "F-BCDEFGHJ");
    reduceFactEvent(db, {
      ...registration,
      payload: { ...registration.payload, registersDomainType: "verification" },
    });
    assert.throws(
      () => reduceFactEvent(db, fact(3, "F-CDEFGHJK", undefined, ["observation"])),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "fact_type_unregistered" &&
        /Fact domain type observation is not registered\. Registered: verification\./u.test(
          (error as FactProjectionError).message,
        ),
    );
  } finally {
    db.close();
  }
});

function fact(revision: number, factId: string, supersedesRef?: string, domainTypes?: string[]): FactEventV1 {
  return {
    schema: "fact-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: "task-fact",
    factId,
    type: "fact_recorded",
    actor,
    source: "local",
    occurredAt: "2026-08-18T00:00:00.000Z",
    payload: {
      statement: `Fact ${factId}`,
      evidenceSource: "admission test",
      observedAt: "2026-08-18T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      provenance: [],
      ...(domainTypes ? { domainTypes } : {}),
      ...(supersedesRef
        ? { supersedes: { factRef: supersedesRef, rationale: "New observation replaces the target." } }
        : {}),
      factsDocumentClaim: {
        path: `facts/${factId}.md`,
        sha256: "0".repeat(64),
        size: 0,
        mediaType: "text/markdown",
        policyId: "typed-machine-writer/v1",
      },
    },
  };
}

test("Fact archive toggles the archived flag and rejects repeat or premature transitions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    reduceFactEvent(db, fact(1, "F-ABCDEFGH"));
    assert.equal(readFactRow(db, "F-ABCDEFGH")?.archived, false);

    assert.throws(
      () => reduceFactEvent(db, archive(2, "F-ABCDEFGH", "fact_unarchived")),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "invalid_transition" &&
        /not archived/u.test(error.message),
    );
    assert.throws(
      () => reduceFactEvent(db, archive(2, "F-BCDEFGHJ", "fact_archived")),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "entity_not_found" &&
        /does not exist/u.test(error.message),
    );

    reduceFactEvent(db, archive(2, "F-ABCDEFGH", "fact_archived"));
    const archivedRow = readFactRow(db, "F-ABCDEFGH");
    assert.equal(archivedRow?.archived, true);
    assert.equal(archivedRow?.state, "standing");
    assert.equal(archivedRow?.statement, "Fact F-ABCDEFGH");

    assert.throws(
      () => reduceFactEvent(db, archive(3, "F-ABCDEFGH", "fact_archived")),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "invalid_transition" &&
        /already archived/u.test(error.message),
    );
    assert.throws(
      () => reduceFactEvent(db, reclassify(3, "F-ABCDEFGH")),
      (error: unknown) =>
        error instanceof FactProjectionError &&
        error.code === "invalid_transition" &&
        /archived; unarchive/u.test(error.message),
    );

    reduceFactEvent(db, archive(3, "F-ABCDEFGH", "fact_unarchived"));
    const restored = readFactRow(db, "F-ABCDEFGH");
    assert.equal(restored?.archived, false);
    assert.equal(restored?.state, "standing");
  } finally {
    db.close();
  }
});

function archive(revision: number, factId: string, type: "fact_archived" | "fact_unarchived"): FactEventV1 {
  const recorded = fact(revision, factId);
  return {
    ...recorded,
    type,
    payload: {
      ...recorded.payload,
      archiveReason: "admission test",
      ...(type === "fact_archived"
        ? { factsDocumentRetirement: { path: `facts/${factId}.md`, sha256: "0".repeat(64) } }
        : {}),
    },
  };
}

function reclassify(revision: number, factId: string): FactEventV1 {
  const recorded = fact(revision, factId);
  return {
    ...recorded,
    type: "fact_reclassified",
    payload: { ...recorded.payload, reclassificationRationale: "admission test", domainTypes: ["closeout"] },
  };
}
