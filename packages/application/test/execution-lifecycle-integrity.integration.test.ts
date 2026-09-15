// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvedReviewsForExecution,
  authorizationPort,
  consentedApprovedReviewForExecution,
  currentActionEnvelopeVersion,
  isIndependentFrom,
  normalizeTaskLifecycleCommand,
  openSqliteEventStore,
  submissionDigest,
} from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { commitSha, lifecycleHarness, owner, reviewer } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "codex" } };
const otherActor = { principal: { personId: "person-2" }, executor: { kind: "agent" as const, id: "reviewer" } };

test("claim releases its CAS reservation after response loss and converges from the accepted SQLite cut", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_sqlite_commit");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_sqlite_commit/u);
    assert.equal(harness.projection.currentLease("task-1")?.phase, "released");
    assert.equal(harness.eventStore.read().events.length, 2);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(
        reopened.readCommandOutcome(harness.eventStore.read().events.at(-1)!.opId)?.status,
        "accepted_durable",
      );
    } finally {
      reopened.close();
    }
    harness.projection.catchUp();
    const converged = await harness.service.read("task-1");
    assert.equal(converged.status, "ready");
    assert.equal(converged.snapshot.executions[0]?.state, "active");
    assert.equal(converged.snapshot.lease?.phase, "held");
  } finally {
    await harness.cleanup();
  }
});

test("a claim the lifecycle contract rejects leaves the previous lease untouched instead of an orphan reservation", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1", "op-start-1", "2026-08-11T00:02:00.000Z");
    harness.projection.catchUp();
    // The lease has lapsed by the time the second claim occurs (00:03), so the reservation CAS admits it,
    // but the round still owns an active execution, so the transition rejects the command.
    await assert.rejects(harness.start("execution-2", "op-start-2"), /StartExecution requires a new execution/u);
    const lease = harness.projection.currentLease("task-1", "2026-08-11T00:04:00.000Z");
    assert.equal(lease?.executionId, "execution-1");
    assert.equal(lease?.phase, "orphaned");
    assert.equal(lease?.version, 1);
  } finally {
    await harness.cleanup();
  }
});

test("claim interrupted before the SQLite outcome rolls back the event and releases its CAS reservation", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    harness.kill("after_event_write");
    await assert.rejects(harness.start("execution-failed", "op-start-failed"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.read().events.length, 1);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(reopened.outcomes().length, 1);
    } finally {
      reopened.close();
    }
    assert.equal(harness.projection.currentLease("task-1")?.phase, "released");
    harness.projection.catchUp();
    assert.deepEqual((await harness.service.read("task-1")).snapshot.executions, []);
    assert.equal((await harness.start("execution-failed", "op-start-failed")).outcome, "applied");
  } finally {
    await harness.cleanup();
  }
});

test("G29 submit publishes only its frozen targets while preserving unrelated bytes", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    mkdirSync(path.join(harness.rootDir, "harness"), { recursive: true });
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = readFileSync(sentinel);

    harness.kill("after_sqlite_commit");
    await assert.rejects(harness.submit("execution-1", "op-submit-interrupted"), /killpoint:after_sqlite_commit/u);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(
        reopened.readCommandOutcome(harness.eventStore.read().events.at(-1)!.opId)?.status,
        "accepted_durable",
      );
    } finally {
      reopened.close();
    }
    harness.projection.catchUp();

    const read = await harness.service.read("task-1");
    assert.equal(read.snapshot.executions[0]?.state, "submitted");
    assert.equal(read.snapshot.task?.status, "in_review");
    assert.equal(read.snapshot.task?.currentNode, "review");
    assert.deepEqual(
      read.snapshot.edgesTaken.map((edge) => edge.on),
      ["submitted"],
    );
    assert.equal(read.snapshot.lease, null);
    assert.deepEqual(readFileSync(sentinel), before);
  } finally {
    await harness.cleanup();
  }
});

