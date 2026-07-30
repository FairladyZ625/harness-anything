// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  RepoWriteClient,
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteNotStartedError
} from "../src/runtime/repo-write-client.ts";
import type {
  RepoWriteRequestFailureDiagnostic,
  RepoWriteRequestTimeoutDiagnostic
} from "../src/runtime/repo-write-client-contract.ts";
import {
  formatRepoWriteFailureDiagnostic,
  formatRepoWriteTimeoutDiagnostic
} from "../src/runtime/repo-write-stall-diagnostic.ts";
import {
  FakeRepoWriteTransport,
  childFrame,
  command,
  readyFrame,
  requestId
} from "./support/repo-write-client-fixture.ts";
import { committedCommandReceipt } from "./support/repo-write-terminal-fixture.ts";

test("timeout diagnostics name the child wait for every authority submission ingress", async () => {
  const cases = [
    { ingress: "generic", commandName: "task-create" },
    { ingress: "provenance-session", commandName: "session-start" },
    { ingress: "decision-transition", commandName: "decision-transition" },
    { ingress: "task-claim", commandName: "task-claim" },
    { ingress: "observed-write", commandName: "task-amend" },
    { ingress: "script-ingest", commandName: "script-run" }
  ] as const;

  for (const fixture of cases) {
    const transport = new FakeRepoWriteTransport();
    let observed: RepoWriteRequestTimeoutDiagnostic | undefined;
    const client = new RepoWriteClient({
      repoId: "repo-canonical",
      generation: 7,
      transport,
      limits: { requestTimeoutMs: 10 },
      onTelemetry: () => undefined,
      onRequestTimeout: (diagnostic) => {
        observed = diagnostic;
      }
    });
    transport.emit(readyFrame());

    const result = client.direct(command(fixture.commandName));
    const request = transport.sent.at(-1);
    transport.emit({
      ...childFrame("telemetry"),
      requestId: requestId(request),
      phase: "projection",
      elapsedMs: 3
    });

    await assert.rejects(result, RepoWriteDirectOutcomeUnknownError);
    assert.ok(observed, `missing timeout diagnostic for ${fixture.ingress}`);
    assert.equal(observed.commandName, fixture.commandName);
    assert.match(
      formatRepoWriteTimeoutDiagnostic(observed),
      /waiting=daemon-write-queue:authority-publication;lastPhase=projection/u
    );
  }
});

test("durable timeout diagnostics retain the last child phase and recovery handle", async () => {
  const transport = new FakeRepoWriteTransport();
  let observed: RepoWriteRequestTimeoutDiagnostic | undefined;
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    // The stall escalation deadline is pushed far out so this test only
    // exercises the observation diagnostic; the 20ms wait below must never
    // race the escalation timer on a slow runner.
    limits: { requestTimeoutMs: 10, proceededStallTimeoutMs: 5000 },
    onTelemetry: () => undefined,
    onRequestTimeout: (diagnostic) => {
      observed = diagnostic;
    }
  });
  transport.emit(readyFrame());

  const result = client.submit(command("task-create"));
  const submit = transport.sent.at(-1);
  transport.emit({
    ...childFrame("prepared"),
    requestId: requestId(submit),
    opId: "op-timeout-diagnostic"
  });
  transport.emit({
    ...childFrame("telemetry"),
    requestId: requestId(submit),
    opId: "op-timeout-diagnostic",
    phase: "git",
    elapsedMs: 4
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.ok(observed);
  assert.equal(observed.lane, "durable");
  assert.equal(observed.opId, "op-timeout-diagnostic");
  assert.match(
    formatRepoWriteTimeoutDiagnostic(observed),
    /waiting=canonical-git-publication;lastPhase=git/u
  );
  transport.emit({
    ...childFrame("terminal"),
    requestId: requestId(submit),
    opId: "op-timeout-diagnostic",
    outcome: "committed",
    receipt: committedCommandReceipt("slow publication")
  });
  assert.equal((await result).summary, "slow publication");
});

test("explicit direct and durable failures report their last named child wait", async () => {
  const transport = new FakeRepoWriteTransport();
  const failures: RepoWriteRequestFailureDiagnostic[] = [];
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: () => undefined,
    onRequestFailure: (diagnostic) => failures.push(diagnostic)
  });
  transport.emit(readyFrame());

  const direct = client.direct(command("task-claim"));
  const directRequest = transport.sent.at(-1);
  transport.emit({
    ...childFrame("telemetry"),
    requestId: requestId(directRequest),
    phase: "compile",
    elapsedMs: 2
  });
  transport.emit({
    ...childFrame("direct-failure"),
    requestId: requestId(directRequest),
    outcome: "unknown",
    replay: "forbidden",
    code: "DIRECT_FAILED",
    diagnostic: "direct fixture failed"
  });
  await assert.rejects(direct, RepoWriteDirectOutcomeUnknownError);

  const durable = client.submit(command("task-create"));
  const durableRequest = transport.sent.at(-1);
  transport.emit({
    ...childFrame("telemetry"),
    requestId: requestId(durableRequest),
    phase: "git",
    elapsedMs: 4
  });
  transport.emit({
    ...childFrame("failure"),
    requestId: requestId(durableRequest),
    phase: "before-proceed",
    outcome: "not-started",
    replay: "caller-may-retry",
    code: "DURABLE_FAILED",
    diagnostic: "durable fixture failed"
  });
  await assert.rejects(durable, RepoWriteNotStartedError);

  assert.deepEqual(
    failures.map((failure) => ({
      commandName: failure.commandName,
      lane: failure.lane,
      code: failure.code
    })),
    [
      { commandName: "task-claim", lane: "direct", code: "DIRECT_FAILED" },
      { commandName: "task-create", lane: "durable", code: "DURABLE_FAILED" }
    ]
  );
  assert.match(
    formatRepoWriteFailureDiagnostic(failures[0]!),
    /waiting=command-or-authority-attempt-compilation;lastPhase=compile/u
  );
  assert.match(
    formatRepoWriteFailureDiagnostic(failures[1]!),
    /waiting=canonical-git-publication;lastPhase=git/u
  );
});
