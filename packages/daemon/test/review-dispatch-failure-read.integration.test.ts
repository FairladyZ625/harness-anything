// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import {
  compileTaskLifecycleWrite,
  reduceTaskEvent,
  sha256Text,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import { openSqliteEventStore } from "@harness-anything/storage";
import { reviewDispatchKey } from "@harness-anything/application/queries";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

type ReviewFixture = Awaited<ReturnType<typeof fixture>>;

async function taskShow(f: ReviewFixture) {
  const receipt = await f.run({ kind: "task-show", taskId });
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  return JSON.parse(String(receipt.evidence));
}

async function agendaText(f: ReviewFixture): Promise<string> {
  return (await f.cell().read("repo.agenda.read", {}, owner)).summary;
}

test("submit --amend hides the previous cut's routing failure and shows a new failure for the same execution", async () => {
  const f = await fixture(false, false, false, true);
  try {
    const recordFailure = async (message: string) => {
      await f.cell().settlePendingMaterialization("review failure fixture");
      const submitted = f.events().findLast((event) => event.type === "execution_submitted");
      assert.ok(submitted?.type === "execution_submitted");
      const receipt = await f.cell().recordReviewDispatchFailure(
        taskId,
        {
          executionId,
          dispatchKey: reviewDispatchKey(taskId, submitted.payload.execution, "closeout-reviewer"),
          code: "agent_runtime_unavailable",
          message,
          failedAt: new Date().toISOString(),
        },
        owner,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    };
    await recordFailure("ORIGINAL_ROUTING_FAILURE");
    assert.match((await taskShow(f)).completionNext.reason, /ORIGINAL_ROUTING_FAILURE/u);
    assert.match(await agendaText(f), /ORIGINAL_ROUTING_FAILURE/u);

    await f.amendSubmit();
    const amended = await taskShow(f);
    assert.equal(amended.task.reviewDispatchFailure?.message, "ORIGINAL_ROUTING_FAILURE");
    assert.doesNotMatch(amended.completionNext.reason, /ORIGINAL_ROUTING_FAILURE/u);
    assert.doesNotMatch(JSON.stringify(amended.reviewDispatchFailures ?? []), /ORIGINAL_ROUTING_FAILURE/u);
    assert.doesNotMatch(await agendaText(f), /ORIGINAL_ROUTING_FAILURE/u);

    await recordFailure("AMENDED_ROUTING_FAILURE");
    const current = await taskShow(f);
    assert.match(current.completionNext.reason, /AMENDED_ROUTING_FAILURE/u);
    assert.equal(current.completionNext.action, `ha task dispatch-review ${taskId}`);
    assert.match(await agendaText(f), /AMENDED_ROUTING_FAILURE/u);
  } finally {
    await f.close();
  }
});

test(
  "with two submitted cuts, task show and agenda identify the exhausted cut and provide an admissible retry",
  { timeout: 60_000 },
  async () => {
    let reject = true;
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
      rejectLaunch: () => (reject ? Object.assign(new Error("CUT_ONE_PROVIDER_FAILURE"), { code: "ENOENT" }) : null),
      keycloakSession: async () => owner.keycloakAuthorization.session,
    });
    try {
      await f.install(null);
      await f.submit();
      await waitForDurableCondition(async () => {
        const attempts = f.events().filter(({ type }) => type === "runtime_dispatch_requested");
        if (attempts.length < 2) return false;
        const read = await f.cell().readDispatchLifecycle({
          by: "dispatch",
          dispatchIds: [attempts.at(-1)!.payload.dispatchId],
        });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });
      await f.cell().settlePendingMaterialization("exhausted review before second cut");
      const initial = await taskShow(f);
      assert.match(initial.completionNext.reason, /CUT_ONE_PROVIDER_FAILURE/u);

      // The normal start command cannot open a parallel cut. Replay the accepted event shape that
      // historical multi-cut tasks carry, then exercise the real read and review admission paths.
      const secondExecutionId = "execution-other-submitted",
        started = f.events().find((event) => event.type === "execution_started"),
        submitted = f.events().find((event) => event.type === "execution_submitted");
      assert.ok(started?.type === "execution_started" && submitted?.type === "execution_submitted");
      const repoId = f.cell().status().repoId;
      await f.cell().close();
      const store = openSqliteEventStore({ repoId, rootInput: f.root });
      try {
        const fence = store.writerFence();
        assert.ok(fence);
        const revision = store.revision();
        let snapshot = initial as TaskLifecycleSnapshot;
        for (const [index, event] of [started, submitted].entries()) {
          const opId = `multi-cut-fixture-${event.type}`,
            execution = { ...event.payload.execution, executionId: secondExecutionId },
            base = {
              ...event,
              eventId: opId,
              opId,
              workspaceRevision: revision + index + 1,
            },
            seed =
              event.type === "execution_started"
                ? {
                    ...base,
                    type: event.type,
                    payload: {
                      ...event.payload,
                      execution,
                      lease: { ...event.payload.lease, executionId: secondExecutionId },
                    },
                  }
                : {
                    ...base,
                    type: event.type,
                    payload: {
                      ...event.payload,
                      execution,
                      // The ledger stores one transition per edge ID and iteration.
                      edge: { ...event.payload.edge!, edgeId: "submitted-second-cut" },
                    },
                  };
          snapshot = reduceTaskEvent(snapshot, seed);
          const { event: published, blobs } = compileTaskLifecycleWrite({
            event: seed,
            snapshot,
            packagePath: f.packagePath,
            currentDocuments: [],
          });
          store.appendCommand({
            fence,
            intent: { opId, intentDigest: `sha256:${sha256Text(opId)}`, summary: event.type },
            events: [published],
            blobs,
          });
        }
      } finally {
        store.close();
        await f.reopen();
      }

      const dispatches = f.events().filter(({ type }) => type === "runtime_dispatch_requested");
      await waitForDurableCondition(async () => {
        const read = await f.cell().readDispatchLifecycle({
          by: "dispatch-batch",
          dispatchIds: dispatches.map(({ payload }) => payload.dispatchId),
        });
        return read.status === "ready";
      });
      const command = `ha task dispatch-review ${taskId} --execution-id ${executionId}`,
        shown = await taskShow(f),
        agenda = await f.cell().read("repo.agenda.read", {}, owner);
      assert.equal(shown.completionBlocker.code, "execution_ambiguous");
      assert.deepEqual(
        shown.reviewDispatchFailures.map(({ executionId, action }: { executionId: string; action: string }) => ({
          executionId,
          action,
        })),
        [{ executionId, action: command }],
      );
      assert.match(shown.reviewDispatchFailures[0].reason, /CUT_ONE_PROVIDER_FAILURE/u);
      const item = agenda.attentionItems.find(({ title }) => title.includes("CUT_ONE_PROVIDER_FAILURE"));
      assert.ok(item, agenda.summary);
      assert.ok(item.title.includes(command), item.title);
      assert.ok(agenda.summary.includes(`ha task dispatch-review ${taskId} --execution-id ${secondExecutionId}`));
      const parsed = parseThinCommand(command.split(" ").slice(1));
      assert.ok(parsed.ok, JSON.stringify(parsed));
      reject = false;
      const retried = await f.run(parsed.command.action as Parameters<typeof f.run>[0]);
      assert.equal(retried.outcome, "applied", JSON.stringify(retried));
      await f.waitForLaunches(1);
      assert.equal(
        f
          .events()
          .filter((event) => event.type === "runtime_dispatch_requested")
          .at(-1)?.payload.executionId,
        executionId,
      );
    } finally {
      await f.close();
    }
  },
);
