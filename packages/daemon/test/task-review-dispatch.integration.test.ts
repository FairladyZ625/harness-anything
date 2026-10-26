// harness-test-tier: integration
import assert from "node:assert/strict";
import { grantTestPolicyGroups, revokeTestPolicyActions, withPolicyGroup } from "./keycloak-policy.fixtures.ts";

/** The principal that records rework-driving verdicts: a person of its own, so denying its
 * runtime-spawn (which kills the automatic worker continuation at admission) never touches the
 * owner's permissions this file's other tests rely on. A reviewer never needs to spawn. */
const REWORK_REVIEWER_PERSON = "completion-rework-reviewer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  classifyTextualArtifactPath,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
  submissionDigest,
} from "@harness-anything/kernel";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { realizedDecisionBody, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { executionId, fixture, owner, reviewerExecutionBinding, taskId } from "./task-completion-review.fixture.ts";
import { makeDaemonCommandReceipt } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiActionResult } from "../src/protocol/gui-result-validation.ts";
import { activeCutReviewDispatches } from "../src/task-review-dispatch.ts";

// The JSON-RPC exit for repo.decision.dispatchReview: the cell receipt wrapped and re-validated.
const overGuiWire = (receipt: object) =>
  parseDaemonGuiActionResult(
    "repo.decision.dispatchReview",
    makeDaemonCommandReceipt("decision-dispatch-review", receipt),
  );

const reviewerActor = (runtimeSessionId: string) =>
  withPolicyGroup(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
    },
    "admin",
  );

/** A dispatched reviewer's changes_requested verdict: the verdict itself reopens the round and
 * registers the dispatch's report, which is what qualifies the lane's next cut for a re-review.
 * runtime-spawn is revoked around the write so the automatic worker continuation is denied at
 * admission (the receipt records that failure): like delivery-baseline-rework's unavailable
 * spawner, the failed continuation leaves the reopened round without a spawned execution, so the
 * next round starts like any other. The owner's group grants are restored right after. */
async function requestChanges(f: Awaited<ReturnType<typeof fixture>>, runtimeSessionId: string, reviewId: string) {
  grantTestPolicyGroups([REWORK_REVIEWER_PERSON], "admin");
  revokeTestPolicyActions(REWORK_REVIEWER_PERSON, "completion-review", ["runtime-spawn"]);
  const packet = `${f.packagePath}/artifacts/reports/${reviewId}.json`,
    report = `${f.packagePath}/artifacts/reports/${reviewId.replace(/^review-/u, "")}.md`;
  mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
  writeFileSync(path.join(f.root, "harness", report), `# Review ${reviewId}\n\nRework requested.\n`);
  writeFileSync(
    path.join(f.root, "harness", packet),
    JSON.stringify({
      verdict: "changes_requested",
      reason: "The submitted cut needs another pass.",
      evidenceChecked: ["closeout.md"],
    }),
  );
  return f.cell().run(
    { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
    withPolicyGroup(
      {
        actor: {
          principal: { personId: REWORK_REVIEWER_PERSON },
          executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "admin",
    ),
  );
}

test("review dispatch starts over provider-sized evidence and reads every frozen anchor", async (t) => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "standard",
    providerInputLimit: 1_048_576,
  });
  try {
    await f.install();
    const artifacts = Array.from({ length: 80 }, (_, i) => ({
      path: `${f.packagePath}/artifacts/evidence-${i}.log`,
      body: `FROZEN-${i}-HEAD\n${"accepted evidence line\n".repeat(1600)}FROZEN-${i}-TAIL\n`,
    }));
    assert.ok(artifacts.reduce((size, artifact) => size + artifact.body.length, 0) > 1_048_576);
    for (const artifact of artifacts) writeFileSync(path.join(f.root, "harness", artifact.path), artifact.body);
    assert.equal((await f.run({ kind: "doc-submit", taskId })).outcome, "applied");
    await f.submit();
    // The submit dispatched the reviewer itself; the retry lane is idempotent on the same cut key.
    const dispatched = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] }),
      step = dispatchesOf(dispatched)[0]!;
    assert.equal(step.outcome, "already_dispatched", JSON.stringify(step));
    assert.equal(f.launches.length, 1, "the provider accepted the first input");
    const { dispatchId, runtimeSessionId } = step as Required<DispatchStep>,
      binding = reviewerExecutionBinding(runtimeSessionId, dispatchId),
      shown = await f.cell().run({ kind: "task-show", taskId }, binding),
      submitted = JSON.parse(String(shown.evidence)).executions.find(
        (execution: { executionId: string }) => execution.executionId === executionId,
      ).submission;
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    assert.match(f.launches[0]!.prompt, new RegExp(submissionDigest(submitted)));
    for (const artifact of artifacts) {
      const anchor = submitted.artifacts.find((entry: { path: string }) => entry.path === artifact.path);
      assert.ok(anchor, `task-show exposes ${artifact.path}`);
      writeFileSync(path.join(f.root, "harness", artifact.path), "changed after submission\n");
      const read = await f.cell().run({ kind: "doc-show", path: anchor.path, raw: true }, binding);
      assert.equal(read.outcome, "applied", JSON.stringify(read));
      assert.equal(read.revision, anchor.revision);
      assert.equal(read.evidence, artifact.body);
      assert.equal(sha256Text(String(read.evidence)), anchor.blobSha256);
    }
    t.diagnostic(
      `Provider accepted ${f.launches[0]!.prompt.length}-character first input; all 80 frozen evidence files match submission digests.`,
    );
  } finally {
    await f.close();
  }
});

