// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepoWriteChildHost,
  type RepoWriteChildHostHooks
} from "../src/runtime/repo-write-child-host.ts";
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteCommandDto,
  type RepoWriteParentMessage
} from "../src/runtime/repo-write-protocol.ts";

test("host announces ready and executes only after the exact prepared handshake", async () => {
  const fixture = hostFixture();
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return { tag: "COMMITTED", commitSha: "a".repeat(40) };
    }
  });
  const host = fixture.create();

  await host.start();
  await host.receive(submit("request-1"));
  assert.deepEqual(fixture.messages.map((message) => message.kind), ["ready", "prepared"]);
  assert.equal(executions, 0);

  await host.receive(proceed("request-1", "op-request-1"));
  assert.equal(executions, 1);
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("terminal"),
    requestId: "request-1",
    opId: "op-request-1",
    outcome: "committed",
    receipt: { tag: "COMMITTED", commitSha: "a".repeat(40) }
  });
});

test("prepare failures and bounded admission are definitely not started", async () => {
  const fixture = hostFixture({ maxAdmissions: 1 });
  const firstPrepare = deferred<{
    readonly opId: string;
    readonly execute: () => Promise<{ tag: string }>;
  }>();
  fixture.prepare = ({ requestId }) => {
    if (requestId === "request-1") return firstPrepare.promise;
    throw new Error("prepare must not run above the admission bound");
  };
  const host = fixture.create();
  await host.start();

  const first = host.receive(submit("request-1"));
  await Promise.resolve();
  await host.receive(submit("request-2"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-2",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "ADMISSION_FULL"
  });

  firstPrepare.resolve({ opId: "op-1", execute: async () => ({ tag: "COMMITTED" }) });
  await first;
  await host.receive(proceed("request-1", "op-1"));

  fixture.prepare = async () => {
    throw new Error("compile rejected");
  };
  await host.receive(submit("request-3"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-3",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "PREPARE_FAILED"
  });
});

test("retained request history is bounded without forgetting replay protection", async () => {
  const fixture = hostFixture({ maxRetainedOperations: 1 });
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return { tag: "COMMITTED" };
    }
  });
  const host = fixture.create();
  await host.start();

  await host.receive(submit("request-1"));
  await host.receive(proceed("request-1", "op-request-1"));
  await host.receive(submit("request-2"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-2",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "RETAINED_HISTORY_FULL"
  });

  await host.receive(submit("request-1"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-1",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "DUPLICATE_REQUEST",
    opId: "op-request-1"
  });
  assert.equal(executions, 1);
});

test("stale generation, duplicate requests, and opId mismatch never execute", async () => {
  const fixture = hostFixture();
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return { tag: "COMMITTED" };
    }
  });
  const host = fixture.create();
  await host.start();

  await host.receive({ ...submit("stale"), generation: 2 });
  assertFailure(fixture.messages.at(-1), {
    requestId: "stale",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "STALE_GENERATION"
  });
  await host.receive(submit("request-1"));
  await host.receive(submit("request-1"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-1",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "DUPLICATE_REQUEST",
    opId: "op-request-1"
  });
  await host.receive(proceed("request-1", "wrong-op"));
  assert.equal(executions, 0);
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-1",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "OP_ID_MISMATCH",
    opId: "op-request-1"
  });

  await host.receive(proceed("request-1", "op-request-1"));
  await host.receive(proceed("request-1", "op-request-1"));
  assert.equal(executions, 1);
  assert.equal(fixture.messages.at(-1)?.kind, "terminal");
  await host.receive(submit("request-1"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-1",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "DUPLICATE_REQUEST",
    opId: "op-request-1"
  });
});

test("execution errors are outcome-unknown without replay and status uses canonical lookup", async () => {
  const fixture = hostFixture();
  let executions = 0;
  let lookups = 0;
  fixture.prepare = async () => ({
    opId: "op-unknown",
    execute: async () => {
      executions += 1;
      throw new Error("connection lost after publication");
    }
  });
  fixture.lookup = async ({ opId }) => {
    lookups += 1;
    assert.equal(opId, "op-unknown");
    return "committed";
  };
  const host = fixture.create();
  await host.start();
  await host.receive(submit("request-unknown"));
  await host.receive(proceed("request-unknown", "op-unknown"));

  assert.equal(executions, 1);
  assertFailure(fixture.messages.at(-1), {
    requestId: "request-unknown",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "EXECUTION_OUTCOME_UNKNOWN",
    opId: "op-unknown"
  });
  await host.receive(status("status-1", "op-unknown"));
  assert.equal(lookups, 1);
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("status"),
    requestId: "status-1",
    opId: "op-unknown",
    state: "committed"
  });
});

