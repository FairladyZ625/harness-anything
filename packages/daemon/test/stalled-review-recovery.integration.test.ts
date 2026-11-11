// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, taskId } from "./task-completion-review.fixture.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";

test("a reviewer launch failure closes its admitted attempt without a process or transcript", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false, providerInputLimit: 1 });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    assert.equal(dispatch.payload.role, "reviewer");
    assert.equal(f.launches.length, 0, "launch was rejected before any provider process existed");
    assert.equal(await f.awaitOutcome(dispatch.payload.runtimeSessionId), "failed");
    const events = f.events(),
      stop = events.findIndex(
        (event) =>
          event.type === "runtime_session_exited" &&
          event.payload.runtimeSessionId === dispatch.payload.runtimeSessionId,
      ),
      outcome = events.findIndex(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === dispatch.payload.runtimeSessionId,
      );
    assert.ok(stop >= 0 && outcome > stop, "the accepted stop proof must precede terminal settlement");
    assert.equal(readDispatchStream(f.root, dispatch.payload.dispatchId), null);
  } finally {
    await f.close();
  }
});

test(
  "a first stalled automatic review gets one fresh attempt, while a second stall waits for owner dispatch",
  { timeout: 45_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      stallTimeoutMs: 10_000,
    });
    try {
      await f.install();
      const submitted = await f.submit();
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const initial = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(initial?.type === "runtime_dispatch_requested");
      assert.equal(initial.payload.role, "reviewer");

      assert.equal(await f.awaitOutcome(initial.payload.runtimeSessionId), "failed");
      await f.waitForLaunches(2);
      const retry = f
        .events()
        .filter((event) => event.type === "runtime_dispatch_requested")
        .at(-1);
      assert.ok(retry?.type === "runtime_dispatch_requested");
      assert.equal(retry.payload.taskId, taskId);
      assert.equal(retry.payload.role, "reviewer");
      assert.match(String(retry.payload.dispatchKey), /:attempt1$/u);
      assert.equal(f.launches.length, 2, "one stalled review creates only one automatic follow-up attempt");

      assert.equal(await f.awaitOutcome(retry.payload.runtimeSessionId), "failed");
      await f.run({ kind: "task-show", taskId });
      assert.equal(f.launches.length, 2, "a second stall does not create a third automatic attempt");
    } finally {
      await f.close();
    }
  },
);

test(
  "an unregistered automatic review gets one fresh attempt, while a second missing result waits for owner dispatch",
  { timeout: 45_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
    });
    try {
      await f.install();
      const submitted = await f.submit();
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const initial = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(initial?.type === "runtime_dispatch_requested");

      assert.equal(
        await f.settleReview(initial.payload.dispatchId, initial.payload.runtimeSessionId, "no structured review"),
        "failed",
      );
      await f.waitForLaunches(2);
      const retry = f
        .events()
        .filter((event) => event.type === "runtime_dispatch_requested")
        .at(-1);
      assert.ok(retry?.type === "runtime_dispatch_requested");
      assert.equal(retry.payload.taskId, taskId);
      assert.equal(retry.payload.role, "reviewer");
      assert.match(String(retry.payload.dispatchKey), /:attempt1$/u);
      assert.equal(f.launches.length, 2, "one unregistered review creates only one automatic follow-up attempt");

      assert.equal(
        await f.settleReview(retry.payload.dispatchId, retry.payload.runtimeSessionId, "still no structured review"),
        "failed",
      );
      await f.run({ kind: "task-show", taskId });
      assert.equal(f.launches.length, 2, "a second unregistered review does not create a third automatic attempt");
    } finally {
      await f.close();
    }
  },
);