test("a submission amendment supersedes the bad packet and makes code-doc reconciliation valid", async () => {
  const harness = lifecycleHarness(),
    badCommitSha = "b".repeat(40);
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1", "op-submit-bad", "wrong cut", badCommitSha);

    await assert.rejects(harness.reconcile("execution-1", "a".repeat(40)), /submitted commit/u);
    const amended = await harness.amend("execution-1", "op-submit-amend", "corrected cut");
    assert.equal(amended.outcome, "applied");
    assert.equal(amended.snapshot.executions[0]?.submission?.commitSha, "a".repeat(40));

    const submissions = harness.eventStore.read().events.filter((event) => event.type === "execution_submitted");
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]?.payload.execution.submission?.commitSha, badCommitSha);
    if (submissions[0]?.type !== "execution_submitted" || !submissions[0].payload.execution.submission)
      throw new Error("initial submission event missing");
    assert.equal(
      submissions[1]?.payload.supersedesSubmissionId,
      `submission:${submissionDigest(submissions[0].payload.execution.submission)}`,
    );

    const reconciled = await harness.reconcile("execution-1", "a".repeat(40), "op-code-doc-after-amend");
    assert.equal(reconciled.outcome, "applied");
    assert.equal(reconciled.snapshot.codeDocWitnesses[0]?.commitSha, "a".repeat(40));
  } finally {
    await harness.cleanup();
  }
});

test("an amendment makes prior Review and consent pins stale until explicit consent is renewed", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1", "op-submit-original", "original claim");
    await harness.review("execution-1", "acceptance", "approved", "op-review-original");
    await harness.consent("execution-1", "op-consent-original");

    const amended = await harness.amend("execution-1", "op-submit-amend", "corrected claim");
    const execution = amended.snapshot.executions[0];
    if (execution?.schema !== "execution/v1") throw new Error("native execution missing");
    assert.deepEqual(approvedReviewsForExecution(amended.snapshot.reviews, execution), []);
    assert.equal(
      consentedApprovedReviewForExecution(amended.snapshot.reviews, amended.snapshot.consents, {
        ...execution,
        submittedAt: amended.snapshot.consents[0]!.consentedAt,
      }),
      undefined,
      "the old consent stays stale even when the amendment shares its millisecond",
    );
    await assert.rejects(harness.complete("execution-1", "op-complete-stale"), /approved Review/u);

    await harness.consent("execution-1", "op-consent-amended", "review-op-review-original");
    const consented = (await harness.service.read("task-1")).snapshot.consents.at(-1);
    assert.equal(consented?.submissionDigest, submissionDigest(execution.submission!));
    const completed = await harness.complete("execution-1", "op-complete-amended");
    assert.equal(completed.outcome, "applied");
    assert.equal(completed.snapshot.task?.status, "done");

    await assert.rejects(harness.amend("execution-1", "op-amend-completed"), /current submitted execution/u);
    await assert.rejects(harness.amend("execution-other", "op-amend-other"), /current submitted execution/u);
  } finally {
    await harness.cleanup();
  }
});

test("submit interrupted before the SQLite outcome preserves the active execution and held lease", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    harness.kill("after_event_write");
    await assert.rejects(harness.submit("execution-1", "op-submit-failed"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.read().events.length, 2);
    const reopened = openSqliteEventStore({ repoId: "test-repo", rootInput: harness.rootDir, readOnly: true });
    try {
      assert.equal(reopened.outcomes().length, 2);
    } finally {
      reopened.close();
    }
    harness.projection.catchUp();
    const read = await harness.service.read("task-1");
    assert.equal(read.snapshot.executions[0]?.state, "active");
    assert.equal(read.snapshot.task?.currentNode, "implementation");
    assert.equal(read.snapshot.lease?.phase, "held");
    assert.deepEqual(read.snapshot.edgesTaken, []);
    assert.equal((await harness.submit("execution-1", "op-submit-failed")).outcome, "applied");
  } finally {
    await harness.cleanup();
  }
});

test("concurrent submits from one snapshot accept one payload and reject the other revision", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const results = await Promise.allSettled([
      harness.submit("execution-1", "op-submit-a", "payload a"),
      harness.submit("execution-1", "op-submit-b", "payload b"),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const events = harness.eventStore.read().events;
    assert.equal(events.length, 3);
    assert.equal(events[2]?.type, "execution_submitted");
    assert.equal((await harness.service.read("task-1")).snapshot.executions[0]?.state, "submitted");
  } finally {
    await harness.cleanup();
  }
});