test("shutdown cancels unproceeded admissions and drains after proceeded operations settle", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 500 });
  const execution = deferred<{ tag: string }>();
  let shutdowns = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: () => requestId === "running" ? execution.promise : Promise.resolve({ tag: "unexpected" })
  });
  fixture.shutdown = async () => {
    shutdowns += 1;
  };
  const host = fixture.create();
  await host.start();
  await host.receive(submit("running"));
  const running = host.receive(proceed("running", "op-running"));
  await Promise.resolve();
  await host.receive(submit("waiting"));

  await host.receive(shutdown("shutdown-1"));
  assertFailure(findMessage(fixture.messages, "failure", "waiting"), {
    requestId: "waiting",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "SHUTDOWN_BEFORE_PROCEED",
    opId: "op-waiting"
  });
  assert.equal(fixture.messages.some((message) => message.kind === "drained"), false);
  assert.equal(shutdowns, 0);

  execution.resolve({ tag: "COMMITTED" });
  await running;
  assert.equal(shutdowns, 1);
  const terminalIndex = fixture.messages.findIndex((message) => message.kind === "terminal");
  const drainedIndex = fixture.messages.findIndex((message) => message.kind === "drained");
  assert.ok(terminalIndex >= 0);
  assert.ok(drainedIndex > terminalIndex);
  await host.receive(submit("after-shutdown"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "after-shutdown",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "ADMISSION_CLOSED"
  });
});

test("shutdown timeout never reports drained and a later retry can observe the real drain", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 10 });
  const execution = deferred<{ tag: string }>();
  fixture.prepare = async () => ({
    opId: "op-slow",
    execute: () => execution.promise
  });
  const host = fixture.create();
  await host.start();
  await host.receive(submit("slow"));
  const running = host.receive(proceed("slow", "op-slow"));
  await Promise.resolve();
  await host.receive(shutdown("shutdown-timeout"));
  await delay(30);

  assertFailure(fixture.messages.at(-1), {
    requestId: "shutdown-timeout",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "SHUTDOWN_TIMEOUT"
  });
  assert.equal(fixture.messages.some((message) => message.kind === "drained"), false);

  execution.resolve({ tag: "COMMITTED" });
  await running;
  assert.equal(fixture.messages.some((message) => message.kind === "drained"), false);
  await host.receive(shutdown("shutdown-retry"));
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("drained"),
    requestId: "shutdown-retry"
  });
});

interface HostFixture {
  readonly messages: RepoWriteChildMessage[];
  prepare: RepoWriteChildHostHooks["prepare"];
  lookup: RepoWriteChildHostHooks["lookup"];
  shutdown: RepoWriteChildHostHooks["shutdown"];
  readonly create: () => ReturnType<typeof createRepoWriteChildHost>;
}

function hostFixture(limits: {
  maxAdmissions?: number;
  maxRetainedOperations?: number;
  shutdownTimeoutMs?: number;
} = {}): HostFixture {
  const fixture: HostFixture = {
    messages: [],
    prepare: async ({ requestId }) => ({
      opId: `op-${requestId}`,
      execute: async () => ({ tag: "COMMITTED" })
    }),
    lookup: async () => "not-found",
    shutdown: async () => undefined,
    create: () => createRepoWriteChildHost({
      repoId: "repo-canonical",
      generation: 3,
      transport: {
        send: (message) => {
          fixture.messages.push(message);
        }
      },
      hooks: {
        prepare: (input) => fixture.prepare(input),
        lookup: (input) => fixture.lookup(input),
        shutdown: (input) => fixture.shutdown(input)
      },
      limits
    })
  };
  return fixture;
}

function submit(requestId: string): Extract<RepoWriteParentMessage, { kind: "submit" }> {
  return {
    ...parentBase("submit"),
    requestId,
    command: command()
  };
}

function proceed(requestId: string, opId: string): Extract<RepoWriteParentMessage, { kind: "proceed" }> {
  return { ...parentBase("proceed"), requestId, opId };
}

function status(requestId: string, opId: string): Extract<RepoWriteParentMessage, { kind: "status" }> {
  return { ...parentBase("status"), requestId, opId };
}

function shutdown(requestId: string): Extract<RepoWriteParentMessage, { kind: "shutdown" }> {
  return { ...parentBase("shutdown"), requestId };
}

function command(): RepoWriteCommandDto {
  return {
    commandName: "task.create",
    actor: { personId: "person_zeyu" },
    context: {},
    payload: { title: "writer isolate" }
  };
}

function parentBase<K extends RepoWriteParentMessage["kind"]>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 3,
    kind
  } as const;
}

function childBase<K extends RepoWriteChildMessage["kind"]>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 3,
    kind
  } as const;
}

function assertFailure(
  message: RepoWriteChildMessage | undefined,
  expected: {
    readonly requestId: string;
    readonly phase: "before-proceed" | "after-proceed";
    readonly outcome: "not-started" | "unknown";
    readonly replay: "caller-may-retry" | "forbidden";
    readonly code: string;
    readonly opId?: string;
  }
): void {
  assert.equal(message?.kind, "failure");
  if (message?.kind !== "failure") return;
  assert.deepEqual({
    requestId: message.requestId,
    phase: message.phase,
    outcome: message.outcome,
    replay: message.replay,
    code: message.code,
    ...("opId" in message ? { opId: message.opId } : {})
  }, expected);
}

function findMessage(
  messages: ReadonlyArray<RepoWriteChildMessage>,
  kind: RepoWriteChildMessage["kind"],
  requestId: string
): RepoWriteChildMessage | undefined {
  return messages.find((message) => message.kind === kind && "requestId" in message && message.requestId === requestId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
