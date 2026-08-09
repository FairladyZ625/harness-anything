// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoWriteClient,
  RepoWriteProtocolViolationError,
  RepoWriteStartupStalledError
} from "../src/runtime/repo-write-client.ts";
import {
  FakeRepoWriteTransport,
  childFrame,
  command,
  fixtureClient,
  readyFrame
} from "./support/repo-write-client-fixture.ts";

test("rejects queued work when writer startup makes no semantic progress", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    limits: { readyTimeoutMs: 10, requestTimeoutMs: 50 },
    onTelemetry: () => undefined
  });
  const ready = client.waitUntilReady().then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  const submission = client.submit(command("task.create")).then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );

  const outcome = await Promise.race([
    submission,
    new Promise<{ readonly kind: "still-pending" }>((resolve) => {
      setTimeout(() => resolve({ kind: "still-pending" }), 100);
    })
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.ok(outcome.kind === "rejected" && outcome.error instanceof RepoWriteStartupStalledError);
  assert.equal(outcome.error.code, "REPO_WRITE_STARTUP_STALLED");
  assert.match(outcome.error.message, /startup stalled: no new phase\/work unit/u);
  assert.doesNotMatch(outcome.error.message, /still starting/u);
  const readyOutcome = await ready;
  assert.ok(readyOutcome.kind === "rejected" && readyOutcome.error instanceof RepoWriteStartupStalledError);
  assert.deepEqual(transport.sent, []);
});

test("previously unseen startup work units extend readiness beyond the total stall window", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = new FakeRepoWriteTransport();
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    limits: { readyTimeoutMs: 100 },
    onTelemetry: () => undefined
  });
  const ready = client.waitUntilReady();

  context.mock.timers.tick(90);
  transport.emit({
    ...childFrame("startup-progress"),
    phase: "runtime-start",
    workUnit: "repo-canonical"
  });
  context.mock.timers.tick(90);
  transport.emit({
    ...childFrame("startup-progress"),
    phase: "historical-recovery",
    workUnit: "repo-write:outer-op-1"
  });
  context.mock.timers.tick(90);
  transport.emit(readyFrame());

  await ready;
});

test("repeated startup frames for the same work unit do not conceal a stall", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = new FakeRepoWriteTransport();
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    limits: { readyTimeoutMs: 100 },
    onTelemetry: () => undefined
  });
  const ready = client.waitUntilReady().then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  const repeated = {
    ...childFrame("startup-progress"),
    phase: "historical-recovery" as const,
    workUnit: "repo-write:outer-op-stuck"
  };

  transport.emit(repeated);
  context.mock.timers.tick(60);
  transport.emit(repeated);
  context.mock.timers.tick(39);
  transport.emit(repeated);
  context.mock.timers.tick(1);

  const outcome = await ready;
  assert.equal(outcome.kind, "rejected");
  assert.ok(outcome.kind === "rejected" && outcome.error instanceof RepoWriteStartupStalledError);
  assert.equal(outcome.error.phase, "historical-recovery");
  assert.equal(outcome.error.workUnit, "repo-write:outer-op-stuck");
  assert.equal(outcome.error.repeatedProgressFrames, 2);
  assert.match(outcome.error.message, /workUnit=repo-write:outer-op-stuck, repeatedFrames=2/u);
});

test("startup progress after READY is a protocol violation", async () => {
  const transport = new FakeRepoWriteTransport();
  const client = fixtureClient(transport);
  transport.emit(readyFrame());
  await client.waitUntilReady();

  transport.emit({
    ...childFrame("startup-progress"),
    phase: "runtime-start",
    workUnit: "repo-canonical"
  });

  await assert.rejects(client.submit(command("task.create")), (error) => {
    assert.ok(error instanceof RepoWriteProtocolViolationError);
    assert.match(error.message, /startup progress after READY/u);
    return true;
  });
});