test("expanded reviewer runtime publishes only its bound report atomically", async () => {
  const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
  try {
    await f.install();
    const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
    const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
    const head = f.events().at(-1)!,
      body = "# Independent review\n\nThe submitted execution and report were checked.\n",
      report = `${f.packagePath}/artifacts/reports/${dispatchId}.md`,
      ref = "doc-sync-claims/0123456789abcdef0123456789abcdef",
      claim = path.join(f.root, ".harness", ref),
      action = {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: `review-${dispatchId}`,
        verdict: "approved",
        reason: "Checked the submitted execution.",
        evidenceChecked: ["tests"],
        docChanges: [
          {
            path: report,
            baseBlobSha256: null,
            policyId: classifyTextualArtifactPath(report)!.policyId,
            candidate: { ref, sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown" },
          },
        ],
        mirrorBaseCut: {
          revision: head.workspaceRevision,
          headDigest: `sha256:${sha256Text(
            serializeEventHead({
              revision: head.workspaceRevision,
              opId: head.opId,
              eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(head))}`,
            }),
          )}`,
        },
      };
    mkdirSync(path.dirname(claim), { recursive: true });
    writeFileSync(claim, body);
    const before = f.events().length,
      wrong = await f.cell().run({ ...action, reviewId: "review-unbound" }, reviewerActor(runtimeSessionId));
    assert.equal(wrong.code, "actor_unauthorized", JSON.stringify(wrong));
    assert.equal(f.events().length, before);
    assert.equal(existsSync(path.join(f.root, "harness", report)), false);
    writeFileSync(claim, body);
    const accepted = await f.cell().run(action, reviewerActor(runtimeSessionId));
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const event = f.events().find((event) => event.opId === accepted.opId);
    assert.ok(event?.type === "review_recorded");
    assert.equal(event.payload.carriedDocumentClaims?.[0]?.path, report);
    assert.equal(event.payload.carriedDocumentClaims?.[0]?.candidate.sha256, sha256Text(body));
  } finally {
    await f.close();
  }
});

test("decision dispatch-review passes spawn admission and launches once for the current digest", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  const runDecision = (action: Parameters<typeof f.run>[0]) => f.cell().run(action, withPolicyGroup(owner, "admin"));
  try {
    await f.install();
    const proposed = await runDecision({
      kind: "decision-propose",
      body: realizedDecisionBody("Independent dispatch review"),
      jsonInput: JSON.stringify({
        title: "Independent dispatch review",
        question: "Should the proposal receive independent review?",
        riskTier: "high",
        urgency: "high",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Require independent review" }],
        rejected: [{ id: "RJ1", text: "Self-review", whyNot: "Independent review is required" }],
        claims: [{ id: "C1", text: "The reviewer is independent.", loadBearing: true }],
        fulfillments: [],
      }),
    });
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string,
      shown = await runDecision({ kind: "decision-show", decisionId, includeBody: true }),
      digest = JSON.parse(String(shown.evidence)).decision.currentReviewContentDigest as string,
      receipt = await runDecision({ kind: "decision-dispatch-review", decisionId, runtimeInstanceId: "review-first" });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(overGuiWire(receipt).status, "accepted_durable", JSON.stringify(receipt));
    assert.equal(f.launches.length, 1);
    assert.match(f.launches[0]!.prompt, new RegExp(decisionId, "u"));
    assert.ok(f.launches[0]!.prompt.includes(digest));
    const requested = f.events().filter((event) => event.type === "runtime_dispatch_requested");
    assert.equal(requested.length, 1);
    assert.deepEqual(requested[0]!.payload.reviewTarget, { kind: "decision", decisionId, digest });
    const mission = f.launches[0]!.prompt,
      missionDispatchId = requested[0]!.payload.dispatchId;
    assert.ok(
      mission.includes(`reviewId review-${missionDispatchId}`),
      "the dispatched mission must hand the reviewer the exact registration reviewId",
    );
    assert.ok(
      mission.includes(`reportRef harness/decisions/decision-${decisionId}/artifacts/reports/${missionDispatchId}.md`),
      "the dispatched mission must hand the reviewer the exact reportRef",
    );
    const retry = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    assert.equal(overGuiWire(retry).status, "accepted_durable", JSON.stringify(retry));
    assert.equal(f.launches.length, 1);
    const first = requested[0]!.payload;
    f.failPending();
    await f.awaitOutcome(first.runtimeSessionId);
    const redispatched = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(redispatched.outcome, "applied", JSON.stringify(redispatched));
    assert.equal(f.launches.length, 2, "an ended session without a review needs a new attempt");
    const second = f
      .events()
      .filter((event) => event.type === "runtime_dispatch_requested")
      .at(-1)!.payload;
    assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/${second.dispatchId}.md`;
    const reportPath = path.join(f.root, "harness", reportRef);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# Review\n\nThe current Decision cut was reviewed.\n");
    const review = {
      kind: "decision-review",
      decisionId,
      reviewId: `review-${second.dispatchId}`,
      reviewContentDigest: digest,
      verdict: "approved",
      reason: "Independent dispatch review supports acceptance.",
      findings: [],
      evidenceChecked: [],
      reportRef,
    };
    await expectCoded(runDecision(review), "actor_unauthorized");
    await expectCoded(
      runDecision({
        ...review,
        decisionId: "decision-unrelated",
        executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
      }),
      "executor_binding_invalid",
    );
    await expectCoded(
      runDecision({
        ...review,
        reviewContentDigest: `sha256:${"0".repeat(64)}`,
        executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
      }),
      "invalid_transition",
    );
    const { kind, decisionId: reviewedDecisionId, ...packet } = review;
    const packetRef = `decisions/decision-${decisionId}/artifacts/reviews/${second.dispatchId}.json`;
    mkdirSync(path.dirname(path.join(f.root, "harness", packetRef)), { recursive: true });
    writeFileSync(path.join(f.root, "harness", packetRef), JSON.stringify(packet));
    const reviewed = await runDecision({
      kind,
      decisionId: reviewedDecisionId,
      fromFile: `harness/${packetRef}`,
      executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
    });
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    f.failPending();
    await f.awaitOutcome(second.runtimeSessionId);
    const registeredRetry = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(registeredRetry.outcome, "applied", JSON.stringify(registeredRetry));
    assert.equal(f.launches.length, 2, "a registered review must keep its ended dispatch idempotent");
    const accepted = await f.cell().run(
      {
        kind: "decision-accept",
        decisionId,
        reviewId: review.reviewId,
        expectedDigest: digest,
        rationale: "Independent review approved this cut.",
        judgmentOnlyRationale: "The reviewed decision needs no task.",
      },
      withPolicyGroup(
        { actor: { principal: owner.actor.principal, executor: null }, source: "local" as const },
        "admin",
      ),
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  } finally {
    await f.close();
  }
});