test("an authored submit with failed projection reports pending until explicit catch-up converges it", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    harness.failNextProjection();
    const receipt = await harness.submit("execution-1");

    assert.equal(receipt.outcome, "pending");
    assert.equal(harness.eventStore.read().events.at(-1)?.type, "execution_submitted");
    harness.projection.catchUp();
    const recovered = await harness.service.read("task-1");
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.snapshot.executions[0]?.state, "submitted");
  } finally {
    await harness.cleanup();
  }
});

test("approval retry reuses Review identity and ignores transport-only metadata", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    const submitted = (await harness.service.read("task-1")).snapshot.executions[0]!.submission!;
    const command = {
      ...normalizeTaskLifecycleCommand(
        { workspaceId: harness.rootDir, actor: reviewer, source: "local", expectedRevision: 3 },
        {
          type: "RecordReview" as const,
          taskId: "task-1",
          executionId: "execution-1",
          reviewId: "review-ae",
          verdict: "approved" as const,
          reason: "approved",
          evidenceChecked: [],
          commitSha,
          iteration: 0,
          contentDigest: `sha256:${"b".repeat(64)}` as const,
          submissionDigest: submissionDigest(submitted),
        },
      ),
      eventId: "event-review-ae",
      workspaceRevision: 4,
      occurredAt: "2026-08-11T00:04:00.000Z",
      transport: { attempt: 1 },
    };
    const proof = {
      actorBinding: reviewer,
      capability: "execution-review@v1" as const,
      capabilityRef: "cap-ae",
      returnBudget: 3,
    };
    const first = await harness.service.execute(command, proof);
    const second = await harness.service.execute({ ...command, transport: { attempt: 2 } }, proof);

    assert.equal(first.event?.type, "review_recorded");
    assert.equal(second.event?.eventId, first.event?.eventId);
    assert.equal(harness.eventStore.read().events.length, 4);
    assert.equal(second.snapshot.reviews[0]?.reviewId, "review-ae");
  } finally {
    await harness.cleanup();
  }
});

test("idempotent retry rejects source, workspace, expectedRevision, digest drift, and opId drift", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    const submitted = (await harness.service.read("task-1")).snapshot.executions[0]!.submission!;
    const command = {
      ...normalizeTaskLifecycleCommand(
        { workspaceId: harness.rootDir, actor: reviewer, source: "local", expectedRevision: 3 },
        {
          type: "RecordReview" as const,
          taskId: "task-1",
          executionId: "execution-1",
          reviewId: "review-drift",
          verdict: "approved" as const,
          reason: "approved",
          evidenceChecked: [],
          commitSha,
          iteration: 0,
          contentDigest: `sha256:${"b".repeat(64)}` as const,
          submissionDigest: submissionDigest(submitted),
        },
      ),
      eventId: "event-review-drift",
      workspaceRevision: 4,
      occurredAt: "2026-08-11T00:04:00.000Z",
    };
    const proof = {
      actorBinding: reviewer,
      capability: "execution-review@v1" as const,
      capabilityRef: "cap-drift",
      returnBudget: 3,
    };
    await harness.service.execute(command, proof);
    const drifts = [
      { source: "remote_direct" as const },
      { workspaceId: `${harness.rootDir}-other` },
      { expectedRevision: 2 },
      { commandDigest: `sha256:${"0".repeat(64)}` as const },
      { opId: `op_${"f".repeat(64)}` },
    ];
    for (const drift of drifts) {
      await assert.rejects(() => harness.service.execute({ ...command, ...drift }, proof));
    }
    assert.equal(harness.eventStore.read().events.length, 4);
  } finally {
    await harness.cleanup();
  }
});

