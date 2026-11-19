// harness-test-tier: contract

import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSession } from "@harness-anything/kernel";
import { makeAgentRuntimeStreamHub } from "../src/daemon-host/agent-runtime-stream.ts";
import { consumeDaemonStream, streamInterrupted } from "../src/daemon-host/protocol/stream-client.ts";
import { clientRetryDelay } from "../src/daemon-host/protocol/client-retry.ts";
import { DaemonProtocolContractError } from "../src/daemon-host/protocol/json-rpc-types.ts";
import { emptyRuntimeSnapshot, runtimeCursor } from "./fixtures/runtime-stream.ts";

const sessionId = "runtime-session";
const makeHub = (repoId = "repo-a") =>
  makeAgentRuntimeStreamHub({
    repoId,
    readSession: () => ({ runtimeSessionId: sessionId }) as RuntimeSession,
    canAttach: () => true,
  });

// dec_89D06D7360CBEC09795F7B12EC/CH3. Invalid positions must reset the view at one cut.
test("expired, ahead, cross-repository, cross-kind, and previous-epoch cursors receive a complete snapshot", async () => {
  const hub = makeHub();
  try {
    const first = hub.publish(sessionId, { type: "activity", activity: "message", content: "latest activity" });
    for (let i = 0; i < 31; i++) hub.publish(sessionId, { type: "heartbeat" });
    const head = hub.publish(sessionId, { type: "heartbeat" }).cursor;
    for (const cursor of [
      first.cursor,
      { ...head, seq: head.seq + 1 },
      { ...head, repoId: "repo-b" },
      { ...head, streamKind: "terminal" },
      { ...head, streamEpoch: "previous-epoch" },
    ]) {
      const sub = await hub.attach(sessionId, cursor);
      assert.equal(sub.initial.ok && sub.initial.status, "gap");
      const gap = sub.initial.ok && sub.initial.events[0];
      assert.ok(gap && gap.type === "gap");
      assert.equal(gap.snapshotSeq, head.seq);
      assert.deepEqual(gap.cursor, head);
      assert.equal(gap.snapshot.activity?.content, "latest activity");
      sub.detach();
    }
    const valid = await hub.attach(sessionId, { ...head, seq: 2 });
    assert.equal(valid.initial.ok && valid.initial.status, "attached");
    assert.equal(valid.initial.ok && valid.initial.events.length, 31);
    valid.detach();
  } finally {
    hub.close();
  }
});

test("a lagging subscription replaces its snapshot, resumes after its sequence, and aborts a pending read", async () => {
  const hub = makeHub();
  const controller = new AbortController();
  try {
    const sub = await hub.attach(sessionId, undefined, controller.signal);
    for (let i = 0; i < 33; i++) hub.publish(sessionId, { type: "heartbeat" });
    const gap = await sub.next();
    assert.equal(gap?.type, "gap");
    assert.equal(gap?.type === "gap" && gap.snapshotSeq, 33);
    const next = hub.publish(sessionId, { type: "activity", activity: "tool" });
    assert.equal((await sub.next())?.cursor.seq, next.cursor.seq);
    const waiting = sub.next();
    controller.abort();
    assert.equal(await waiting, null);
  } finally {
    hub.close();
  }
});

test("closing the hub interrupts a live reader and lets a settled reader finish", async () => {
  const hub = makeHub();
  const controller = new AbortController();
  const live = await hub.attach("live");
  const settled = await hub.attach("settled");
  const cancelled = await hub.attach("cancelled", undefined, controller.signal);
  const interrupted = assert.rejects(live.next(), { code: "daemon_stopping" });
  const cancelledRead = cancelled.next();
  const exit = hub.publish("settled", { type: "exit", outcome: "succeeded" });
  hub.close();
  controller.abort();

  await interrupted;
  assert.equal(await cancelledRead, null);
  assert.deepEqual(await settled.next(), exit);
  assert.equal(await settled.next(), null);
});

test("an attach whose repository read outlives hub shutdown reports daemon_stopping", async () => {
  const session = Promise.withResolvers<RuntimeSession | null>();
  const hub = makeAgentRuntimeStreamHub({
    repoId: "repo-a",
    readSession: () => session.promise,
    canAttach: () => true,
  });
  const attaching = hub.attach(sessionId);
  hub.close();
  session.resolve(null);
  await assert.rejects(attaching, { code: "daemon_stopping" });
});