test(
  "decision dispatch-review --agent refuses instead of returning another agent's in-flight dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    const runDecision = (action: Parameters<typeof f.run>[0]) => f.cell().run(action, withPolicyGroup(owner, "admin"));
    try {
      await f.install();
      const second = await f.run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "second-reviewer",
          name: "Second reviewer",
          instructions: "Inspect the decision cut and record your independent verdict.",
          runtimes: [{ type: "codex", model: "review-model" }],
          instance: "review-second",
          role: "reviewer",
        },
      });
      assert.equal(second.outcome, "applied", JSON.stringify(second));
      const proposed = await runDecision({
        kind: "decision-propose",
        body: realizedDecisionBody("Explicit agent dispatch review"),
        jsonInput: JSON.stringify({
          title: "Explicit agent dispatch review",
          question: "Should the explicit --agent refusal apply here too?",
          riskTier: "high",
          urgency: "high",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Refuse on a held slot" }],
          rejected: [{ id: "RJ1", text: "Return the other dispatch", whyNot: "It misattributes the reviewer" }],
          claims: [{ id: "C1", text: "One cut holds one review dispatch.", loadBearing: true }],
          fulfillments: [],
        }),
      });
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string;
      assert.equal((await runDecision({ kind: "decision-dispatch-review", decisionId })).outcome, "applied");
      assert.equal(f.launches.length, 1);
      const refused = await runDecision({
        kind: "decision-dispatch-review",
        decisionId,
        agentId: "second-reviewer",
      }).catch((error: { code?: string; message?: string }) => error);
      await expectCoded(Promise.resolve(refused), "review_dispatch_failed");
      assert.match(
        (refused as { rejectionExplanation?: string }).rejectionExplanation ??
          (refused as { message?: string }).message ??
          JSON.stringify(refused),
        /--agent second-reviewer was not dispatched/u,
      );
      assert.equal(f.launches.length, 1, "the refusal must not launch the requested reviewer");
      const plain = await runDecision({ kind: "decision-dispatch-review", decisionId });
      assert.equal(plain.outcome, "applied", JSON.stringify(plain));
      const step = (Array.isArray(plain.dispatches) ? plain.dispatches : [])[0] as Record<string, unknown>;
      assert.equal(step.outcome, "already_dispatched");
      assert.equal(step.agentId, "closeout-reviewer");
      assert.equal(step.instanceId, "review-first");
    } finally {
      await f.close();
    }
  },
);

test(
  "a settled decision review dispatch publishes its report, packet, and dispatch record through the writer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    const runDecision = (action: Parameters<typeof f.run>[0]) => f.cell().run(action, withPolicyGroup(owner, "admin"));
    try {
      await f.install();
      const proposed = await runDecision({
        kind: "decision-propose",
        body: realizedDecisionBody("Published dispatch review"),
        jsonInput: JSON.stringify({
          title: "Published dispatch review",
          question: "Should the dispatched review's artifacts be published?",
          riskTier: "high",
          urgency: "high",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Publish the review artifacts" }],
          rejected: [{ id: "RJ1", text: "Leave them untracked", whyNot: "The ledger must hold the review" }],
          claims: [{ id: "C1", text: "The reviewer is independent.", loadBearing: true }],
          fulfillments: [],
        }),
      });
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string,
        shown = await runDecision({ kind: "decision-show", decisionId, includeBody: true }),
        digest = JSON.parse(String(shown.evidence)).decision.currentReviewContentDigest as string,
        receipt = await runDecision({ kind: "decision-dispatch-review", decisionId }),
        step = dispatchesOf(receipt)[0]!,
        dispatchId = step.dispatchId!,
        runtimeSessionId = step.runtimeSessionId!,
        packageRoot = `decisions/decision-${decisionId}`,
        reportRef = `${packageRoot}/artifacts/reports/${dispatchId}.md`,
        packetRef = `${packageRoot}/artifacts/reports/${dispatchId}.json`;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.match(
        f.launches[0]!.prompt,
        new RegExp(`artifacts/reports/${dispatchId}\\.json`, "u"),
        "the dispatch must assign the reviewer one packet path",
      );
      const authored = path.join(f.root, "harness", packetRef);
      mkdirSync(path.dirname(authored), { recursive: true });
      writeFileSync(path.join(f.root, "harness", reportRef), "# Review\n\nThe Decision cut was reviewed.\n");
      writeFileSync(
        authored,
        JSON.stringify({
          reviewId: `review-${dispatchId}`,
          reviewContentDigest: digest,
          verdict: "approved",
          reason: "The frozen Decision document supports acceptance.",
          findings: [],
          evidenceChecked: ["decision.md"],
          reportRef,
        }),
      );
      const reviewed = await runDecision({
        kind: "decision-review",
        decisionId,
        fromFile: `harness/${packetRef}`,
        executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
      });
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const reviewEvent = f.events().find((event) => event.opId === reviewed.opId),
        carried = reviewEvent?.type === "decision_review_recorded" ? reviewEvent.payload.carriedDocumentClaims : null;
      assert.deepEqual(
        (carried ?? []).map((change) => change.path).sort(),
        [packetRef, reportRef].sort(),
        "recording the review must publish the report and its packet together",
      );
      const outcome = await f.settleDecisionReview(runtimeSessionId, "Reviewed and recorded.");
      assert.equal(outcome, "succeeded", "a registered decision review settles as succeeded");
      const archive = f
        .events()
        .find(
          (event) =>
            event.type === "documents_written" &&
            (event.payload.changes as { readonly path: string }[]).some(
              (change) => change.path === `${packageRoot}/artifacts/dispatches/${dispatchId}.json`,
            ),
        );
      assert.ok(archive, "the settlement archive must publish the decision dispatch record");
      const archivePaths = (archive.payload.changes as { readonly path: string }[]).map((change) => change.path);
      assert.ok(
        archivePaths.includes(`${packageRoot}/artifacts/missions/${dispatchId}.md`),
        `archive changes: ${JSON.stringify(archivePaths)}`,
      );
      for (const opId of [reviewed.opId, archive.opId])
        await f
          .cell()
          .run(
            { kind: "receipt-show", opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
            withPolicyGroup(owner, "admin"),
          );
      for (const logical of [
        reportRef,
        packetRef,
        `${packageRoot}/artifacts/dispatches/${dispatchId}.json`,
        `${packageRoot}/artifacts/missions/${dispatchId}.md`,
      ])
        execFileSync("git", ["-C", f.root, "ls-files", "--error-unmatch", "--", `harness/${logical}`], {
          stdio: "ignore",
        });
    } finally {
      await f.close();
    }
  },
);

