// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskLifecycleCommand } from "../../src/domain/task-lifecycle.contract.ts";
import { respondReview } from "../../src/domain/task-lifecycle-review-transitions.ts";
import type {
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle-contract-internal-types.ts";

const actor = { principal: { personId: "person-response-owner" }, executor: null } as const,
  executionId = "execution-response-probe",
  occurredAt = "2026-11-02T00:00:00.000Z",
  proof = { actorBinding: actor, capability: "execution-review-response@v1", capabilityRef: "response-probe" };

interface ProbeResponse {
  readonly reviewId: string;
  readonly findingId: string;
  readonly disposition: "adopt" | "rebut";
  readonly rationale: string;
}

/**
 * Counts index reads on the arrays the transition scans, the same way the G38 cost probe does:
 * every `0`, `1`, ... read of a wrapped array is one member examined.
 */
function counted<T>(values: readonly T[], counts: Record<string, number>, metric: string): readonly T[] {
  return new Proxy(values as T[], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) counts[metric] += 1;
      return Reflect.get(target, key, receiver);
    },
  });
}

function snapshotOf(input: {
  readonly reviews: readonly {
    readonly reviewId: string;
    readonly verdict: "approved" | "changes_requested";
    readonly findings: readonly { readonly findingId: string; readonly blocking: boolean }[];
  }[];
  readonly reviewResponses?: readonly { readonly reviewId: string; readonly findingId: string }[];
}): TaskLifecycleSnapshot {
  return {
    revision: 7,
    task: { taskId: "task-response-probe", status: "active", currentNode: "implementation", iteration: 1 },
    executions: [{ schema: "execution/v1", executionId, iteration: 1, state: "active" }],
    reviews: input.reviews,
    consents: [],
    reviewResponses: input.reviewResponses ?? [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  } as unknown as TaskLifecycleSnapshot;
}

function commandWith(responses: readonly ProbeResponse[]): TaskLifecycleCommand {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: 7 },
      { type: "RespondReview", taskId: "task-response-probe", executionId, responses },
    ),
    eventId: "event-response-probe",
    workspaceRevision: 8,
    occurredAt,
  } as TaskLifecycleCommand;
}

