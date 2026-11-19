// harness-test-tier: contract

import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSession } from "@harness-anything/kernel";
import { makeAgentRuntimeStreamHub } from "../src/daemon-host/agent-runtime-stream.ts";
import { consumeDaemonStream, streamInterrupted, streamRetryDelay } from "../src/daemon-host/protocol/stream-client.ts";
import { runtimeCursor } from "./fixtures/runtime-stream.ts";

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
    Array.from({ length: 6 }, (_, i) => streamRetryDelay(i, 0)),
    [125, 250, 500, 1000, 2000, null],
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => streamRetryDelay(i, 0.5)),
    [187, 375, 750, 1500, 3000, null],
  );
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
      receive({ ok: true, sessionId, outputSeq: 6 });
      receive({ sessionId, seq: requests.length + 4 });
      if (requests.length === 1) throw streamInterrupted("test disconnect during PTY replay");
    },
    onValue: (value) => {
      if (value && typeof value === "object" && "seq" in value) sequence.push(value.seq);
    },
  });
  assert.deepEqual(requests, [
    { sessionId, afterSeq: 4 },
    { sessionId, afterSeq: 5 },
  ]);
  assert.deepEqual(sequence, [5, 6]);
});
