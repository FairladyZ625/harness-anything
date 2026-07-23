// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoWriteClient,
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteShutdownTimeoutError,
  type RepoWriteClientTransport
} from "../src/runtime/repo-write-client.ts";
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteParentMessage
} from "../src/runtime/repo-write-protocol.ts";

test("waits for ready, records prepared opId, proceeds, and resolves only at terminal", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport);

  const ready = client.waitUntilReady();
  transport.emit(readyFrame());
  await ready;

  const result = client.submit(command("task.create"));
  const submit = transport.sent.at(-1);
  assert.equal(submit?.kind, "submit");

  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-stable"
  });
  assert.deepEqual(transport.sent.at(-1), {
    ...parentFrame("proceed"),
    requestId: requestId(submit),
    opId: "op-stable"
  });

  transport.emit({
    ...childFrame("terminal"),
    requestId: requestId(submit),
    opId: "op-stable",
    outcome: "committed",
    receipt: { tag: "COMMITTED", commitSha: "a".repeat(40) }
  });
  assert.deepEqual(await result, { tag: "COMMITTED", commitSha: "a".repeat(40) });
});

test("binds one non-empty repo to one positive transport generation", () => {
  const transport = new FakeRepoWriteTransport();
  assert.throws(() => new RepoWriteClient({
    repoId: "",
    generation: 7,
    transport
  }), /repoId/u);
  assert.throws(() => new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 0,
    transport
  }), /generation/u);
});

test("treats duplicate ready for the same repo generation as idempotent", () => {
  const transport = new FakeRepoWriteTransport();
  const violations: RepoWriteProtocolViolationError[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onProtocolViolation: (error) => violations.push(error)
  });

  transport.emit(readyFrame());
  transport.emit(readyFrame());
  void client.submit(command("task.create"));
  assert.deepEqual(transport.sent.map((message) => message.kind), ["submit"]);
  assert.deepEqual(violations, []);
});

test("bounds submissions while the capsule is still waiting for ready", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport, 2);

  void client.submit(command("task.create"));
  void client.submit(command("fact.record"));
  await assert.rejects(client.submit(command("decision.propose")), (error) => {
    assert.ok(error instanceof RepoWriteClientCapacityError);
    assert.equal(error.code, "REPO_WRITE_PENDING_LIMIT");
    return true;
  });
  assert.equal(transport.sent.length, 0);

  transport.emit(readyFrame());
  assert.deepEqual(
    transport.sent.map((message) => message.kind),
    ["submit", "submit"]
  );
});

test("disconnect distinguishes not-started from prepared outcome-unknown without replay", async () => {
  const beforeTransport = new FakeRepoWriteTransport();
  const beforeClient = fixtureClient(beforeTransport);
  beforeTransport.emit(readyFrame());
  const beforePrepared = beforeClient.submit(command("task.create"));
  beforeTransport.disconnect();
  await assert.rejects(beforePrepared, (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "CAPSULE_DISCONNECTED");
    assert.equal(error.outcome, "not-started");
    assert.equal(error.replay, "caller-may-retry");
    assert.equal(error.opId, undefined);
    return true;
  });

  const afterTransport = new FakeRepoWriteTransport();
  const afterClient = fixtureClient(afterTransport);
  afterTransport.emit(readyFrame());
  const afterPrepared = afterClient.submit(command("fact.record"));
  const submit = afterTransport.sent.at(-1);
  afterTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-recovery-handle"
  });
  afterTransport.disconnect();
  await assert.rejects(afterPrepared, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "CAPSULE_DISCONNECTED");
    assert.equal(error.outcome, "unknown");
    assert.equal(error.replay, "forbidden");
    assert.equal(error.opId, "op-recovery-handle");
    return true;
  });
});

test("preserves explicit child failure semantics and stable recovery handles", async () => {
  const beforeTransport = new FakeRepoWriteTransport();
  const beforeClient = readyClient(beforeTransport);
  const before = beforeClient.submit(command("task.create"));
  const beforeSubmit = beforeTransport.sent.at(-1);
  beforeTransport.emit({
    ...childFrame("failure"),
    requestId: requestId(beforeSubmit),
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "COMMAND_REJECTED",
    diagnostic: "command rejected"
  });
  await assert.rejects(before, (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "COMMAND_REJECTED");
    return true;
  });

  const afterTransport = new FakeRepoWriteTransport();
  const afterClient = readyClient(afterTransport);
  const after = afterClient.submit(command("fact.record"));
  const afterSubmit = afterTransport.sent.at(-1);
  afterTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(afterSubmit),
    opId: "op-unknown"
  });
  afterTransport.emit({
    ...childFrame("failure"),
    requestId: requestId(afterSubmit),
    opId: "op-unknown",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "JOURNAL_STATE_UNKNOWN",
    diagnostic: "recovery required"
  });
  await assert.rejects(after, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "JOURNAL_STATE_UNKNOWN");
    assert.equal(error.opId, "op-unknown");
    return true;
  });
});