function issuesFor(
  snapshot: TaskLifecycleSnapshot,
  responses: readonly ProbeResponse[],
): readonly { readonly code: string; readonly message: string }[] {
  return respondReview.validate(snapshot, commandWith(responses), proof) as readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

function measure(size: number): { readonly priorResponsesExamined: number; readonly findingsExamined: number } {
  const counts = { priorResponsesExamined: 0, findingsExamined: 0 },
    priorResponses = Array.from({ length: size }, (_, index) => ({
      reviewId: "review-prior",
      findingId: `prior-${index}`,
    })),
    findings = Array.from({ length: size }, (_, index) => ({ findingId: `finding-${index}`, blocking: true })),
    snapshot = {
      ...snapshotOf({
        reviews: [{ reviewId: "review-current", verdict: "changes_requested", findings }],
        reviewResponses: priorResponses,
      }),
      reviewResponses: counted(priorResponses, counts, "priorResponsesExamined"),
      reviews: [
        {
          reviewId: "review-current",
          verdict: "changes_requested",
          findings: counted(findings, counts, "findingsExamined"),
        },
      ],
    } as unknown as TaskLifecycleSnapshot;
  assert.deepEqual(
    respondReview.validate(
      snapshot,
      commandWith(
        Array.from({ length: size }, (_, index) => ({
          reviewId: "review-current",
          findingId: `finding-${index}`,
          disposition: "rebut" as const,
          rationale: "Measured response.",
        })),
      ),
      proof,
    ),
    [],
  );
  return counts;
}

test("response validation examines each prior response and finding at most once", (context) => {
  const small = measure(100),
    large = measure(2000),
    overBudget = [
      ...(["100", "2000"] as const).flatMap((label) => {
        const counts = label === "100" ? small : large;
        return (
          [
            ["priorResponsesExamined", counts.priorResponsesExamined],
            ["findingsExamined", counts.findingsExamined],
          ] as const
        )
          .filter(([, examined]) => examined > Number(label))
          .map(([metric, examined]) => `${metric}=${examined} at ${label} (max ${label})`);
      }),
      // G38 allows at most 22x growth for a 20x input: an indexed pass stays linear.
      ...(
        [
          ["priorResponsesExamined", small.priorResponsesExamined, large.priorResponsesExamined],
          ["findingsExamined", small.findingsExamined, large.findingsExamined],
        ] as const
      )
        .filter(([, base, grown]) => grown > 22 * base)
        .map(([metric, base, grown]) => `${metric}=${base} at 100 grew to ${grown} at 2000 (max 22x)`),
    ];
  context.diagnostic(`respondReview members examined: ${JSON.stringify({ 100: small, 2000: large })}`);
  assert.deepEqual(overBudget, []);
});

test("an existing response key is rejected as invalid_transition", () => {
  const snapshot = snapshotOf({
      reviews: [
        { reviewId: "review-a", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
      ],
      reviewResponses: [{ reviewId: "review-a", findingId: "F1" }],
    }),
    issues = issuesFor(snapshot, [
      { reviewId: "review-a", findingId: "F1", disposition: "rebut", rationale: "Repeated response." },
    ]);
  assert.deepEqual(
    issues.map(({ code, message }) => ({ code, message })),
    [{ code: "invalid_transition", message: "review response review-a/F1 already exists" }],
  );
});

test("a response repeated inside one packet is rejected once", () => {
  const snapshot = snapshotOf({
      reviews: [
        { reviewId: "review-a", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
      ],
    }),
    duplicate = {
      reviewId: "review-a",
      findingId: "F1",
      disposition: "rebut",
      rationale: "Duplicated response.",
    } as const,
    issues = issuesFor(snapshot, [duplicate, duplicate]);
  assert.deepEqual(
    issues.map(({ code, message }) => ({ code, message })),
    [{ code: "invalid_transition", message: "review response review-a/F1 already exists" }],
  );
});

test("a prior response key only guards its own review", () => {
  const snapshot = snapshotOf({
    reviews: [
      { reviewId: "review-a", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
      { reviewId: "review-b", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
    ],
    reviewResponses: [{ reviewId: "review-a", findingId: "F1" }],
  });
  assert.deepEqual(
    issuesFor(snapshot, [{ reviewId: "review-b", findingId: "F1", disposition: "adopt", rationale: "Own finding." }]),
    [],
  );
});

test("a response must name a blocking finding of a changes_requested review", () => {
  const snapshot = snapshotOf({
      reviews: [
        { reviewId: "review-a", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
        { reviewId: "review-b", verdict: "changes_requested", findings: [{ findingId: "F1", blocking: true }] },
        { reviewId: "review-approved", verdict: "approved", findings: [{ findingId: "F1", blocking: true }] },
        {
          reviewId: "review-advisory",
          verdict: "changes_requested",
          findings: [{ findingId: "F1", blocking: false }],
        },
      ],
    }),
    cases = [
      { reviewId: "review-missing", findingId: "F1", disposition: "rebut", rationale: "Missing review." },
      { reviewId: "review-approved", findingId: "F1", disposition: "rebut", rationale: "Approved review." },
      { reviewId: "review-advisory", findingId: "F1", disposition: "rebut", rationale: "Non-blocking finding." },
      { reviewId: "review-a", findingId: "F2", disposition: "rebut", rationale: "Unknown finding." },
    ] as const;
  assert.deepEqual(
    issuesFor(snapshot, cases).map(({ code, message }) => ({ code, message })),
    cases.map(({ reviewId, findingId }) => ({
      code: "invalid_transition",
      message: `blocking finding ${reviewId}/${findingId} does not exist`,
    })),
  );
});