test("an authorized resume crosses process exit and then reaches EOF", async () => {
  let started = true;
  const hub = makeAgentRuntimeStreamHub({
    repoId: "repo-a",
    readSession: (id) => (id === sessionId ? ({ runtimeSessionId: id } as RuntimeSession) : null),
    canAttach: () => started,
  });
  try {
    const expired = hub.publish(sessionId, { type: "activity", activity: "message", content: "before exit" }).cursor;
    for (let i = 0; i < 32; i++) hub.publish(sessionId, { type: "heartbeat" });
    const retained = hub.publish(sessionId, { type: "heartbeat" }).cursor;
    const exit = hub.publish(sessionId, { type: "exit", outcome: "succeeded" });
    started = false;
    assert.equal((await hub.attach(sessionId)).initial.ok, false, "a fresh attach still requires a live process");
    assert.equal((await hub.attach("missing", retained)).initial.ok, false);
    const replay = await hub.attach(sessionId, retained);
    assert.deepEqual(replay.initial.ok && replay.initial.events, [exit]);
    assert.equal(await replay.next(), null);
    const snapshot = await hub.attach(sessionId, expired);
    const frame = snapshot.initial.ok && snapshot.initial.events[0];
    assert.ok(frame && frame.type === "gap");
    assert.equal(frame.snapshot.outcome, "succeeded");
    assert.equal(frame.snapshot.activity?.content, "before exit");
    assert.equal(frame.snapshotSeq, exit.cursor.seq);
    assert.equal(await snapshot.next(), null);
  } finally {
    hub.close();
  }
});

test("a resumed stream lost across daemon restart returns the canonical terminal outcome", async () => {
  const hub = makeAgentRuntimeStreamHub({
    repoId: "repo-a",
    readSession: () => ({ runtimeSessionId: sessionId, outcome: "failed" }) as RuntimeSession,
    canAttach: () => false,
  });
  try {
    const sub = await hub.attach(sessionId, runtimeCursor("repo-a", 7, "before-restart"));
    assert.equal(sub.initial.ok && sub.initial.status, "gap");
    const frame = sub.initial.ok && sub.initial.events[0];
    assert.ok(frame && frame.type === "gap");
    assert.equal(frame.snapshot.outcome, "failed");
    assert.equal(await sub.next(), null);
  } finally {
    hub.close();
  }
});

test("reconnect sends the applied cursor and suppresses duplicate frames", async () => {
  const hub = makeHub();
  const calls: unknown[] = [];
  const applied: number[] = [];
  const delays: number[] = [];
  const controller = new AbortController();
  try {
    await consumeDaemonStream({
      method: "repo.agentRuntime.attach",
      repoId: "repo-a",
      payload: { runtimeSessionId: sessionId },
      signal: controller.signal,
      wait: async (delay) => {
        delays.push(delay);
      },
      read: async (payload, receive) => {
        calls.push(payload);
        const sub = await hub.attach(sessionId, "afterCursor" in payload ? payload.afterCursor : undefined);
        try {
          receive(sub.initial);
          const frame = hub.publish(sessionId, { type: "heartbeat" });
          receive(frame);
          receive(frame);
          if (calls.length === 1) throw streamInterrupted("test disconnect");
        } finally {
          sub.detach();
        }
      },
      onValue: (value) => {
        if (value && typeof value === "object" && "type" in value && "cursor" in value)
          applied.push((value.cursor as ReturnType<typeof runtimeCursor>).seq);
      },
    });
    assert.deepEqual(applied, [1, 2]);
    assert.equal(calls.length, 2);
    assert.equal((calls[1] as { afterCursor: ReturnType<typeof runtimeCursor> }).afterCursor.seq, 1);
    assert.equal(delays.length, 1);
  } finally {
    hub.close();
  }
});

test("stream backoff has jitter, a ceiling and a finite retry budget", () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => clientRetryDelay(i, 0)),
    [125, 250, 500, 1000, 2000, null],
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => clientRetryDelay(i, 0.5)),
    [187, 375, 750, 1500, 3000, null],
  );
});

test("a shutdown retry window expires across stopping, missing sockets and repo warming", async (t) => {
  let elapsed = 0,
    requests = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.method(Math, "random", () => 0);
  await assert.rejects(
    consumeDaemonStream({
      method: "repo.terminal.attach",
      repoId: "repo-a",
      payload: { sessionId, afterSeq: 0 },
      signal: new AbortController().signal,
      wait: async (delay) => {
        assert.ok(delay > 0 && delay <= 5_000);
        elapsed += delay;
      },
      read: async (_payload, receive) => {
        requests++;
        if (requests === 1) receive({ ok: true, sessionId, daemonGeneration: 1, outputSeq: 0 });
        if (requests > 21) assert.fail("shutdown refusals renewed the retry window");
        const code = requests < 7 ? "daemon_stopping" : requests % 2 === 0 ? "daemon_unavailable" : "repo_warming";
        throw new DaemonProtocolContractError(code, "test handoff");
      },
      onValue: () => undefined,
    }),
    { code: "daemon_stream_lost", attempts: 20 },
  );
  assert.equal(elapsed, 40_000);
  assert.equal(requests, 21);
});