test("fails the generation on stale child frames instead of accepting or ignoring them", async () => {
  const transport = new FakeRepoWriteTransport();
  const violations: RepoWriteProtocolViolationError[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onProtocolViolation: (error) => violations.push(error)
  });
  transport.emit(readyFrame());
  const pending = client.submit(command("task.create"));
  const submit = transport.sent.at(-1);

  transport.emit({
    ...childFrame("prepared"),
    generation: 6,
    requestId: requestId(submit),
    opId: "op-stale"
  });

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
    return true;
  });
  assert.equal(violations.length, 1);
  await assert.rejects(
    client.submit(command("fact.record")),
    RepoWriteProtocolViolationError
  );
});

test("fails closed on duplicate request frames and opId mismatches", async () => {
  const duplicateTransport = new FakeRepoWriteTransport();
  const duplicateClient = readyClient(duplicateTransport);
  const duplicate = duplicateClient.submit(command("task.create"));
  const duplicateSubmit = duplicateTransport.sent.at(-1);
  duplicateTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(duplicateSubmit),
    opId: "op-first"
  });
  duplicateTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(duplicateSubmit),
    opId: "op-first"
  });
  await assert.rejects(duplicate, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
    assert.equal(error.opId, "op-first");
    return true;
  });

  const mismatchTransport = new FakeRepoWriteTransport();
  const mismatchClient = readyClient(mismatchTransport);
  const mismatch = mismatchClient.submit(command("fact.record"));
  const mismatchSubmit = mismatchTransport.sent.at(-1);
  mismatchTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(mismatchSubmit),
    opId: "op-expected"
  });
  mismatchTransport.emit({
    ...childFrame("terminal"),
    requestId: requestId(mismatchSubmit),
    opId: "op-wrong",
    outcome: "committed",
    receipt: { tag: "COMMITTED" }
  });
  await assert.rejects(mismatch, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
    assert.equal(error.opId, "op-expected");
    return true;
  });
});

test("shutdown closes admission and resolves only after the matching drained frame", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const shutdown = client.shutdown({ timeoutMs: 1_000 });
  const shutdownFrame = transport.sent.at(-1);
  assert.equal(shutdownFrame?.kind, "shutdown");

  let settled = false;
  void shutdown.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(client.submit(command("task.create")), RepoWriteClientClosedError);

  transport.emit({
    ...childFrame("drained"),
    requestId: requestId(shutdownFrame)
  });
  await shutdown;
  assert.equal(settled, true);
});

test("local drain timeout stays on the same generation and never retries shutdown", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);

  await assert.rejects(client.shutdown({ timeoutMs: 10 }), (error) => {
    assert.ok(error instanceof RepoWriteShutdownTimeoutError);
    assert.equal(error.code, "REPO_WRITE_DRAIN_TIMEOUT");
    return true;
  });
  await assert.rejects(client.shutdown({ timeoutMs: 10 }), RepoWriteShutdownTimeoutError);
  assert.deepEqual(
    transport.sent.map((message) => message.kind),
    ["shutdown"]
  );
  assert.equal(client.connectionGeneration, 7);
});

test("correlates child shutdown timeout and failure without retrying or replacing", async () => {
  for (const code of ["SHUTDOWN_TIMEOUT", "SHUTDOWN_FAILED"] as const) {
    const transport = new FakeRepoWriteTransport();
    const client = readyClient(transport);
    const shutdown = client.shutdown({ timeoutMs: 1_000 });
    const shutdownFrame = transport.sent.at(-1);
    transport.emit({
      ...childFrame("failure"),
      requestId: requestId(shutdownFrame),
      phase: "before-proceed",
      outcome: "not-started",
      replay: "caller-may-retry",
      code,
      diagnostic: `${code} fixture`
    });

    await assert.rejects(shutdown, (error) => {
      assert.ok(error instanceof RepoWriteDrainError);
      assert.equal(error.code, code);
      assert.equal(error.outcome, "not-started");
      assert.equal(error.replay, "forbidden");
      return true;
    });
    await assert.rejects(client.shutdown({ timeoutMs: 1_000 }), RepoWriteDrainError);
    assert.deepEqual(transport.sent.map((message) => message.kind), ["shutdown"]);
    assert.equal(client.connectionGeneration, 7);
  }
});

