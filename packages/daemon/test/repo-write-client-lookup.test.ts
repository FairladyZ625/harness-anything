// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoWriteClient,
  RepoWriteClientCapacityError,
  RepoWriteClientClosedError,
  RepoWriteLookupError,
  RepoWriteProtocolViolationError
} from "../src/runtime/repo-write-client.ts";
import type { RepoWriteChildMessage } from "../src/runtime/repo-write-protocol.ts";
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

test("treats duplicate ready for the same repo generation as idempotent", () => {
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
  transport.emit(readyFrame());
  void client.submit(command("task.create"));
  assert.deepEqual(transport.sent.map((message) => message.kind), ["submit"]);
  assert.deepEqual(violations, []);
});

test("shares one bounded ready promise across all startup waiters", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport, 1);
  const first = client.waitUntilReady();
  const second = client.waitUntilReady();

  assert.equal(first, second);
  transport.emit(readyFrame());
  await Promise.all([first, second]);
  await client.waitUntilReady();

  const closingTransport = new FakeRepoWriteTransport();
  const closingClient = fixtureClient(closingTransport);
  const waiting = closingClient.waitUntilReady();
  const shutdown = closingClient.shutdown({ timeoutMs: 1_000 });
  await assert.rejects(waiting, RepoWriteClientClosedError);
  closingTransport.emit(readyFrame());
  const shutdownRequest = closingTransport.sent.at(-1);
  closingTransport.emit({
    ...childFrame("drained"),
    requestId: requestId(shutdownRequest)
  });
  await shutdown;
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

test("queues lookup until ready, observes correlated telemetry, and returns the original terminal receipt", async () => {
  const transport = new FakeRepoWriteTransport();
  const telemetry: RepoWriteChildMessage[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: (frame) => telemetry.push(frame)
  });
  const result = client.lookup("op-recovery");
  assert.equal(transport.sent.length, 0);

  transport.emit(readyFrame());
  const statusRequest = transport.sent.at(-1);
  assert.deepEqual(statusRequest, {
    ...parentFrame("status"),
    requestId: requestId(statusRequest),
    opId: "op-recovery"
  });
  const receipt = committedCommandReceipt();
  transport.emit({
    ...childFrame("telemetry"),
    requestId: requestId(statusRequest),
    opId: "op-recovery",
    phase: "total",
    elapsedMs: 12.5
  });
  transport.emit({
    ...childFrame("status"),
    requestId: requestId(statusRequest),
    opId: "op-recovery",
    state: "committed",
    outcome: "committed",
    receipt
  });

  assert.deepEqual(await result, {
    state: "committed",
    outcome: "committed",
    receipt
  });
  assert.equal(telemetry.length, 1);
});

test("reconnect lookup returns the exact rejected terminal receipt", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const receipt = rejectedCommandReceipt();
  const result = client.lookup("op-rejected");
  const statusRequest = transport.sent.at(-1);

  transport.emit({
    ...childFrame("status"),
    requestId: requestId(statusRequest),
    opId: "op-rejected",
    state: "rejected",
    outcome: "rejected",
    receipt
  });

  assert.deepEqual(await result, {
    state: "rejected",
    outcome: "rejected",
    receipt
  });
});

test("lookup failures stay retryable and do not enter mutation outcome semantics", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = readyClient(transport);
  const result = client.lookup("op-missing");
  const statusRequest = transport.sent.at(-1);
  transport.emit({
    ...childFrame("failure"),
    requestId: requestId(statusRequest),
    opId: "op-missing",
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "STATUS_LOOKUP_FAILED",
    diagnostic: "lookup unavailable"
  });

  await assert.rejects(result, (error) => {
    assert.ok(error instanceof RepoWriteLookupError);
    assert.equal(error.code, "STATUS_LOOKUP_FAILED");
    assert.equal(error.opId, "op-missing");
    assert.equal(error.replay, "caller-may-retry");
    return true;
  });
});

test("fails closed on mismatched status and telemetry correlation", async () => {
  for (const kind of ["status", "telemetry"] as const) {
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
    const result = client.lookup("op-expected");
    const request = transport.sent.at(-1);
    transport.emit(kind === "status" ? {
      ...childFrame("status"),
      requestId: requestId(request),
      opId: "op-wrong",
      state: "not-found"
    } : {
      ...childFrame("telemetry"),
      requestId: requestId(request),
      opId: "op-wrong",
      phase: "total",
      elapsedMs: 1
    });

    await assert.rejects(result, (error) => {
      assert.ok(error instanceof RepoWriteLookupError);
      assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
      assert.equal(error.opId, "op-expected");
      return true;
    });
    assert.equal(violations.length, 1);
  }
});

test("telemetry and protocol observers cannot escape fail-closed cleanup", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: () => {
      throw new Error("fixture telemetry observer failure");
    },
    onProtocolViolation: () => {
      throw new Error("fixture protocol observer failure");
    }
  });
  transport.emit(readyFrame());
  const result = client.lookup("op-observer");
  const request = transport.sent.at(-1);
  transport.emit({
    ...childFrame("telemetry"),
    requestId: requestId(request),
    opId: "op-observer",
    phase: "total",
    elapsedMs: 1
  });

  await assert.rejects(result, (error) => {
    assert.ok(error instanceof RepoWriteLookupError);
    assert.equal(error.code, "REPO_WRITE_PROTOCOL_VIOLATION");
    assert.equal(error.opId, "op-observer");
    return true;
  });
  await assert.rejects(client.lookup("op-after-observer"), RepoWriteProtocolViolationError);
});

test("counts lookup and mutation requests against one pending capacity bound", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport, 1);
  void client.lookup("op-pending");
  await assert.rejects(client.submit(command("task.create")), RepoWriteClientCapacityError);
});

test("lookup releases its pending capacity when the child misses the request deadline", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    limits: {
      maxPendingRequests: 1,
      requestTimeoutMs: 20
    },
    onTelemetry: () => undefined
  });
  transport.emit(readyFrame());

  await assert.rejects(client.lookup("op-timeout"), (error) => {
    assert.ok(error instanceof RepoWriteLookupError);
    assert.equal(error.code, "REPO_WRITE_LOOKUP_TIMEOUT");
    return true;
  });
  const next = client.lookup("op-after-timeout");
  assert.equal(
    transport.sent.filter((message) => message.kind === "status").length,
    2
  );
  void next.catch(() => undefined);
});
