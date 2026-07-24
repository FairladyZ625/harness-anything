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
import {
  committedCommandReceipt,
  committedTerminalOutcome
} from "./support/repo-write-terminal-fixture.ts";

test("host announces ready and executes only after the exact prepared handshake", async () => {
  const fixture = hostFixture();
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return committedTerminalOutcome(`op-${requestId}`);
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
    receipt: committedCommandReceipt()
  });
});

test("host accepts an immediate submit as soon as ready becomes observable", async () => {
  const fixture = hostFixture();
  const readyDelivery = deferred<void>();
  fixture.send = (message) => {
    fixture.messages.push(message);
    if (message.kind === "ready") return readyDelivery.promise;
  };
  const host = fixture.create();

  const starting = host.start();
  await Promise.resolve();
  const submitted = host.receive(submit("request-immediate"));
  readyDelivery.resolve();
  await Promise.all([starting, submitted]);

  assert.deepEqual(fixture.messages.map((message) => message.kind), ["ready", "prepared"]);
});

test("prepare failures and bounded admission are definitely not started", async () => {
  const fixture = hostFixture({ maxAdmissions: 1 });
  const firstPrepare = deferred<{
    readonly opId: string;
    readonly execute: () => Promise<ReturnType<typeof committedTerminalOutcome>>;
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

  firstPrepare.resolve({
    opId: "op-1",
    execute: async () => committedTerminalOutcome("op-1")
  });
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
      return committedTerminalOutcome(`op-${requestId}`);
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

test("status admission is bounded but releases capacity and never blocks shutdown", async () => {
  const fixture = hostFixture({ maxControlRequests: 1 });
  const firstLookup = deferred<{ readonly state: "not-found" }>();
  let lookups = 0;
  fixture.lookup = async ({ opId }) => {
    lookups += 1;
    if (opId === "op-1") return firstLookup.promise;
    return { state: "not-found" };
  };
  const host = fixture.create();
  await host.start();

  const pending = host.receive(status("status-1", "op-1"));
  await Promise.resolve();
  await host.receive(status("status-2", "op-2"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "status-2",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "CONTROL_ADMISSION_FULL",
    opId: "op-2"
  });

  await host.receive(status("status-1", "op-1"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "status-1",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "DUPLICATE_REQUEST",
    opId: "op-1"
  });
  firstLookup.resolve({ state: "not-found" });
  await pending;

  await host.receive(status("status-1", "op-1"));
  assert.equal(fixture.messages.at(-1)?.kind, "status");
  await host.receive(shutdown("shutdown-after-status"));
  assert.equal(fixture.messages.at(-1)?.kind, "drained");
  assert.equal(lookups, 2);
});

test("stale generation, duplicate requests, and opId mismatch never execute", async () => {
  const fixture = hostFixture();
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return committedTerminalOutcome(`op-${requestId}`);
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
    return {
      state: "terminal",
      outcome: committedTerminalOutcome(
        opId,
        committedCommandReceipt("canonical recovery")
      )
    };
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
    state: "committed",
    outcome: "committed",
    receipt: committedCommandReceipt("canonical recovery")
  });
});

test("terminal delivery failure does not erase a locally known committed receipt", async () => {
  const fixture = hostFixture();
  const receipt = committedCommandReceipt("terminal delivery");
  fixture.prepare = async () => ({
    opId: "op-terminal-delivery",
    execute: async () => committedTerminalOutcome("op-terminal-delivery", receipt)
  });
  fixture.send = (message) => {
    if (message.kind === "terminal") throw new Error("fixture terminal delivery failed");
    fixture.messages.push(message);
  };
  const host = fixture.create();
  await host.start();
  await host.receive(submit("request-terminal-delivery"));
  await assert.rejects(
    host.receive(proceed("request-terminal-delivery", "op-terminal-delivery")),
    /terminal delivery failed/u
  );

  await host.receive(status("status-terminal-delivery", "op-terminal-delivery"));
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("status"),
    requestId: "status-terminal-delivery",
    opId: "op-terminal-delivery",
    state: "committed",
    outcome: "committed",
    receipt
  });
});

test("status returns the same-generation terminal receipt only when canonical lookup is absent", async () => {
  const fixture = hostFixture();
  const localReceipt = committedCommandReceipt("local recovery");
  fixture.prepare = async () => ({
    opId: "op-local",
    execute: async () => committedTerminalOutcome("op-local", localReceipt)
  });
  const host = fixture.create();
  await host.start();
  await host.receive(submit("request-local"));
  await host.receive(proceed("request-local", "op-local"));

  await host.receive(status("status-local", "op-local"));
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("status"),
    requestId: "status-local",
    opId: "op-local",
    state: "committed",
    outcome: "committed",
    receipt: localReceipt
  });

  fixture.lookup = async () => ({
    state: "terminal",
    outcome: committedTerminalOutcome(
      "op-local",
      committedCommandReceipt("canonical recovery")
    )
  });
  await host.receive(status("status-canonical", "op-local"));
  assert.deepEqual(fixture.messages.at(-1), {
    ...childBase("status"),
    requestId: "status-canonical",
    opId: "op-local",
    state: "committed",
    outcome: "committed",
    receipt: committedCommandReceipt("canonical recovery")
  });
});