type DispatchStep = {
  taskId: string;
  executionId?: string;
  dispatchId?: string;
  runtimeSessionId?: string;
  agentId?: string;
  instanceId?: string;
  lane?: string;
  outcome: string;
  error?: string;
};

const dispatchesOf = (receipt: unknown): DispatchStep[] =>
  (receipt as Record<string, unknown>).dispatches as DispatchStep[];

/** Daemon facades convert coded failures into rejected receipts; accept either surface. */
async function expectCoded(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    const receipt = (await promise) as Record<string, unknown>;
    assert.equal(receipt.code, code, JSON.stringify(receipt));
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, String(error));
  }
}

type TaskShow = {
  task: { iteration: number; status: string };
  executions: readonly { executionId: string; submission: unknown }[];
  lease: unknown;
};

const showTask = async (f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<TaskShow> =>
  JSON.parse(String((await f.run({ kind: "task-show", taskId: id })).evidence)) as TaskShow;

const boundCuts = (f: Awaited<ReturnType<typeof fixture>>, runtimeSessionId: string): [string, string][] =>
  f
    .events()
    .filter(
      (event) =>
        event.type === "runtime_session_started" &&
        event.payload.runtimeSessionId === runtimeSessionId &&
        event.payload.taskBinding !== null &&
        event.payload.taskBinding !== undefined,
    )
    .map((event) => {
      const taskBinding = event.payload.taskBinding as { taskId: string; executionId: string };
      return [String(taskBinding.taskId), String(taskBinding.executionId)];
    });

async function spawnReviewerForKey(f: Awaited<ReturnType<typeof fixture>>, dispatchKey: string): Promise<string> {
  const receipt = await f.cell().spawnRuntime(
    {
      agentId: "closeout-reviewer",
      role: "reviewer",
      taskId,
      executionId,
      cwd: { scope: "repo-root" },
      dispatchKey,
      prompt: "Review the bound submission cut.",
    },
    owner,
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(typeof receipt.runtimeSessionId, "string", JSON.stringify(receipt));
  return String(receipt.runtimeSessionId);
}

test(
  "submitted cuts reject explicit dispatch-review and generic reviewer runtime ingress before owner forward",
  { timeout: 20_000 },
  async () => {
    // A low-tier code delivery still needs an accepted artifact before submission.
    const f = await fixture(false, true, true, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      create: { riskTier: "low" },
    });
    try {
      await f.install();
      const submitted = await f.submit();
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], executionId });
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      assert.match(dispatchesOf(receipt)[0]?.error ?? "", /has no automatic review requirement/u);
      await expectCoded(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            role: "reviewer",
            taskId,
            executionId,
            cwd: { scope: "repo-root" },
            dispatchKey: "review-before-forward",
            prompt: "review",
          },
          owner,
        ),
        "review_admission_denied",
      );
      assert.equal(f.launches.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "task dispatch-review launches one reviewer bound to the submitted cut without touching the implementation iteration",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const before = await showTask(f, taskId);
      const startedBefore = f.events().filter((event) => event.type === "execution_started").length;
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "already_dispatched", JSON.stringify(steps[0]));
      assert.equal(steps[0]!.executionId, executionId);
      const dispatchId = steps[0]!.dispatchId!,
        runtimeSessionId = steps[0]!.runtimeSessionId!;
      assert.equal(f.launches.length, 1);
      assert.match(f.launches[0]!.prompt, new RegExp(`artifacts/reports/${dispatchId}\\.md`, "u"));
      assert.match(f.launches[0]!.prompt, /RecordReview/u);
      // The review dispatch did not start an implementation iteration and holds no lease.
      const after = await showTask(f, taskId);
      assert.equal(after.task.iteration, before.task.iteration, "implementation iteration must not move");
      assert.equal(after.executions.length, before.executions.length, "no new implementation execution may be opened");
      assert.equal(after.lease ?? null, null, "the reviewer holds no task lease");
      assert.equal(
        f.events().filter((event) => event.type === "execution_started").length,
        startedBefore,
        "the review dispatch opened no implementation execution",
      );
      assert.deepEqual(
        boundCuts(f, runtimeSessionId),
        [[taskId, executionId]],
        "one review execution binds exactly one task, at the submitted cut",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "reviewer runtime submission fences accept every current-cut key shape and reject both stale-cut shapes",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const initialDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(initialDispatch?.type === "runtime_dispatch_requested");
      const currentKey = initialDispatch.payload.dispatchKey,
        currentSession = initialDispatch.payload.runtimeSessionId,
        attemptSession = await spawnReviewerForKey(f, `${currentKey}:attempt1`),
        legacyKey = currentKey.replace(/^task-review:/u, "complete-review:"),
        legacySession = await spawnReviewerForKey(f, legacyKey),
        legacySuffixSession = await spawnReviewerForKey(f, `${legacyKey}:upgrade-in-flight`);

      for (const [sessionId, reviewId] of [
        [currentSession, "review-current-cut"],
        [attemptSession, "review-current-cut-attempt1"],
        [legacySession, "review-current-cut-legacy"],
        [legacySuffixSession, "review-current-cut-legacy-suffix"],
      ] as const) {
        const reviewed = await f.review(sessionId, reviewId);
        assert.equal(reviewed.outcome, "applied", `${reviewId}: ${JSON.stringify(reviewed)}`);
      }

      const staleCurrentSession = await spawnReviewerForKey(f, `${currentKey}:stale`),
        staleLegacySession = await spawnReviewerForKey(f, `${legacyKey}:stale`),
        closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(closeoutPath, `${readFileSync(closeoutPath, "utf8")}\nAmended verification evidence.\n`);
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));

      for (const [sessionId, reviewId] of [
        [staleCurrentSession, "review-stale-current-key"],
        [staleLegacySession, "review-stale-legacy-key"],
      ] as const) {
        const rejected = await f.review(sessionId, reviewId);
        assert.equal(rejected.outcome, "op_rejected", `${reviewId}: ${JSON.stringify(rejected)}`);
        assert.equal(rejected.code, "invalid_proof", `${reviewId}: ${JSON.stringify(rejected)}`);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "task dispatch-review expands a batch into one independent review dispatch per task",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const task2 = "task-completion-review-batch",
        execution2 = "execution-completion-review-batch";
      await f.submitExtraTask(task2, execution2);
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId, task2] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 2);
      assert.deepEqual(
        steps.map((step) => [step.taskId, step.outcome]),
        [
          [taskId, "already_dispatched"],
          [task2, "already_dispatched"],
        ],
      );
      assert.notEqual(steps[0]!.dispatchId, steps[1]!.dispatchId, "each task gets its own review dispatch");
      assert.notEqual(steps[0]!.runtimeSessionId, steps[1]!.runtimeSessionId);
      assert.equal(f.launches.length, 2);
      for (const [index, expected] of [
        [0, [taskId, executionId]],
        [1, [task2, execution2]],
      ] as const) {
        assert.deepEqual(
          boundCuts(f, steps[index]!.runtimeSessionId!),
          [expected],
          "each review execution binds exactly one task and its submitted cut",
        );
        assert.match(f.launches[index]!.prompt, new RegExp(`artifacts/reports/${steps[index]!.dispatchId}\\.md`, "u"));
      }
      // Duplicate task ids in one invocation are rejected: one review execution never covers two tasks.
      await expectCoded(f.run({ kind: "task-dispatch-review", taskIds: [taskId, taskId] }), "invalid_command");
    } finally {
      await f.close();
    }
  },
);