test("changes_requested records Review, return edge, Execution closure, and Task reactivation together", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    const before = (await harness.service.read("task-1")).snapshot;
    harness.kill("after_event_write");
    await assert.rejects(
      harness.review("execution-1", "anti_entropy", "changes_requested"),
      /killpoint:after_event_write/u,
    );
    harness.projection.catchUp();
    assert.deepEqual((await harness.service.read("task-1")).snapshot, before);
    assert.equal(harness.eventStore.read().revision, 3);
    harness.kill("after_sqlite_commit");
    await assert.rejects(
      harness.review("execution-1", "anti_entropy", "changes_requested"),
      /killpoint:after_sqlite_commit/u,
    );
    assert.equal(harness.eventStore.read().revision, 4);
    harness.projection.catchUp();
    const snapshot = (await harness.service.read("task-1")).snapshot;
    assert.equal(snapshot.reviews.at(-1)?.verdict, "changes_requested");
    assert.equal(snapshot.edgesTaken.at(-1)?.on, "changes_requested");
    assert.equal(snapshot.executions[0]?.state, "changes_requested");
    assert.notEqual(snapshot.executions[0]?.closedAt, null);
    assert.equal(snapshot.task?.status, "active");
    assert.equal(snapshot.task?.currentNode, "implementation");
    assert.equal(snapshot.task?.iteration, 1);
    assert.equal(snapshot.lease, null);
  } finally {
    await harness.cleanup();
  }
});

test("lease CAS permits only the current holder and version to renew and release", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Lease Test");
    git(rootDir, "config", "user.email", "lease-test@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
    projection = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventStore({ repoId: "test-repo", rootDir }),
      now: () => "2026-08-11T00:30:00.000Z",
    });
    const reservation = projection.reserveLease(
      {
        schema: "lease/v1",
        taskId: "task-1",
        executionId: "execution-1",
        actor,
        source: "local",
        phase: "reserving",
        expiresAt: "2026-08-11T01:00:00.000Z",
        ttlMs: 1_800_000,
        version: 0,
      },
      "2026-08-11T00:00:00.000Z",
    );
    const active = projection.activateLease(reservation);

    assert.equal(active.phase, "held");
    assert.throws(
      () => projection.reserveLease({ ...reservation, executionId: "execution-2" }, "2026-08-11T00:00:00.000Z"),
      /conflict/u,
    );
    assert.throws(() => projection.renewLease({ ...active, actor: otherActor }, "2026-08-11T02:00:00.000Z"), /stale/u);
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.throws(() => projection.releaseLease(active), /stale/u);
    assert.equal(projection.releaseLease(renewed).phase, "released");
    assert.equal(projection.currentLease("task-1")?.phase, "released");
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("renewed lease survives database rebuild", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const active = harness.projection.currentLease("task-1");
    if (active === null) throw new Error("fixture requires active lease");

    const renewed = await harness.service.renewLease({
      taskId: "task-1",
      executionId: "execution-1",
      actor: owner,
      source: "local",
      expectedVersion: active.version,
      expiresAt: "2026-08-11T02:00:00.000Z",
      opId: "op-renew",
      eventId: "event-renew",
      workspaceRevision: 3,
      occurredAt: "2026-08-11T00:03:00.000Z",
    });

    assert.equal(renewed.version, active.version + 1);
    assert.equal(renewed.expiresAt, "2026-08-11T02:00:00.000Z");
    assert.equal(harness.eventStore.readEvent("op-renew")?.type, "lease_renewed");
  } finally {
    await harness.cleanup();
  }
});

test("event saga rejects a second executor and self-review, then completes on Review plus consent", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await assert.rejects(harness.start("execution-2", "op-start-second"), /effective lease|active execution/iu);
    await harness.submit("execution-1");
    await assert.rejects(harness.complete("execution-1", "op-complete-early"), /approved|in_review/iu);

    const selfReview = authorizationPort.authorize(
      {
        version: currentActionEnvelopeVersion,
        actionId: "action-review-self",
        kind: "task-review-execution",
        target: "execution/execution-1",
        actor: owner,
        authorizationRef: "default@5",
        idempotencyKey: "review-self",
      },
      {
        roleBindings: [
          {
            actor: { kind: "person", id: owner.principal.personId },
            role: "arbiter",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        ],
        roleBindingTargets: ["settings/repository"],
        target: { executionActor: owner, runtimeBinding: null },
        evaluatedAtCut: "canonical:3",
      },
    );
    assert.equal(selfReview.outcome, "allowed");
    assert.equal(isIndependentFrom(owner, owner), false);

    await harness.review("execution-1", "anti_entropy", "approved");
    await harness.consent("execution-1");
    const completed = await harness.complete("execution-1");
    assert.equal(completed.outcome, "applied");
    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.executions[0]?.state, "accepted");
    assert.deepEqual(completed.snapshot.executions[0]?.submission?.outputs, []);
  } finally {
    await harness.cleanup();
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