test("shutdown waits for admitted status lookup and rejects new lookup admission", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 500 });
  const lookup = deferred<{ readonly state: "not-found" }>();
  let shutdowns = 0;
  fixture.lookup = () => lookup.promise;
  fixture.shutdown = async () => {
    shutdowns += 1;
  };
  const host = fixture.create();
  await host.start();

  const pendingLookup = host.receive(status("status-pending", "op-pending"));
  await Promise.resolve();
  await host.receive(shutdown("shutdown-with-lookup"));
  assert.equal(fixture.messages.some((message) => message.kind === "drained"), false);
  assert.equal(shutdowns, 0);

  await host.receive(status("status-after-shutdown", "op-after-shutdown"));
  assertFailure(fixture.messages.at(-1), {
    requestId: "status-after-shutdown",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "ADMISSION_CLOSED",
    opId: "op-after-shutdown"
  });

  lookup.resolve({ state: "not-found" });
  await pendingLookup;
  assert.equal(shutdowns, 1);
  const statusIndex = fixture.messages.findIndex(
    (message) => message.kind === "status" && message.requestId === "status-pending"
  );
  const drainedIndex = fixture.messages.findIndex(
    (message) => message.kind === "drained" && message.requestId === "shutdown-with-lookup"
  );
  assert.ok(statusIndex >= 0);
  assert.ok(drainedIndex > statusIndex);
});

test("shutdown cancels unproceeded admissions and drains after proceeded operations settle", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 500 });
  const execution = deferred<ReturnType<typeof committedTerminalOutcome>>();
  let shutdowns = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: () => requestId === "running"
      ? execution.promise
      : Promise.resolve(committedTerminalOutcome(`op-${requestId}`, committedCommandReceipt("unexpected")))
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

  execution.resolve(committedTerminalOutcome("op-running"));
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

test("shutdown synchronously closes every prepared operation before sending cancellations", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 500 });
  const firstCancellationSent = deferred<void>();
  let blockFirstCancellation = true;
  let executions = 0;
  fixture.prepare = async ({ requestId }) => ({
    opId: `op-${requestId}`,
    execute: async () => {
      executions += 1;
      return committedTerminalOutcome(`op-${requestId}`);
    }
  });
  fixture.send = (message) => {
    fixture.messages.push(message);
    if (message.kind === "failure" && message.code === "SHUTDOWN_BEFORE_PROCEED" && blockFirstCancellation) {
      blockFirstCancellation = false;
      return firstCancellationSent.promise;
    }
  };
  const host = fixture.create();
  await host.start();
  await host.receive(submit("waiting-1"));
  await host.receive(submit("waiting-2"));

  const shuttingDown = host.receive(shutdown("shutdown-atomic"));
  const rejectedProceed = host.receive(proceed("waiting-2", "op-waiting-2"));
  assert.equal(executions, 0);

  firstCancellationSent.resolve();
  await Promise.all([shuttingDown, rejectedProceed]);
  assert.equal(executions, 0);
  for (const requestId of ["waiting-1", "waiting-2"]) {
    assertFailure(findMessage(fixture.messages, "failure", requestId), {
      requestId,
      phase: "before-proceed",
      outcome: "not-started",
      replay: "caller-may-retry",
      code: "SHUTDOWN_BEFORE_PROCEED",
      opId: `op-${requestId}`
    });
  }
});

test("shutdown timeout never reports drained and a later retry can observe the real drain", async () => {
  const fixture = hostFixture({ shutdownTimeoutMs: 10 });
  const execution = deferred<ReturnType<typeof committedTerminalOutcome>>();
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

  execution.resolve(committedTerminalOutcome("op-slow"));
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
  send: (message: RepoWriteChildMessage) => void | Promise<void>;
  prepare: RepoWriteChildHostHooks["prepare"];
  direct: NonNullable<RepoWriteChildHostHooks["direct"]>;
  lookup: RepoWriteChildHostHooks["lookup"];
  shutdown: RepoWriteChildHostHooks["shutdown"];
  readonly create: () => ReturnType<typeof createRepoWriteChildHost>;
}

function hostFixture(limits: {
  maxAdmissions?: number;
  maxRetainedOperations?: number;
  maxControlRequests?: number;
  shutdownTimeoutMs?: number;
} = {}): HostFixture {
  const fixture: HostFixture = {
    messages: [],
    send: (message) => {
      fixture.messages.push(message);
    },
    prepare: async ({ requestId }) => ({
      opId: `op-${requestId}`,
      execute: async () => committedTerminalOutcome(`op-${requestId}`)
    }),
    direct: async () => committedCommandReceipt("direct"),
    lookup: async () => ({ state: "not-found" }),
    shutdown: async () => undefined,
    create: () => createRepoWriteChildHost({
      repoId: "repo-canonical",
      workspaceId: "workspace-canonical",
      generation: 3,
      artifactIdentity: `sha256:${"a".repeat(64)}`,
      transport: {
        send: (message) => fixture.send(message)
      },
      hooks: {
        prepare: (input) => fixture.prepare(input),
        direct: (input) => fixture.direct(input),
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