test(
  "dispatch-review --agent refuses instead of returning another agent's in-flight review dispatch",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
    });
    try {
      await f.install();
      const second = await f.run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "second-reviewer",
          name: "Second reviewer",
          instructions: "Inspect submitted bytes and record your independent verdict.",
          runtimes: [{ type: "codex", model: "review-model" }],
          instance: "review-second",
          role: "reviewer",
        },
      });
      assert.equal(second.outcome, "applied", JSON.stringify(second));
      // The fixture's submit dispatched the default reviewer automatically; its session stays in flight.
      assert.equal(f.launches.length, 1);
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "second-reviewer" });
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      assert.equal(receipt.code, "review_dispatch_failed", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "failed");
      assert.equal(steps[0]!.agentId, "second-reviewer");
      assert.match(
        steps[0]!.error ?? "",
        /already holds review dispatch \S+ by agent closeout-reviewer .*--agent second-reviewer was not dispatched/u,
        JSON.stringify(steps[0]),
      );
      assert.equal(f.launches.length, 1, "the refusal must not launch the requested reviewer");
      // Without --agent the idempotent path remains, now naming the holding agent and its instance.
      const plain = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(plain.outcome, "applied", JSON.stringify(plain));
      const plainStep = dispatchesOf(plain)[0]!;
      assert.equal(plainStep.outcome, "already_dispatched");
      assert.equal(plainStep.agentId, "closeout-reviewer");
      const heldDispatch = f
        .events()
        .find(
          (event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === plainStep.dispatchId,
        );
      assert.ok(heldDispatch?.type === "runtime_dispatch_requested");
      assert.equal(plainStep.runtimeSessionId, heldDispatch.payload.runtimeSessionId);
      assert.equal(plainStep.instanceId, heldDispatch.payload.instanceId);
      // The holding agent's own explicit --agent stays idempotent.
      const same = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.equal(same.outcome, "applied", JSON.stringify(same));
      assert.equal(dispatchesOf(same)[0]!.outcome, "already_dispatched");
      assert.equal(dispatchesOf(same)[0]!.agentId, "closeout-reviewer");
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "decision dispatch-review refuses an amended digest while the prior digest is still in flight",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false });
    const runDecision = (action: Parameters<typeof f.run>[0]) => f.cell().run(action, withPolicyGroup(owner, "admin"));
    try {
      await f.install();
      const proposed = await runDecision({
        kind: "decision-propose",
        body: realizedDecisionBody("Cross digest dispatch exclusion"),
        jsonInput: JSON.stringify({
          title: "Cross digest dispatch exclusion",
          question: "Should an amended Decision wait for its prior review?",
          riskTier: "high",
          urgency: "high",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Keep one review in flight per Decision." }],
          rejected: [
            { id: "RJ1", text: "Dispatch both digests", whyNot: "It permits concurrent verdicts for one Decision." },
          ],
          claims: [{ id: "C1", text: "An amended cut must wait for the prior review.", loadBearing: true }],
          fulfillments: [],
        }),
      });
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string,
        first = await runDecision({ kind: "decision-dispatch-review", decisionId });
      assert.equal(first.outcome, "applied", JSON.stringify(first));
      assert.equal(f.launches.length, 1);

      const amended = await runDecision({
        kind: "decision-amend",
        decisionId,
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [],
        body: realizedDecisionBody("Cross digest dispatch exclusion amended"),
      });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const shown = await runDecision({ kind: "decision-show", decisionId, includeBody: true }),
        amendedDigest = JSON.parse(String(shown.evidence)).decision.currentReviewContentDigest as string;
      const refused = await runDecision({
        kind: "decision-dispatch-review",
        decisionId,
        expectedDigest: amendedDigest,
      });
      await expectCoded(Promise.resolve(refused), "review_dispatch_failed");
      assert.match(
        (refused as { rejectionExplanation?: string }).rejectionExplanation ?? JSON.stringify(refused),
        /already has an unfinished review dispatch for digest/u,
      );
      assert.equal(f.launches.length, 1, "amending the Decision must not launch a second digest review");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        1,
        "the old digest remains the sole in-flight dispatch",
      );
    } finally {
      await f.close();
    }
  },
);

test("active cut review lookup skips historical reviewer rows without dispatchKey", () => {
  const cell = {
      projection: {
        readRuntimeDispatchesByTaskExecution: () => [
          { event: { payload: { role: "reviewer", dispatchKey: undefined } } },
        ],
      },
    } as unknown as Parameters<typeof activeCutReviewDispatches>[0],
    execution = {
      taskId,
      executionId,
      iteration: 0,
      submission: {
        commitSha: null,
        artifacts: [],
        completionClaim: "test",
        deliverables: [],
        outputs: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
      },
    } as unknown as Parameters<typeof activeCutReviewDispatches>[2];
  assert.deepEqual(activeCutReviewDispatches(cell, taskId, execution), []);
});

