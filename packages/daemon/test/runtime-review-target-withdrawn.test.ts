// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { publishExit } from "./runtime-spawn-settlement.fixtures.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import {
  fixtureTaskId,
  workerGitFixture,
  workerSettlementContext,
  workerSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

const withdrawn = () =>
  Object.assign(new Error(`Task ${fixtureTaskId} is not in review.`), { code: "review_admission_denied" });

/**
 * An edge reviewer whose task left in_review (rework, supersession) while it ran: the center refuses
 * to re-admit the review on the settlement's task-context read. Settlement must finish once with a
 * superseded terminal instead of rethrowing, or recovery retries the runtime forever and its
 * unresolved capacity blocks every later dispatch on the same instance.
 */
function edgeReviewerSettlement(
  context: test.TestContext,
  name: string,
  registered: boolean,
  taskContext: () => Promise<never> = async () => {
    throw withdrawn();
  },
) {
  const fixture = workerGitFixture(context, name, { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      finalText: "review in flight when the task was returned",
      publicationOwner: "commander",
      role: "reviewer",
    }),
    outcomes: Record<string, unknown>[] = [],
    terminals: Record<string, unknown>[] = [],
    state = { released: false, recoveries: 0 },
    base = workerSettlementContext(fixture, async (type, payload = {}) => {
      if (type === "runtime_session_outcome_observed") outcomes.push(payload);
      return {};
    }),
    settleContext = {
      ...base,
      input: {
        ...base.input,
        projection: undefined,
        remote: {
          ...base.input.remote!,
          taskContext,
          readReviewerArtifacts: async () => null,
          recoverReviewerReview: async () => {
            state.recoveries += 1;
          },
          reviewerReviewRegistered: async () => registered,
          releaseExecutionCredential: () => {
            state.released = true;
          },
        },
      },
      settleFallback: async (_active: unknown, _attempt: unknown, terminal: Record<string, unknown>) => {
        terminals.push(terminal);
      },
      requiredRuntimeProjection: () => {
        throw new Error("An edge settlement must not read the center-only projection locally.");
      },
    } as unknown as RuntimeSpawnerContext;
  return { runtime, settleContext, outcomes, terminals, state };
}

test("an edge reviewer whose task left review settles superseded once instead of failing recovery", async (context) => {
  const { runtime, settleContext, outcomes, terminals, state } = edgeReviewerSettlement(
    context,
    "settle-edge-review-withdrawn",
    false,
  );
  await publishExit(settleContext, runtime, 0);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.reasonCode, "review_cut_superseded");
  assert.match(
    String((outcomes[0]?.attempt as { readonly reason?: string })?.reason),
    /left review before reviewer settlement: Task task_0123456789abcdef01234567 is not in review/u,
  );
  assert.equal(terminals[0]?.outcome, "superseded");
  assert.equal(state.recoveries, 0, "a withdrawn target must not replay the Review Action at the center");
  assert.equal(state.released, true);
});

test("an edge reviewer whose own registered verdict moved the task out of review keeps its ordinary settlement", async (context) => {
  const { runtime, settleContext, outcomes, terminals } = edgeReviewerSettlement(
    context,
    "settle-edge-review-own-verdict",
    true,
  );
  await publishExit(settleContext, runtime, 0);
  // Same terminal as an edge reviewer whose review is registered and whose task is still in review.
  assert.equal(outcomes[0]?.outcome, "stopped");
  assert.equal(outcomes[0]?.reasonCode ?? null, null);
  assert.notEqual(terminals[0]?.outcome, "superseded");
});

test("an unrelated edge task-context failure still fails reviewer settlement", async (context) => {
  const { runtime, settleContext } = edgeReviewerSettlement(context, "settle-edge-review-read-failed", false, () =>
    Promise.reject(Object.assign(new Error("center unreachable"), { code: "fleet_peer_unavailable" })),
  );
  await assert.rejects(publishExit(settleContext, runtime, 0), /center unreachable/u);
});