test("explicit cancellation stops retries during the shutdown window", async () => {
  const controller = new AbortController();
  let requests = 0;
  await consumeDaemonStream({
    method: "repo.terminal.attach",
    repoId: "repo-a",
    payload: { sessionId, afterSeq: 0 },
    signal: controller.signal,
    wait: async (_delay, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
    },
    read: async (_payload, receive) => {
      requests++;
      receive({ ok: true, sessionId, daemonGeneration: 1, outputSeq: 0 });
      throw new DaemonProtocolContractError("daemon_stopping", "test handoff");
    },
    onValue: () => undefined,
  });
  assert.equal(requests, 1);
});

test("empty replacement epochs exhaust retries and an applied frame replenishes the budget", async () => {
  let requests = 0;
  const waits: number[] = [];
  await assert.rejects(
    consumeDaemonStream({
      method: "repo.agentRuntime.attach",
      repoId: "repo-a",
      payload: { runtimeSessionId: sessionId, afterCursor: runtimeCursor("repo-a", 9) },
      signal: new AbortController().signal,
      wait: async (delay) => {
        waits.push(delay);
      },
      read: async (_payload, receive) => {
        const cursor = runtimeCursor("repo-a", 0, `restarted-${++requests}`);
        const base = {
          runtimeSessionId: sessionId,
          schema: "agent-runtime-attach-event/v2",
          occurredAt: "2026-11-19T00:00:00Z",
        };
        receive({
          ok: true,
          status: "gap",
          runtimeSessionId: sessionId,
          cursor,
          events: [{ ...base, type: "gap", cursor, snapshotSeq: 0, snapshot: emptyRuntimeSnapshot }],
        });
        if (requests === 3) receive({ ...base, type: "heartbeat", cursor: { ...cursor, seq: 1 } });
        if (requests > 8) assert.fail("empty epochs kept replenishing the retry budget");
        throw streamInterrupted("daemon restarted");
      },
      onValue: () => undefined,
    }),
    { code: "daemon_stream_lost", attempts: 5 },
  );
  assert.equal(requests, 8);
  assert.equal(waits.length, 7);
});

test("terminal reconnect preserves the last applied replay position before the attach head", async () => {
  const requests: unknown[] = [];
  const sequence: unknown[] = [];
  await consumeDaemonStream({
    method: "repo.terminal.attach",
    repoId: "repo-a",
    payload: { sessionId, afterSeq: 4 },
    signal: new AbortController().signal,
    wait: async () => undefined,
    read: async (payload, receive) => {
      requests.push(payload);
      receive({ ok: true, sessionId, daemonGeneration: 1, outputSeq: 6 });
      receive({ sessionId, seq: requests.length + 4 });
      if (requests.length === 1) throw streamInterrupted("test disconnect during PTY replay");
    },
    onValue: (value) => {
      if (value && typeof value === "object" && "seq" in value) sequence.push(value.seq);
    },
  });
  assert.deepEqual(requests, [
    { sessionId, afterSeq: 4 },
    { sessionId, afterSeq: 5, daemonGeneration: 1 },
  ]);
  assert.deepEqual(sequence, [5, 6]);
});

test("terminal replay starts at the new generation even when its head has passed the old cursor", async () => {
  const requests: unknown[] = [];
  const sequence: unknown[] = [];
  await consumeDaemonStream({
    method: "repo.terminal.attach",
    repoId: "repo-a",
    payload: { sessionId, afterSeq: 0 },
    signal: new AbortController().signal,
    wait: async () => undefined,
    read: async (payload, receive) => {
      requests.push(payload);
      const generation = requests.length;
      receive({ ok: true, sessionId, daemonGeneration: generation, outputSeq: 5 });
      const frame = { sessionId, seq: generation === 1 ? 4 : 1 };
      receive(frame);
      receive(frame);
      if (generation === 1) throw streamInterrupted("daemon restarted");
    },
    onValue: (value) => {
      if (value && typeof value === "object" && "seq" in value) sequence.push(value.seq);
    },
  });
  assert.deepEqual(requests[1], { sessionId, afterSeq: 4, daemonGeneration: 1 });
  assert.deepEqual(sequence, [4, 1]);
});