test(
  "a fresh dispatch-review step names the dispatched agent and its runtime instance",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
    });
    try {
      await f.install();
      // The fixture's submit already dispatched the bundled default reviewer; ending that
      // session lets the retry lane dispatch the installed declaration.
      const first = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(first?.type === "runtime_dispatch_requested");
      f.failPending();
      await f.awaitOutcome(first.payload.runtimeSessionId);
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const step = dispatchesOf(receipt)[0]!;
      assert.equal(step.outcome, "dispatched", JSON.stringify(step));
      assert.equal(step.agentId, "closeout-reviewer");
      assert.equal(step.instanceId, "review-first");
      assert.notEqual(step.runtimeSessionId, first.payload.runtimeSessionId);
      assert.equal(f.launches.length, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "a re-review resumes the prior reviewer provider session for the same task lane",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
      autoSubmit: false,
      autoProviderSession: true,
    });
    try {
      await f.install();
      assert.equal((await f.submit()).outcome, "applied");
      const first = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(first?.type === "runtime_dispatch_requested");
      const reviewId = `review-${first.payload.dispatchId}`;
      await f.waitForProviderBinding(first.payload.dispatchId, "review-provider-session");
      f.failPending();
      await f.awaitOutcome(first.payload.runtimeSessionId);
      // The changes_requested verdict reopens the round itself; no owner return command exists.
      const reviewed = await requestChanges(f, first.payload.runtimeSessionId, reviewId);
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const nextExecution = "execution-review-resume-next";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: nextExecution })).outcome, "applied");
      assert.equal((await f.submit(nextExecution)).outcome, "applied");
      const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      const second = dispatches.at(-1)!;
      assert.equal(second.type, "runtime_dispatch_requested");
      assert.equal(second.payload.resumedFromDispatchId, first.payload.dispatchId);
      await f.waitForProviderBinding(second.payload.dispatchId, "review-provider-session");
      const firstProvider = readDispatchStream(f.root, first.payload.dispatchId),
        secondProvider = readDispatchStream(f.root, second.payload.dispatchId);
      assert.equal(firstProvider?.providerSessionId, "review-provider-session");
      assert.equal(secondProvider?.providerSessionId, firstProvider?.providerSessionId);
      assert.ok(
        f.launches.at(-1)!.args.includes("review-provider-session"),
        "the provider argv resumes the same session",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a rejected reviewer resume starts a fresh session with the previous registered report in its scope",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
      autoSubmit: false,
      autoProviderSession: true,
      failProviderResume: true,
    });
    try {
      await f.install();
      assert.equal((await f.submit()).outcome, "applied");
      const first = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(first?.type === "runtime_dispatch_requested");
      const reviewId = `review-${first.payload.dispatchId}`;
      await f.waitForProviderBinding(first.payload.dispatchId, "review-provider-session");
      f.failPending();
      await f.awaitOutcome(first.payload.runtimeSessionId);
      // The verdict itself returns the cut; the rework submit's automatic dispatch then tries
      // the rejected resume and falls back to a fresh reviewer session.
      assert.equal((await requestChanges(f, first.payload.runtimeSessionId, reviewId)).outcome, "applied");
      const nextExecution = "execution-review-fallback-next";
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: nextExecution })).outcome, "applied");
      const secondReceipt = await f.submit(nextExecution);
      assert.equal(secondReceipt.outcome, "applied", JSON.stringify(secondReceipt));
      const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested"),
        second = dispatches.at(-1)!;
      assert.equal(second.type, "runtime_dispatch_requested");
      // The submit receipt carries its review dispatch as a step; the step must name the fresh
      // fallback identity, not the rejected resume.
      const dispatchStep = ((secondReceipt.steps as readonly Record<string, unknown>[] | undefined) ?? []).find(
        (step) => typeof step.dispatchId === "string",
      );
      assert.ok(dispatchStep, `submit carries no dispatch step: ${JSON.stringify(secondReceipt)}`);
      assert.equal(
        dispatchStep.dispatchId,
        second.payload.dispatchId,
        `receipt must name the fresh fallback dispatch: ${JSON.stringify(secondReceipt)}`,
      );
      assert.equal(dispatchStep.runtimeSessionId, second.payload.runtimeSessionId);
      assert.equal(second.payload.resumedFromDispatchId, undefined, "fallback must own a fresh dispatch");
      assert.match(second.payload.dispatchKey, /execution-review-fallback-next/u);
      await f.waitForProviderBinding(first.payload.dispatchId, "review-provider-session");
      await f.waitForProviderBinding(second.payload.dispatchId, "review-provider-session-new");
      assert.equal(f.launches.length, 3, "initial launch, rejected resume, then fresh fallback");
      const fallback = f.launches.at(-1)!;
      assert.ok(
        !fallback.args.includes("review-provider-session"),
        "fallback argv must not resume the rejected session",
      );
      assert.ok(fallback.prompt.includes("harness/tasks/") && fallback.prompt.includes("ha doc show --path"));
      assert.ok(fallback.prompt.includes(`${first.payload.dispatchId}.md`), "fallback must name the prior report");
      // The fallback owns a new dispatch identity, so its mission must name that identity's
      // registration id and report paths; the previous dispatch's report stays read-only input.
      const fallbackReport = `${f.packagePath}/artifacts/reports/${second.payload.dispatchId}.md`;
      assert.ok(
        fallback.prompt.includes(`--review-id review-${second.payload.dispatchId}`) &&
          fallback.prompt.includes(`--from-file harness/${fallbackReport.replace(/\.md$/u, ".json")}`),
        `fallback must register under its own dispatch identity: ${fallback.prompt}`,
      );
      assert.ok(
        fallback.prompt.includes("verify each previous finding") &&
          fallback.prompt.includes("new diff relative to the previous report's cut"),
        "fallback keeps the re-review scope bounded",
      );
      assert.ok(
        fallback.prompt.includes("breaks a current invariant or the production path is blocking") &&
          !fallback.prompt.includes("Do not reopen"),
        "a re-review keeps a newly found invariant or production-path defect blocking",
      );
      const registered = await f.reviewDispatchedArtifacts(
        second.payload.runtimeSessionId,
        second.payload.dispatchId,
        nextExecution,
      );
      assert.equal(registered.outcome, "applied", JSON.stringify(registered));
      const stream = readDispatchStream(f.root, second.payload.dispatchId);
      assert.equal(stream?.providerSessionId, "review-provider-session-new");
    } finally {
      await f.close();
    }
  },
);

