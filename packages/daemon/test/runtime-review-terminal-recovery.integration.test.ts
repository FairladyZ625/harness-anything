// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, watch } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  readDispatchStream,
  reopenDispatchStream,
} from "../src/dispatch-stream.ts";
import { fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { waitForArrival } from "./event-arrival.ts";

for (const recovery of ["exit", "recorded-exit", "terminal"] as const) {
  test(`a missing Review settles failed through the canonical writer (${recovery})`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      runtimePid: 2_147_483_647,
      keycloakSession: async () => owner.keycloakAuthorization.session,
    });
    t.after(() => f.close());
    {
      await f.install();
      await f.submit();
      f.disableInstances();
      const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      const { dispatchId, runtimeSessionId } = dispatch.payload;
      if (recovery === "exit") {
        assert.equal(await f.settleReview(dispatchId, runtimeSessionId, "No review was registered."), "failed");
      } else {
        const stream = readDispatchStream(f.root, dispatchId)!;
        const body = "Review was not registered before reviewer settlement.";
        appendRuntimeWorkerRecord(f.root, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
        if (recovery === "terminal")
          reopenDispatchStream(f.root, stream.header).appendTerminalOutcome(
            {
              payload: {
                runtimeSessionId,
                dispatchId,
                outcome: "failed",
                exitCode: 0,
                reasonCode: "review_result_missing",
                resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update(body).digest("hex")}`,
                result: {
                  sha256: createHash("sha256").update(body).digest("hex"),
                  size: Buffer.byteLength(body),
                  mediaType: "text/plain; charset=utf-8",
                },
                endedAt: "2026-11-01T00:00:00.000Z",
              },
              body,
              reason: body,
            },
            "2026-11-01T00:00:00.000Z",
          );
        await f.reopen();
        assert.equal(await f.awaitOutcome(runtimeSessionId), "failed");
      }
      const terminal = f
        .events()
        .find(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        );
      assert.ok(terminal?.type === "runtime_session_outcome_observed");
      assert.equal(terminal.payload.reasonCode, "review_result_missing");
      if (recovery === "terminal") assert.equal(terminal.payload.endedAt, "2026-11-01T00:00:00.000Z");
      const rows = await f.cell().read("repo.task.dispatches", { taskId });
      assert.equal(rows.dispatches.find((row) => row.dispatchId === dispatchId)?.status, "failed");
      const session = await f.cell().read("repo.agentRuntime.sessions.read", { runtimeSessionId: dispatchId });
      assert.equal(session.session.activity.outcome, "failed");
      assert.equal(session.session.liveness, "exited");
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
      await f.reopen();
      assert.equal(
        f
          .events()
          .filter(
            (event) =>
              event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
          ).length,
        1,
      );
    }
  });
}

test("startup archives an already settled dispatch without reopening its done task", { timeout: 20_000 }, async (t) => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "standard",
    runtimePid: 2_147_483_647,
    keycloakSession: async () => owner.keycloakAuthorization.session,
  });
  t.after(() => f.close());
  {
    await f.install();
    await f.submit();
    f.disableInstances();
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const { dispatchId, runtimeSessionId } = dispatch.payload,
      reviewId = `review-${dispatchId}`;
    assert.equal((await f.review(runtimeSessionId, reviewId)).outcome, "applied");
    assert.equal(await f.settleReview(dispatchId, runtimeSessionId, "Review recorded."), "succeeded");
    assert.equal((await f.consent(reviewId)).outcome, "applied");
    assert.equal((await f.complete()).outcome, "applied");
    const live = path.join(resolveHarnessLayout(f.root).localRoot, "runtime", "dispatches", `${dispatchId}.jsonl`);
    // Recreate the crash window after the accepted terminal but before the local rename.
    copyFileSync(dispatchStreamPath(f.root, dispatchId), live);
    const before = f.events().length;
    const archived = waitForArrival(
      () => (!existsSync(live) ? true : null),
      (arrive) => {
        const watcher = watch(path.dirname(live), { signal: t.signal }, arrive);
        return () => watcher.close();
      },
    );
    await f.reopen();
    await archived;
    const shown = await f.run({ kind: "task-show", taskId });
    assert.equal(JSON.parse(String(shown.evidence)).task.status, "done");
    assert.equal(f.events().length, before, "archive repair does not write task or runtime transitions");
    await f.reopen();
    assert.equal(existsSync(live), false);
    assert.equal(f.events().length, before);
  }
});