test("transport send failures retain the same before/after prepared recovery boundary", async () => {
  const submitTransport = new FakeRepoWriteTransport();
  const submitClient = readyClient(submitTransport);
  submitTransport.failSendKind = "submit";
  await assert.rejects(submitClient.submit(command("task.create")), (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    return true;
  });

  const proceedTransport = new FakeRepoWriteTransport();
  const proceedClient = readyClient(proceedTransport);
  const proceeding = proceedClient.submit(command("fact.record"));
  const submit = proceedTransport.sent.at(-1);
  proceedTransport.failSendKind = "proceed";
  proceedTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-proceed-send"
  });
  await assert.rejects(proceeding, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    assert.equal(error.opId, "op-proceed-send");
    return true;
  });

  const shutdownTransport = new FakeRepoWriteTransport();
  const shutdownClient = readyClient(shutdownTransport);
  shutdownTransport.failSendKind = "shutdown";
  await assert.rejects(shutdownClient.shutdown({ timeoutMs: 1_000 }), (error) => {
    assert.ok(error instanceof RepoWriteDrainError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    assert.equal(error.replay, "forbidden");
    return true;
  });
  await assert.rejects(shutdownClient.shutdown({ timeoutMs: 1_000 }), RepoWriteDrainError);
  assert.equal(shutdownClient.connectionGeneration, 7);
});

test("rejects a drained acknowledgement while an accepted request is still unresolved", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const write = client.submit(command("task.create"));
  const submit = transport.sent.at(-1);
  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-in-flight"
  });
  const shutdown = client.shutdown({ timeoutMs: 1_000 });
  const shutdownFrame = transport.sent.at(-1);
  transport.emit({
    ...childFrame("drained"),
    requestId: requestId(shutdownFrame)
  });

  await assert.rejects(write, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.opId, "op-in-flight");
    return true;
  });
  await assert.rejects(shutdown, RepoWriteProtocolViolationError);
});

class FakeRepoWriteTransport implements RepoWriteClientTransport {
  readonly sent: RepoWriteParentMessage[] = [];
  failSendKind: RepoWriteParentMessage["kind"] | undefined;
  private messageListener: ((message: RepoWriteChildMessage) => void) | undefined;
  private disconnectListener: ((error: Error) => void) | undefined;

  send(message: RepoWriteParentMessage): void {
    if (message.kind === this.failSendKind) throw new Error(`fixture ${message.kind} send failed`);
    this.sent.push(message);
  }

  onMessage(listener: (message: RepoWriteChildMessage) => void): () => void {
    this.messageListener = listener;
    return () => {
      this.messageListener = undefined;
    };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListener = listener;
    return () => {
      this.disconnectListener = undefined;
    };
  }

  emit(message: RepoWriteChildMessage): void {
    this.messageListener?.(message);
  }

  disconnect(error = new Error("fixture disconnect")): void {
    this.disconnectListener?.(error);
  }
}

function fixtureClient(transport: RepoWriteClientTransport, maxPendingRequests?: number): RepoWriteClient {
  return new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    ...(maxPendingRequests === undefined ? {} : { limits: { maxPendingRequests } })
  });
}

function readyClient(transport: FakeRepoWriteTransport): RepoWriteClient {
  const client = fixtureClient(transport);
  transport.emit(readyFrame());
  return client;
}

function command(commandName: string) {
  return {
    commandName,
    actor: { personId: "person_zeyu" },
    context: {},
    payload: {}
  } as const;
}

function readyFrame(): RepoWriteChildMessage {
  return childFrame("ready");
}

function childFrame<K extends string>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 7,
    kind
  } as const;
}

function parentFrame<K extends string>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 7,
    kind
  } as const;
}

function requestId(message: RepoWriteParentMessage | undefined): string {
  assert.ok(message && "requestId" in message);
  return message.requestId;
}