test(
  "a reviewer runtime may only record a review; lifecycle writes that would mutate the implementation iteration are denied",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const runtimeSessionId = dispatchesOf(receipt)[0]!.runtimeSessionId!;
      const before = await showTask(f, taskId),
        startedBefore = f.events().filter((event) => event.type === "execution_started").length,
        denied = await f
          .cell()
          .run(
            { kind: "task-start", taskId, executionId: "execution-reviewer-escape" },
            reviewerActor(runtimeSessionId),
          );
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
      assert.equal(denied.code, "runtime_reviewer_lifecycle_forbidden", JSON.stringify(denied));
      const after = await showTask(f, taskId);
      assert.equal(after.task.iteration, before.task.iteration, "the implementation iteration must not move");
      assert.equal(
        f.events().filter((event) => event.type === "execution_started").length,
        startedBefore,
        "the reviewer could not open an implementation execution",
      );
      const transition = await f
        .cell()
        .run(
          { kind: "task-transition", taskId, status: "cancelled", reason: "reviewer must not cancel tasks" },
          reviewerActor(runtimeSessionId),
        );
      assert.equal(transition.outcome, "op_rejected", JSON.stringify(transition));
      assert.equal(transition.code, "runtime_reviewer_lifecycle_forbidden", JSON.stringify(transition));
      // A reviewer cannot aim its review packet at another task's package either.
      const task2 = "task-completion-review-cross",
        execution2 = "execution-completion-review-cross";
      await f.submitExtraTask(task2, execution2);
      const crossTask = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId: task2,
          executionId: execution2,
          reviewId: "review-cross-task",
          fromFile: "harness/missing.json",
          executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
        },
        reviewerActor(runtimeSessionId),
      );
      assert.equal(crossTask.outcome, "op_rejected", JSON.stringify(crossTask));
      assert.equal(crossTask.code, "executor_binding_invalid", JSON.stringify(crossTask));
    } finally {
      await f.close();
    }
  },
);

test(
  "a registered review keeps the runtime settlement honest even when the archive collides",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const review = await f.reviewDispatchedArtifacts(runtimeSessionId, dispatchId);
      assert.equal(review.outcome, "applied", JSON.stringify(review));
      // Force a divergent archive collision: the mission path the archive would write already
      // exists with different content. The review is registered, so settlement stays honest.
      const mission = path.join(f.root, "harness", f.packagePath, "artifacts", "missions", `${dispatchId}.md`);
      mkdirSync(path.dirname(mission), { recursive: true });
      writeFileSync(mission, "divergent pre-existing mission artifact\n");
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Reviewed and recorded.");
      assert.equal(outcome, "succeeded", "a registered review must not settle as a failed dispatch");
    } finally {
      await f.close();
    }
  },
);

test(
  "an archive collision without a registered review still settles the reviewer dispatch as failed",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const mission = path.join(f.root, "harness", f.packagePath, "artifacts", "missions", `${dispatchId}.md`);
      mkdirSync(path.dirname(mission), { recursive: true });
      writeFileSync(mission, "divergent pre-existing mission artifact\n");
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Reviewed without registering.");
      assert.equal(outcome, "failed", "an unregistered review still fails archive settlement honestly");
    } finally {
      await f.close();
    }
  },
);

test(
  "the reviewer report lands under the reviewed task's own package reports directory",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "done", "# Review\n\nApproved.\n");
      assert.equal(outcome, "failed", "a report file alone is not a registered review witness");
      const report = path.join(f.root, "harness", f.packagePath, "artifacts", "reports", `${dispatchId}.md`);
      assert.ok(existsSync(report), `expected the authored report at ${report}`);
      const packet = report.replace(/\.md$/u, ".json");
      assert.equal(existsSync(packet), false, "no stray packet file is fabricated by the archive");
    } finally {
      await f.close();
    }
  },
);

test(
  "a configured path-review lane dispatches its reviewer beside the cut review and stays off by default",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
      create: { presetId: "standard-task", riskTier: "high" },
    });
    try {
      await f.install();
      const laneAgent = await f.run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "data-migration",
          name: "Data migration reviewer",
          instructions:
            "Report the affected persisted data, the attach-migration registration, and the old-copy evidence.",
          runtimes: [{ type: "codex", model: "review-model" }],
          role: "reviewer",
        },
      });
      assert.equal(laneAgent.outcome, "applied", JSON.stringify(laneAgent));
      // The standard-task preset binds a task worktree; committing on the bound worktree branch and
      // amending without an explicit commit makes the frozen manifest derive from the branch's fork
      // point, exactly as a worker's delivery does.
      await f.cell().settlePendingMaterialization("path lane fixture delivery");
      const worktreePaths = execFileSync("git", ["-C", f.root, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n\n")
          .map((entry) => entry.split("\n").find((line) => line.startsWith("worktree ")))
          .filter((line): line is string => line !== undefined)
          .map((line) => path.resolve(line.slice("worktree ".length))),
        checkout = worktreePaths.find((entry) => entry !== path.resolve(f.root));
      assert.ok(checkout, `expected the bound task worktree beside ${f.root}`);
      const commitSchemaSurface = (body: string) => {
        const surface = path.join(checkout, "packages/kernel/src/domain/settings.ts");
        mkdirSync(path.dirname(surface), { recursive: true });
        writeFileSync(surface, body);
        execFileSync("git", ["-C", checkout, "add", "packages/kernel/src/domain/settings.ts"]);
        execFileSync("git", ["-C", checkout, "commit", "-qm", "feat: narrow a persisted field"]);
      };
      // Default off: no repository entry means no additional lane, even when the cut touches the
      // path the product's self-hosted configuration would watch.
      commitSchemaSurface("// first schema surface\n");
      const unconfigured = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(unconfigured.outcome, "applied", JSON.stringify(unconfigured));
      assert.equal(
        f
          .events()
          .some(
            (event) =>
              event.type === "runtime_dispatch_requested" && event.payload.dispatchKey?.startsWith("task-review-lane:"),
          ),
        false,
        "an empty review.pathReviewers must dispatch no lane",
      );
      const settings = await f.run({ kind: "settings-read" });
      const configured = await f.runPrincipal({
        kind: "settings-update",
        reviewPathReviewers: ["data-migration packages/kernel/src/domain/"],
        expectedVersion: settings.revision,
      });
      assert.equal(configured.outcome, "applied", JSON.stringify(configured));
      const launchesBefore = f.launches.length;
      // The amended cut's frozen manifest touches the configured directory.
      commitSchemaSurface("// second schema surface\n");
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const laneDispatch = f
        .events()
        .find(
          (event) =>
            event.type === "runtime_dispatch_requested" &&
            event.payload.dispatchKey?.startsWith("task-review-lane:data-migration:"),
        );
      assert.ok(laneDispatch?.type === "runtime_dispatch_requested", "no path-review lane dispatch was requested");
      assert.equal(laneDispatch.payload.agentId, "data-migration");
      assert.equal(laneDispatch.payload.role, "reviewer");
      assert.equal(laneDispatch.payload.taskId, taskId);
      assert.equal(laneDispatch.payload.executionId, executionId);
      const laneId = laneDispatch.payload.dispatchId!;
      const laneLaunch = f.launches.find((launch) => launch.prompt.includes(laneId));
      assert.ok(laneLaunch, `no provider launch carried the lane dispatch ${laneId}`);
      assert.match(laneLaunch.prompt, /additional review lane for agent data-migration/u);
      assert.ok(laneLaunch.prompt.includes("- packages/kernel/src/domain/settings.ts"), laneLaunch.prompt);
      assert.ok(
        laneLaunch.prompt.includes(`--review-id review-${laneId}`),
        "the lane reviewer's registration identity is fixed by its dispatch",
      );
      assert.equal(f.launches.length, launchesBefore + 2, "one cut review plus one path-review lane");
      // The lane is idempotent on the same submitted cut.
      const retry = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(retry.outcome, "applied", JSON.stringify(retry));
      const steps = dispatchesOf(retry),
        laneStep = steps.find((step) => step.lane === "data-migration");
      assert.ok(laneStep, `no path-review lane step in ${JSON.stringify(steps)}`);
      assert.equal(laneStep!.outcome, "already_dispatched");
      assert.equal(laneStep!.dispatchId, laneId);
      assert.equal(f.launches.length, launchesBefore + 2, "an idempotent retry launches nothing");
    } finally {
      await f.close();
    }
  },
);

