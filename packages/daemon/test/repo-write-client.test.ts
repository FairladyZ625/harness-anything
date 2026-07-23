// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoWriteClient,
  RepoWriteClientClosedError,
  RepoWriteDrainError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteShutdownTimeoutError
} from "../src/runtime/repo-write-client.ts";
import {
  FakeRepoWriteTransport,
  childFrame,
  command,
  fixtureClient,
  parentFrame,
  readyClient,
  readyFrame,
  requestId
} from "./support/repo-write-client-fixture.ts";
import {
  committedCommandReceipt,
  rejectedCommandReceipt
} from "./support/repo-write-terminal-fixture.ts";

test("waits for ready, records prepared opId, proceeds, and resolves only at terminal", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport);

  const ready = client.waitUntilReady();
  transport.emit(readyFrame());
  await ready;

  const result = client.submit(command("task.create"));
  const submit = transport.sent.at(-1);
  const receipt = committedCommandReceipt();
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
    receipt
  });
  assert.deepEqual(await result, receipt);
});

test("resolves an exact rejected terminal receipt instead of converting it to transport failure", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const result = client.submit(command("progress.append"));
  const submit = transport.sent.at(-1);
  const receipt = rejectedCommandReceipt();

  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-rejected"
  });
  transport.emit({
    ...childFrame("terminal"),
    requestId: requestId(submit),
    opId: "op-rejected",
    outcome: "rejected",
    receipt
  });

  assert.deepEqual(await result, receipt);
});

test("binds one non-empty repo to one positive transport generation", () => {
  const transport = new FakeRepoWriteTransport();
  assert.throws(() => new RepoWriteClient({
    repoId: "",
    generation: 7,
    transport,
    onTelemetry: () => undefined
  }), /repoId/u);
  assert.throws(() => new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 0,
    transport,
    onTelemetry: () => undefined
  }), /generation/u);
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
    onTelemetry: () => undefined,
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
    receipt: committedCommandReceipt()
  });
  await assert.rejects(mismatch, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
    assert.equal(error.opId, "op-expected");
    return true;
  });
});

test("fails the generation when terminal outcome disagrees with the exact receipt", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const pending = client.submit(command("progress.append"));
  const submit = transport.sent.at(-1);

  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-mismatch"
  });
  transport.emit({
    ...childFrame("terminal"),
    requestId: requestId(submit),
    opId: "op-mismatch",
    outcome: "committed",
    receipt: rejectedCommandReceipt()
  });

  await assert.rejects(pending, RepoWriteOutcomeUnknownError);
  await assert.rejects(client.submit(command("progress.append")), RepoWriteProtocolViolationError);
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

test("proceed send failures distinguish definitely-not-sent from ambiguous delivery", async () => {
  const submitTransport = new FakeRepoWriteTransport();
  const submitClient = readyClient(submitTransport);
  submitTransport.failSendKind = "submit";
  await assert.rejects(submitClient.submit(command("task.create")), (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    return true;
  });

  const synchronousTransport = new FakeRepoWriteTransport();
  const synchronousClient = readyClient(synchronousTransport);
  const synchronousProceed = synchronousClient.submit(command("fact.record"));
  const synchronousSubmit = synchronousTransport.sent.at(-1);
  synchronousTransport.failSendKind = "proceed";
  synchronousTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(synchronousSubmit),
    opId: "op-sync-proceed-send"
  });
  await assert.rejects(synchronousProceed, (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    assert.equal(error.opId, "op-sync-proceed-send");
    return true;
  });

  const definiteTransport = new FakeRepoWriteTransport();
  const definiteClient = readyClient(definiteTransport);
  const definiteProceed = definiteClient.submit(command("fact.record"));
  const definiteSubmit = definiteTransport.sent.at(-1);
  definiteTransport.rejectSendKind = "proceed";
  definiteTransport.rejectDelivery = "definitely-not-sent";
  definiteTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(definiteSubmit),
    opId: "op-definite-proceed-send"
  });
  await assert.rejects(definiteProceed, (error) => {
    assert.ok(error instanceof RepoWriteNotStartedError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    assert.equal(error.opId, "op-definite-proceed-send");
    return true;
  });

  const ambiguousTransport = new FakeRepoWriteTransport();
  const ambiguousClient = readyClient(ambiguousTransport);
  const ambiguousProceed = ambiguousClient.submit(command("fact.record"));
  const ambiguousSubmit = ambiguousTransport.sent.at(-1);
  ambiguousTransport.rejectSendKind = "proceed";
  ambiguousTransport.rejectDelivery = "possibly-sent";
  ambiguousTransport.emit({
    ...childFrame("prepared"),
    requestId: requestId(ambiguousSubmit),
    opId: "op-ambiguous-proceed-send"
  });
  await assert.rejects(ambiguousProceed, (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "CAPSULE_SEND_FAILED");
    assert.equal(error.opId, "op-ambiguous-proceed-send");
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
