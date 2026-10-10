import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lifecycleFixture, implementer } from "./task-lifecycle-fixture.ts";
import { submissionDigest, submissionId } from "../../src/domain/execution.ts";
import { reviewDigest } from "../../src/domain/review.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";
import { sha256Text, stableStringify } from "../../src/integrity/stable-hash.ts";
import { openSqliteEventStore, sqliteLedgerPath, sqliteContentObjectPath } from "../../src/store/sqlite-event-store.ts";

/** Accepted old-format history, independently assembled rather than produced by the converter. */
export function completionClosureFixture(root: string) {
  const native = structuredClone(lifecycleFixture().events),
    taskId = "task-1";
  const packetBytes = "# Review packet\nThe original experimental evidence is unchanged.\n";
  const packetSha = sha256Text(packetBytes),
    packetClaim = {
      path: `tasks/${taskId}-fixture/artifacts/review-packet.md`,
      sha256: packetSha,
      size: Buffer.byteLength(packetBytes),
      mediaType: "text/markdown",
    };
  const blobs = new Map<string, string>([[packetSha, packetBytes]]);
  const content = (body: object) => {
    const bytes = stableStringify(body) + "\n",
      sha256 = sha256Text(bytes);
    blobs.set(sha256, bytes);
    return { sha256, size: Buffer.byteLength(bytes), mediaType: "application/json" as const };
  };
  const snapshots = ["old-checker-a", "old-checker-b"].map((checkerProfile) => {
    const body = {
      schema: "preset-snapshot/v1",
      identity: { id: "standard-task", version: "1" },
      profile: { id: "baseline", completionGateIds: [], checkerProfile },
    };
    const digest = `sha256:${sha256Text(stableStringify(body))}` as const;
    return { digest, ...content({ ...body, digest }) };
  });
  const contract = (digest: string) => ({
    ...content({ schema: "task-contract/v1", taskId, presetSnapshotDigest: digest }),
    path: `tasks/${taskId}-fixture/task-contract.json`,
    owner: "machine",
    policyId: "typed-machine-writer/v1",
  });
  const first = native[0]!.payload as { task: Record<string, unknown> };
  const task0 = { ...first.task, presetSnapshotDigest: snapshots[0]!.digest };
  const task1 = { ...task0, presetSnapshotDigest: snapshots[1]!.digest };
  const events: CanonicalEventV1[] = [];
  const emit = (type: string, payload: object, schema = "task-event/v1", actor = implementer) => {
    const revision = events.length + 1;
    const event = {
      schema,
      type,
      payload,
      taskId,
      workspaceRevision: revision,
      eventId: `closure-event-${revision}`,
      opId: `closure-op-${revision}`,
      actor,
      source: "local",
      occurredAt: `2026-09-02T00:00:${String(revision).padStart(2, "0")}.000Z`,
    } as unknown as CanonicalEventV1;
    events.push(event);
    return event;
  };
  emit(
    "task_bootstrapped",
    {
      task: task0,
      presetSnapshotClaim: snapshots[0],
      initialDocumentClaims: [
        contract(snapshots[0]!.digest),
        { ...packetClaim, owner: "doc-sync", policyId: "markdown-body-replaceable/v1" },
      ],
    },
    "task-bootstrap-event/v1",
  );
  emit(
    "preset_snapshot_upgraded",
    {
      task: task1,
      previousDigest: snapshots[0]!.digest,
      presetSnapshotClaim: snapshots[1],
      taskContractClaim: contract(snapshots[1]!.digest),
    },
    "preset-snapshot-upgrade-event/v1",
  );
  const oldPayload = (index: number) => {
    const payload = structuredClone(native[index]!.payload) as Record<string, any>;
    payload.task.presetSnapshotDigest = snapshots[1]!.digest;
    if (payload.execution) {
      delete payload.execution.gateRuns;
      if (payload.execution.submission) delete payload.execution.submission.completionContract;
    }
    return payload;
  };
  emit("execution_started", oldPayload(1));
  const submitted = oldPayload(2);
  emit("execution_submitted", submitted);
  const forwarded = oldPayload(3);
  emit("submission_forwarded", forwarded);
  let execution = forwarded.execution;
  const review = (id: string, verdict: string) => ({
    ...oldPayload(4).review,
    contentDigest: `sha256:${packetSha}`,
    reviewId: id,
    verdict,
    submissionDigest: submissionDigest(execution.submission),
  });
  const requested = review("review-old-rejected", "changes_requested");
  emit("review_recorded", { ...forwarded, review: requested });
  const approved = review("review-old-approved", "approved");
  emit("review_recorded", { ...forwarded, review: approved });
  const consent = (id: string, reviewValue: typeof approved) => ({
    ...oldPayload(5).consent,
    contentDigest: reviewValue.contentDigest,
    consentId: id,
    reviewId: reviewValue.reviewId,
    reviewDigest: reviewDigest(reviewValue),
    submissionDigest: reviewValue.submissionDigest,
  });
  const disposition = {
    schema: "review-disposition/v1",
    dispositionId: "disposition-old",
    taskId,
    executionId: execution.executionId,
    iteration: 0,
    submissionDigest: requested.submissionDigest,
    disposedReviewIds: [requested.reviewId],
    rationale: "Accepted historical disposition",
    actor: implementer,
    source: "local",
    disposedAt: "2026-09-02T00:00:08.000Z",
  };
  emit("review_consent_overridden", {
    ...forwarded,
    review: approved,
    consent: consent("consent-old", approved),
    disposition,
  });
  for (let n = 1; n <= 2; n++) {
    const supersedesSubmissionId = submissionId(execution.submission);
    execution = {
      ...execution,
      submittedAt: `2026-09-02T00:00:${String(events.length + 1).padStart(2, "0")}.000Z`,
      submission: { ...execution.submission, completionClaim: `amendment ${n}` },
    };
    emit("execution_submitted", { task: forwarded.task, execution, documentClaims: [], supersedesSubmissionId });
  }
  const current = review("review-current", "approved");
  emit("review_recorded", { task: forwarded.task, execution, documentClaims: [], review: current });
  emit("review_consent_recorded", {
    task: forwarded.task,
    execution,
    documentClaims: [],
    review: current,
    consent: consent("consent-current", current),
  });
  emit("task_completed", {
    task: { ...forwarded.task, status: "done" },
    execution: { ...execution, state: "accepted", closedAt: "2026-09-02T00:00:13.000Z" },
    documentClaims: [],
  });
  openSqliteEventStore({ rootInput: root, repoId: "closure", generation: 2 }).close();
  const db = new DatabaseSync(sqliteLedgerPath(root, 2));
  const insert = db.prepare(
    "INSERT INTO event(revision,op_id,event_json,digest,occurred_at,recorded_at) VALUES(?,?,?,?,?,?)",
  );
  const outcome = db.prepare(
    "INSERT INTO command_outcome(op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,recorded_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const event of events) {
    const bytes = stableStringify(event) + "\n";
    insert.run(
      event.workspaceRevision,
      event.opId,
      bytes,
      `sha256:${sha256Text(bytes)}`,
      event.occurredAt,
      event.occurredAt,
    );
    outcome.run(
      event.opId,
      "accepted_durable",
      event.workspaceRevision,
      event.workspaceRevision,
      `sha256:${sha256Text(event.opId)}`,
      "original intent",
      null,
      event.occurredAt,
    );
  }
  outcome.run(
    "rejected",
    "rejected",
    null,
    null,
    `sha256:${"f".repeat(64)}`,
    "rejected original",
    "revision_conflict",
    events.at(-1)!.occurredAt,
  );
  db.prepare("UPDATE ledger_meta SET revision=?").run(events.length);
  db.close();
  for (const [sha256, bytes] of blobs) {
    const file = sqliteContentObjectPath(root, sha256, 2);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return { events, snapshots, requested, approved, current, disposition, packetBytes, packetSha };
}