test(
  "a medium-risk cut touching a configured path still dispatches its migration reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      closeoutProfile: "standard",
      create: { presetId: "standard-task", riskTier: "medium" },
    });
    try {
      await f.install();
      const laneAgent = await f.run({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "data-migration",
          name: "Data migration reviewer",
          instructions:
            "Report the affected persisted data, the attach-migration registration, and the old-copy evidence.",
          runtimes: [{ type: "codex", model: "review-model" }],
          role: "reviewer",
        },
      });
      assert.equal(laneAgent.outcome, "applied", JSON.stringify(laneAgent));
      await f.cell().settlePendingMaterialization("medium path lane fixture delivery");
      const worktreePaths = execFileSync("git", ["-C", f.root, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n\n")
          .map((entry) => entry.split("\n").find((line) => line.startsWith("worktree ")))
          .filter((line): line is string => line !== undefined)
          .map((line) => path.resolve(line.slice("worktree ".length))),
        checkout = worktreePaths.find((entry) => entry !== path.resolve(f.root));
      assert.ok(checkout, `expected the bound task worktree beside ${f.root}`);
      // One of the decision's exact-file entries, not a directory prefix: a medium-risk cut that
      // touches that file must still reach the configured reviewer.
      const surface = "packages/kernel/src/domain/review.ts";
      const settings = await f.run({ kind: "settings-read" });
      const configured = await f.runPrincipal({
        kind: "settings-update",
        reviewPathReviewers: [`data-migration ${surface}`],
        expectedVersion: settings.revision,
      });
      assert.equal(configured.outcome, "applied", JSON.stringify(configured));
      mkdirSync(path.dirname(path.join(checkout, surface)), { recursive: true });
      writeFileSync(path.join(checkout, surface), "// migration-sensitive domain surface\n");
      execFileSync("git", ["-C", checkout, "add", surface]);
      execFileSync("git", ["-C", checkout, "commit", "-qm", "feat: add the reviewed domain surface"]);
      const launchesBefore = f.launches.length;
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const submitted = f
        .events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      const assessment = submitted.payload.execution.submission.riskTierAssessment;
      assert.equal(assessment?.effectiveTier, "medium", "the cut keeps its declared medium tier");
      assert.ok(
        assessment?.matchedPathReviewers.some(
          ({ agentId, paths }) => agentId === "data-migration" && paths.includes(surface),
        ),
        "the medium cut froze the configured path hit",
      );
      const laneDispatch = f
        .events()
        .find(
          (event) =>
            event.type === "runtime_dispatch_requested" &&
            event.payload.dispatchKey?.startsWith("task-review-lane:data-migration:"),
        );
      assert.ok(laneDispatch?.type === "runtime_dispatch_requested", "no path-review lane dispatch was requested");
      assert.equal(laneDispatch.payload.agentId, "data-migration");
      assert.equal(laneDispatch.payload.role, "reviewer");
      assert.equal(laneDispatch.payload.executionId, executionId);
      const laneLaunch = f.launches.find((launch) => launch.prompt.includes(laneDispatch.payload.dispatchId!));
      assert.ok(laneLaunch, `no provider launch carried the lane dispatch ${laneDispatch.payload.dispatchId!}`);
      assert.ok(laneLaunch.prompt.includes(`- ${surface}`), laneLaunch.prompt);
      assert.equal(f.launches.length, launchesBefore + 2, "one cut review plus one path-review lane");
    } finally {
      await f.close();
    }
  },
);

test(
  "dispatch-review refuses a task with no submitted cut instead of binding the implementation execution",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { closeoutProfile: "standard" });
    try {
      await f.install();
      const planned = "task-completion-review-planned";
      const plannedPackage = await f.createPlannedTask(planned);
      await realizeTaskPlanFixture(f.root, plannedPackage, (planPath) =>
        f.run({ kind: "doc-submit", paths: [planPath] }),
      );
      assert.equal(
        (await f.run({ kind: "task-start", taskId: planned, executionId: "execution-planned" })).outcome,
        "applied",
      );
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [planned] });
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "failed");
      assert.match(steps[0]!.error ?? "", /not at the in-review gate/u);
      assert.equal(f.launches.length, 1, "the planned task must not add a reviewer launch");
      // The internal spawn path enforces the same invariant.
      await expectCoded(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            role: "reviewer",
            taskId: planned,
            cwd: { scope: "repo-root" },
            dispatchKey: "review-planned-target",
            prompt: "review",
          },
          owner,
        ),
        "review_admission_denied",
      );
    } finally {
      await f.close();
    }
  },
);
