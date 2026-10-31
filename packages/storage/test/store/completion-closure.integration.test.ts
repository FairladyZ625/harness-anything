// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completionClosureFixture } from "./completion-closure.fixture.ts";
import { planCompletionGeneration } from "../../src/store/completion-generation-plan.ts";
import {
  writeCompletionGeneration,
  verifyCompletionGeneration,
  completionConversionStream,
} from "../../src/store/completion-generation-target.ts";
import {
  openSqliteEventStore,
  openUnactivatedGenerationThreeEventStore,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection-factory.ts";
import { submissionDigest, submissionId } from "@harness-anything/kernel/internal/domain/execution.ts";
import { reviewDigest } from "@harness-anything/kernel/internal/domain/review.ts";
import { sha256Text, stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";

test("R2: two snapshots collapse, two amendments retain every review cut, disposition, consent, packet and original outcome", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-closure-")),
    root = path.join(parent, "source"),
    targetRoot = path.join(parent, "target");
  const fixture = completionClosureFixture(root),
    source = openSqliteEventStore({ rootInput: root, generation: 2, readOnly: true });
  try {
    const plan = planCompletionGeneration(source, new Set());
    assert.equal(plan.snapshotMappings.length, 2);
    assert.notEqual(plan.snapshotMappings[0]!.from, plan.snapshotMappings[1]!.from);
    assert.deepEqual(plan.snapshotMappings[0]!.to, plan.snapshotMappings[1]!.to);
    writeCompletionGeneration(source, targetRoot, plan);
    const verified = verifyCompletionGeneration(source, targetRoot, plan);
    assert.equal(verified.events, 13);
    assert.equal(verified.commandOutcomes, 14);
    const target = openUnactivatedGenerationThreeEventStore({ repoId: "closure", rootInput: targetRoot }),
      projection = makeTaskProjection({ rootDir: targetRoot, eventStore: completionConversionStream(target) });
    try {
      const once = projection.rebuild(),
        twice = projection.rebuild();
      assert.equal(once.stateDigest, twice.stateDigest);
      const current = projection.read("task-1").snapshot;
      assert.equal(current.task?.status, "done");
      assert.equal(current.executions[0]!.state, "accepted");
      assert.equal(current.reviews.length, 3);
      assert.equal(current.consents.length, 2);
      const oldReview = current.reviews.find((r) => r.reviewId === fixture.requested.reviewId)!,
        latest = current.reviews.find((r) => r.reviewId === fixture.current.reviewId)!;
      assert.notEqual(oldReview.submissionDigest, latest.submissionDigest);
      assert.notEqual(oldReview.submissionDigest, fixture.requested.submissionDigest);
      assert.equal(current.reviewDispositions![0]!.submissionDigest, oldReview.submissionDigest);
      assert.deepEqual(current.reviewDispositions![0]!.disposedReviewIds, [oldReview.reviewId]);
      assert.equal(latest.submissionDigest, submissionDigest(current.executions[0]!.submission!));
      for (const consent of current.consents) {
        const review = current.reviews.find((r) => r.reviewId === consent.reviewId)!;
        assert.equal(consent.submissionDigest, review.submissionDigest);
        assert.equal(consent.reviewDigest, reviewDigest(review));
        assert.equal(consent.contentDigest, review.contentDigest);
      }
      assert.equal(Buffer.from(target.readContentObject(fixture.packetSha)!).toString(), fixture.packetBytes);
      for (const review of current.reviews) assert.equal(review.contentDigest, fixture.current.contentDigest);
      const converted = target.eventRowPage(0, 100).rows.map((row) => JSON.parse(row.eventJson));
      assert.equal(converted[1].payload.previousDigest, converted[1].payload.presetSnapshotClaim.digest);
      assert.deepEqual(converted[1].payload.historicalAcceptance, { sourceGeneration: 2, sourceRevision: 2 });
      const cuts = converted.filter((e) => e.type === "execution_submitted");
      assert.equal(cuts.length, 3);
      for (let i = 1; i < cuts.length; i++)
        assert.equal(cuts[i].payload.supersedesSubmissionId, submissionId(cuts[i - 1].payload.execution.submission));
      for (const event of converted.slice(0, 2)) {
        // Generation 3 must hold the current preset snapshot shape: the retired code/doc override is
        // removed during conversion, not carried forward into a schema that rejects it.
        const snapshot = JSON.parse(
          Buffer.from(target.readContentObject(event.payload.presetSnapshotClaim.sha256)!).toString(),
        ) as { readonly profile: Record<string, unknown> };
        assert.equal(Object.hasOwn(snapshot.profile, "closeoutOverrides"), false);
        const claim = event.payload.taskContractClaim ?? event.payload.initialDocumentClaims[0];
        const contract = JSON.parse(Buffer.from(target.readContentObject(claim.sha256)!).toString());
        assert.equal(contract.presetSnapshotDigest, event.payload.task.presetSnapshotDigest);
        assert.equal(event.payload.task.presetSnapshotDigest, event.payload.presetSnapshotClaim.digest);
      }
      const fence = { repoId: "closure", holder: "current", epoch: 2 };
      target.claimWriter(fence);
      for (const opId of ["closure-op-9", "rejected"]) {
        const original = source.outcome(opId)!;
        assert.deepEqual(
          target.appendCommand({
            fence,
            intent: { opId, intentDigest: original.intentDigest, summary: original.summary },
            events: [],
          }),
          original,
        );
        assert.equal(target.revision(), 13);
        assert.throws(
          () =>
            target.appendCommand({
              fence,
              intent: { opId, intentDigest: `sha256:${"0".repeat(64)}`, summary: original.summary },
              events: [],
            }),
          /another command intent/,
        );
      }
      console.log(
        "R2_CLOSURE=" +
          JSON.stringify({
            snapshots: 2,
            collapsed: true,
            amendments: 2,
            reviews: 3,
            consents: 2,
            dispositions: 1,
            rejectedOutcome: true,
            revision: target.revision(),
            coldReplayDigest: twice.stateDigest,
          }),
      );
    } finally {
      projection.close();
      target.close();
    }
  } finally {
    source.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("generation-two conversion rejects retired closeout overrides before target admission", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-closure-retired-override-")),
    root = path.join(parent, "source"),
    targetRoot = path.join(parent, "target");
  completionClosureFixture(root);
  const database = new DatabaseSync(sqliteLedgerPath(root, 2));
  let mutatedEvents = 0;
  try {
    const rows = database.prepare("SELECT revision,event_json FROM event ORDER BY revision").all() as {
        readonly revision: number;
        readonly event_json: string;
      }[],
      update = database.prepare("UPDATE event SET event_json=?,digest=? WHERE revision=?");
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as { readonly payload?: { readonly task?: Record<string, unknown> } },
        task = event.payload?.task;
      if (!task) continue;
      task.closeoutOverrides = { fact: false, codeDoc: true };
      const bytes = `${stableStringify(event)}\n`;
      update.run(bytes, `sha256:${sha256Text(bytes)}`, row.revision);
      mutatedEvents++;
    }
  } finally {
    database.close();
  }
  assert.ok(mutatedEvents > 0, "fixture must include task-carrier events");

  const source = openSqliteEventStore({ rootInput: root, generation: 2, readOnly: true });
  try {
    const plan = planCompletionGeneration(source, new Set());
    assert.throws(
      () => writeCompletionGeneration(source, targetRoot, plan),
      /closeoutOverrides must map closeout gate ids to booleans/u,
    );
    const target = new DatabaseSync(sqliteLedgerPath(targetRoot, 3), { readOnly: true });
    try {
      assert.equal(Number(target.prepare("SELECT COUNT(*) AS count FROM event").get()!.count), 0);
    } finally {
      target.close();
    }
    console.log(`GENERATION_TWO_RETIRED_CLOSEOUT_REJECTED=${mutatedEvents}`);
  } finally {
    source.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

for (const omitted of [
  "Consent.submissionDigest",
  "ReviewDisposition.submissionDigest",
  "Task.presetSnapshotDigest",
  "presetSnapshotClaim",
  "taskContractClaim",
] as const) {
  test(`R2 negative: omitting only ${omitted} blocks offline verification`, () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-closure-mutant-")),
      root = path.join(parent, "source"),
      targetRoot = path.join(parent, "target");
    const fixture = completionClosureFixture(root),
      source = openSqliteEventStore({ rootInput: root, generation: 2, readOnly: true });
    try {
      const plan = planCompletionGeneration(source, new Set());
      writeCompletionGeneration(source, targetRoot, plan);
      const revision =
        omitted === "Consent.submissionDigest" ? 12 : omitted === "ReviewDisposition.submissionDigest" ? 8 : 2;
      const db = new DatabaseSync(sqliteLedgerPath(targetRoot, 3));
      try {
        const row = db.prepare("SELECT event_json FROM event WHERE revision=?").get(revision)!;
        const changed = JSON.parse(String(row.event_json)),
          original = fixture.events[revision - 1]!.payload as Record<string, any>;
        if (omitted === "Consent.submissionDigest")
          changed.payload.consent.submissionDigest = original.consent.submissionDigest;
        else if (omitted === "ReviewDisposition.submissionDigest")
          changed.payload.disposition.submissionDigest = original.disposition.submissionDigest;
        else if (omitted === "Task.presetSnapshotDigest")
          changed.payload.task.presetSnapshotDigest = original.task.presetSnapshotDigest;
        else changed.payload[omitted] = original[omitted];
        const bytes = JSON.stringify(changed) + "\n";
        db.prepare("UPDATE event SET event_json=?,digest=? WHERE revision=?").run(
          bytes,
          `sha256:${sha256Text(bytes)}`,
          revision,
        );
      } finally {
        db.close();
      }
      assert.throws(
        () => verifyCompletionGeneration(source, targetRoot, plan),
        new RegExp(`converted event differs at revision ${revision}`),
      );
      console.log("R2_OMISSION_REJECTED=" + omitted);
    } finally {
      source.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}
