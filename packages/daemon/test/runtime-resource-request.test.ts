// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { openRuntimeResourceHost } from "../src/runtime-resource-host.ts";
import { makeRuntimeResourceRequests } from "../src/runtime-resource-request.ts";
import { defaultRuntimeResourceLimits } from "../src/runtime-resource-admission.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { validateCurrentCanonicalEvent, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import { validateAgentRuntimeSession } from "../src/agent-runtime-contract.ts";
import { runtimeQueueDispatchRow, validRuntimeQueueEntry } from "../src/runtime-resource-read.ts";

type QueuedEvent = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_queued" }>;
const binding = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const };
function fixture() {
  let cpu = 0.2,
    notifications = 0,
    at = 0,
    prepares = 0,
    starts = 0;
  const host = openRuntimeResourceHost("test-node", {
    sample: async () => ({ cores: 4, cpu, cpuMetric: "idle-fraction", availableMemoryFraction: 0.5 }),
    now: () => new Date(at).toISOString(),
    limits: defaultRuntimeResourceLimits(2),
    notify: async () => {
      notifications++;
    },
  });
  const events: QueuedEvent[] = [],
    writes: (() => void | Promise<void>)[] = [],
    failures: unknown[] = [];
  const projection = {
    readRuntimeDispatch: () => null,
    readRuntimeQueue: () => {
      const latest = new Map(events.map((event) => [event.payload.runtimeSessionId, event]));
      return [...latest.values()];
    },
    readRuntimeSession: () => null,
    readRuntimeSessions: () => [],
    readCut: () => ({ status: "ready", watermark: events.length, sourceRevision: events.length }),
  };
  const context = {
    input: {
      repoId: "fixture",
      rootDir: "/nonexistent-resource-fixture",
      resourceAdmission: host,
      now: () => new Date(at).toISOString(),
      projection: () => projection,
      schedule: (work: () => void | Promise<void>) => {
        writes.push(work);
      },
    },
    requiredRuntimeProjection: () => projection,
    requiredRuntimeStore: () => ({
      publication: (event: QueuedEvent) => ({ cut: { opId: event.opId, revision: event.workspaceRevision } }),
    }),
    publishRuntimeEvent: async (
      _type: string,
      payload: QueuedEvent["payload"],
      opId: string,
      actor: typeof binding,
    ) => {
      const event = {
        ...actor,
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_queued",
        payload,
        eventId: opId,
        opId,
        workspaceRevision: events.length + 1,
        occurredAt: new Date(at).toISOString(),
      } as QueuedEvent;
      events.push(event);
      return { event, receipt: { ok: true } };
    },
  } as unknown as RuntimeSpawnerContext;
  const requests = makeRuntimeResourceRequests(context);
  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    while (writes.length) {
      try {
        await writes.shift()!();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  return {
    host,
    requests,
    events,
    failures,
    projection,
    flush,
    counts: () => ({ prepares, starts, notifications }),
    cpu: (value: number) => {
      cpu = value;
    },
    tick: async (time: number) => {
      at = time;
      await host.check();
      await flush();
    },
    request: (
      key: string,
      prepare = async () => {
        prepares++;
      },
    ) =>
      requests.request({ idempotencyKey: key, taskId: "task_test", role: "reviewer" }, binding, prepare, async () => {
        starts++;
        return { ok: true };
      }),
    close: () => {
      requests.close();
      host.close();
    },
  };
}
test("ordinary/reviewer requests wait before preparation, recover FIFO, keep active work, and deduplicate alerts", async () => {
  const f = fixture();
  try {
    const first = await f.request("first"),
      second = await f.request("second");
    assert.equal(first.dispatchStatus, "queued");
    assert.equal(second.dispatchStatus, "queued");
    await f.tick(0);
    await f.tick(60_000);
    await f.tick(90_000);
    assert.deepEqual(f.counts(), { prepares: 0, starts: 0, notifications: 1 });
    assert.equal(f.host.snapshot().alert?.since, new Date(0).toISOString());
    f.cpu(0.8);
    await f.tick(95_000);
    assert.deepEqual(f.counts(), { prepares: 1, starts: 1, notifications: 1 });
    assert.equal(f.host.snapshot().alert, null);
    await f.tick(100_000);
    assert.equal(f.counts().starts, 1);
    f.cpu(0.2);
    await f.tick(105_000);
    await f.tick(165_000);
    assert.equal(f.counts().notifications, 2);
    assert.equal(f.host.snapshot().active, 1);
    await f.host.release(String(first.runtimeSessionId));
    f.cpu(0.8);
    await f.tick(170_000);
    assert.equal(f.counts().starts, 2);
    console.log(JSON.stringify({ queued: first, final: f.host.snapshot(), counts: f.counts() }));
  } finally {
    f.close();
  }
});
test("cancel removes a waiter without holding the publication queue or launching preparation", async () => {
  const f = fixture();
  try {
    const queued = await f.request("cancel");
    await assert.rejects(
      f.requests.cancel(String(queued.runtimeSessionId), { ...binding, actor: { principal: { personId: "other" } } }),
      /another owner/,
    );
    assert.equal((await f.requests.cancel(String(queued.runtimeSessionId), binding))?.dispatchStatus, "cancelled");
    f.cpu(0.2);
    await f.tick(0);
    assert.equal(f.counts().prepares, 0);
    assert.equal(f.host.snapshot().active, 0);
    assert.equal((await f.request("cancel")).dispatchStatus, "cancelled");
  } finally {
    f.close();
  }
});
test("preparation failure releases capacity and preserves its error", async () => {
  const f = fixture();
  try {
    await f.request("failed", async () => {
      throw new Error("setup failed");
    });
    f.cpu(0.8);
    await f.tick(0);
    assert.equal(f.events.at(-1)?.payload.terminal, "failed");
    assert.equal(f.events.at(-1)?.payload.detail, "setup failed");
    assert.equal(f.host.snapshot().active, 0);
    assert.equal(f.counts().starts, 0);
    assert.equal(f.failures.length, 1);
    await f.request("next");
    await f.tick(5000);
    assert.equal(f.counts().starts, 1);
  } finally {
    f.close();
  }
});
test("cancellation during preparation prevents launch and holds capacity until preparation exits", async () => {
  const f = fixture();
  let finish!: () => void;
  try {
    const queued = await f.request(
      "preparing",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.cpu(0.8);
    await f.tick(0);
    await f.requests.cancel(String(queued.runtimeSessionId), binding);
    assert.equal(f.host.snapshot().active, 1);
    finish();
    await f.flush();
    assert.equal(f.counts().starts, 0);
    assert.equal(f.host.snapshot().active, 0);
  } finally {
    f.close();
  }
});
test("restart interrupts projected waiters, and queued reads never invent a running session", async () => {
  const f = fixture();
  try {
    const queued = await f.request("restart"),
      row = runtimeQueueDispatchRow(f.events[0]!.payload);
    assert.equal(row.status, "queued");
    assert.match(row.reason!, /test-node/);
    const reads = makeAgentRuntimeReadModel({ projection: f.projection as never, store: {} as never });
    const result = reads.session({ runtimeSessionId: queued.runtimeSessionId });
    assert.equal(result.session, null);
    assert.equal(result.settlement, null);
    assert.deepEqual(validateAgentRuntimeSession(result), []);
    assert.ok(validateAgentRuntimeSession({ ...result, queue: undefined }).length > 0);
    assert.ok(validateAgentRuntimeSession({ ...result, session: { liveness: "live" } }).length > 0);
    assert.equal(
      validRuntimeQueueEntry({ ...f.events[0]!.payload, blocks: [{ metric: "bogus", observed: 1, threshold: 1 }] }),
      false,
    );
    await f.requests.interrupt();
    const terminal = reads.session({ runtimeSessionId: queued.runtimeSessionId });
    assert.equal(terminal.settlement?.code, "runtime_queue_interrupted");
  } finally {
    f.close();
  }
});
test("OS sample failures surface and never grant a slot", async () => {
  const host = openRuntimeResourceHost("broken", {
    sample: async () => {
      throw new Error("OS read failed");
    },
  });
  try {
    const waiting = host.acquire("one", new Date(0).toISOString());
    await assert.rejects(host.check(), /OS read failed/);
    assert.equal(host.snapshot().sample, null);
    assert.equal(host.snapshot().active, 0);
    await host.cancel("one");
    assert.equal(await waiting, false);
  } finally {
    host.close();
  }
});

test("provider startup failure releases the reserved slot with its own error code", async () => {
  const f = fixture();
  try {
    await f.requests.request(
      { idempotencyKey: "launch-failed" },
      binding,
      async () => null,
      async () => {
        throw Object.assign(new Error("launch refused"), { code: "provider_launch_refused" });
      },
    );
    f.cpu(0.8);
    await f.tick(0);
    assert.equal(f.host.snapshot().active, 0);
    assert.equal(f.events.at(-1)?.payload.failureCode, "provider_launch_refused");
    assert.equal(f.events.at(-1)?.payload.terminal, "failed");
  } finally {
    f.close();
  }
});

// CH2 preserves a closed write contract; queue vocabulary is not a free-form status bag.
test("queued event contract rejects running, unknown metrics, missing identity and foreign payload fields", async () => {
  const f = fixture();
  try {
    await f.request("contract");
    const payload = f.events[0]!.payload;
    assert.deepEqual(validateCurrentCanonicalEvent({ ...f.events[0], payload }), []);
    for (const invalid of [
      { ...payload, terminal: "running" },
      { ...payload, nodeId: "" },
      { ...payload, providerSessionId: "invented" },
      { ...payload, failureCode: 1 },
      { ...payload, blocks: [{ metric: "bogus", observed: 1, threshold: 0.75 }] },
    ])
      assert.ok(validateCurrentCanonicalEvent({ ...f.events[0], payload: invalid }).length > 0);
  } finally {
    f.close();
  }
});
