// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createRepoWriteChildHost } from "../src/runtime/repo-write-child-host.ts";
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteParentMessage
} from "../src/runtime/repo-write-protocol.ts";
import {
  committedTerminalOutcomeForAxes,
  committedTerminalOutcome,
  committedCommandReceipt,
  rejectedCommandReceipt,
  rejectedTerminalOutcome
} from "./support/repo-write-terminal-fixture.ts";

test("business rejection is a durable rejected terminal rather than an unknown execution failure", async () => {
  const receipt = rejectedCommandReceipt();
  const messages: RepoWriteChildMessage[] = [];
  const host = createHost(messages, (opId) => rejectedTerminalOutcome(opId, receipt));
  await host.start();

  await host.receive(submit("request-rejected"));
  await host.receive(proceed("request-rejected", "op-request-rejected"));
  await host.receive(status("status-rejected", "op-request-rejected"));

  assert.deepEqual(messages.at(-2), {
    ...childBase("terminal"),
    requestId: "request-rejected",
    opId: "op-request-rejected",
    outcome: "rejected",
    receipt
  });
  assert.deepEqual(messages.at(-1), {
    ...childBase("status"),
    requestId: "status-rejected",
    opId: "op-request-rejected",
    state: "rejected",
    outcome: "rejected",
    receipt
  });
});

test("unverified or mismatched outer terminal data stays outcome-unknown", async () => {
  const messages: RepoWriteChildMessage[] = [];
  const host = createHost(messages, () => committedTerminalOutcome("op-different"));
  await host.start();

  await host.receive(submit("request-mismatch"));
  await host.receive(proceed("request-mismatch", "op-request-mismatch"));

  const failure = messages.at(-1);
  assert.equal(failure?.kind, "failure");
  if (failure?.kind !== "failure") return;
  assert.deepEqual({
    requestId: failure.requestId,
    phase: failure.phase,
    outcome: failure.outcome,
    replay: failure.replay,
    code: failure.code,
    opId: failure.opId
  }, {
    requestId: "request-mismatch",
    phase: "after-proceed",
    outcome: "unknown",
    replay: "forbidden",
    code: "EXECUTION_OUTCOME_UNKNOWN",
    opId: "op-request-mismatch"
  });
  assert.equal(messages.some((message) =>
    message.kind === "terminal" && message.requestId === "request-mismatch"), false);
});

test("volatile direct returns an exact receipt without durable frames or lookup", async () => {
  const messages: RepoWriteChildMessage[] = [];
  let preparations = 0;
  let lookups = 0;
  const host = createRepoWriteChildHost({
    ...hostOptions(messages),
    hooks: {
      prepare: async () => {
        preparations += 1;
        throw new Error("direct must not prepare");
      },
      direct: async () => rejectedCommandReceipt(),
      lookup: async () => {
        lookups += 1;
        return { state: "not-found" };
      },
      shutdown: async () => undefined
    }
  });
  await host.start();
  await host.receive(direct("direct-receipt"));

  assert.equal(preparations, 0);
  assert.equal(lookups, 0);
  assert.deepEqual(messages.map((message) => message.kind), ["ready", "direct-result"]);
  assert.deepEqual(messages.at(-1), {
    ...childBase("direct-result"),
    requestId: "direct-receipt",
    receipt: rejectedCommandReceipt()
  });
});

test("durable proceed, replacement recovery, and volatile direct share one FIFO", async () => {
  const messages: RepoWriteChildMessage[] = [];
  const releaseDurable = deferred<void>();
  const releaseRecovery = deferred<void>();
  const effects: string[] = [];
  const host = createRepoWriteChildHost({
    ...hostOptions(messages),
    hooks: {
      prepare: async ({ requestId }) => ({
        opId: `op-${requestId}`,
        execute: async () => {
          effects.push("durable-start");
          await releaseDurable.promise;
          effects.push("durable-end");
          return committedTerminalOutcome(`op-${requestId}`);
        }
      }),
      direct: async () => {
        effects.push("direct");
        return committedCommandReceipt("direct");
      },
      lookup: async () => {
        effects.push("recovery-start");
        await releaseRecovery.promise;
        effects.push("recovery-end");
        return { state: "not-found" };
      },
      shutdown: async () => undefined
    }
  });
  await host.start();
  await host.receive(submit("A"));
  const durable = host.receive(proceed("A", "op-A"));
  await Promise.resolve();
  const recovery = host.receive(status("recovery", "op-recovery"));
  const volatile = host.receive(direct("B"));
  await Promise.resolve();
  assert.deepEqual(effects, ["durable-start"]);

  releaseDurable.resolve();
  await durable;
  await Promise.resolve();
  assert.deepEqual(effects, ["durable-start", "durable-end", "recovery-start"]);
  releaseRecovery.resolve();
  await Promise.all([recovery, volatile]);
  assert.deepEqual(effects, [
    "durable-start", "durable-end", "recovery-start", "recovery-end", "direct"
  ]);
});

test("volatile direct failure is unknown without replay or lookup handle", async () => {
  const messages: RepoWriteChildMessage[] = [];
  let executions = 0;
  const host = createRepoWriteChildHost({
    ...hostOptions(messages),
    hooks: {
      prepare: async () => {
        throw new Error("not used");
      },
      direct: async () => {
        executions += 1;
        throw new Error("lost after direct mutation");
      },
      lookup: async () => ({ state: "not-found" }),
      shutdown: async () => undefined
    }
  });
  await host.start();
  await host.receive(direct("direct-unknown"));
  await host.receive(direct("direct-unknown"));

  assert.equal(executions, 1);
  const failures = messages.filter((message) => message.kind === "direct-failure");
  assert.deepEqual(failures.map((message) => message.code), [
    "DIRECT_EXECUTION_OUTCOME_UNKNOWN",
    "DUPLICATE_REQUEST"
  ]);
  for (const failure of failures) {
    assert.equal(failure.outcome, "unknown");
    assert.equal(failure.replay, "forbidden");
    assert.equal("opId" in failure, false);
  }
});

for (const mismatch of [
  ["repoId", { repoId: "repo-other" }],
  ["workspaceId", { workspaceId: "workspace-other" }],
  ["generation", { generation: 4 }]
] as const) {
  test(`execute rejects proof-valid terminal data from the wrong ${mismatch[0]} axis`, async () => {
    const messages: RepoWriteChildMessage[] = [];
    const host = createHost(
      messages,
      (opId) => committedTerminalOutcomeForAxes(opId, mismatch[1])
    );
    await host.start();
    await host.receive(submit(`request-${mismatch[0]}`));
    await host.receive(proceed(`request-${mismatch[0]}`, `op-request-${mismatch[0]}`));

    const failure = messages.at(-1);
    assert.equal(failure?.kind, "failure");
    assert.equal(failure?.kind === "failure" ? failure.outcome : undefined, "unknown");
    assert.equal(messages.some((message) => message.kind === "terminal"), false);
  });
}

test("canonical lookup rejects proof-valid terminal data with mismatched outer identity", async () => {
  await assertStatusLookupFails(committedTerminalOutcome("op-other"));
});

test("canonical lookup returns a proof-valid historical terminal from an earlier generation", async () => {
  const messages: RepoWriteChildMessage[] = [];
  const receipt = committedCommandReceipt();
  const host = createRepoWriteChildHost({
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 3,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport: { send: (message) => messages.push(message) },
    hooks: {
      prepare: async () => {
        throw new Error("not used");
      },
      lookup: async () => ({
        state: "terminal",
        outcome: committedTerminalOutcomeForAxes(
          "op-historical",
          { generation: 2 }
        )
      }),
      shutdown: async () => undefined
    }
  });
  await host.start();
  await host.receive(status("status-historical", "op-historical"));

  assert.deepEqual(messages.at(-1), {
    ...childBase("status"),
    requestId: "status-historical",
    opId: "op-historical",
    state: "committed",
    outcome: "committed",
    receipt
  });
});

for (const mismatch of [
  ["repoId", { repoId: "repo-other" }],
  ["workspaceId", { workspaceId: "workspace-other" }],
  ["generation", { generation: 4 }]
] as const) {
  test(`canonical lookup rejects proof-valid terminal data from the wrong ${mismatch[0]} axis`, async () => {
    await assertStatusLookupFails(
      committedTerminalOutcomeForAxes("op-expected", mismatch[1])
    );
  });
}

async function assertStatusLookupFails(
  outcome: ReturnType<typeof committedTerminalOutcome>
): Promise<void> {
  const messages: RepoWriteChildMessage[] = [];
  const host = createRepoWriteChildHost({
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 3,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport: { send: (message) => messages.push(message) },
    hooks: {
      prepare: async () => {
        throw new Error("not used");
      },
      lookup: async () => ({
        state: "terminal",
        outcome
      }),
      shutdown: async () => undefined
    }
  });
  await host.start();
  await host.receive(status("status-mismatch", "op-expected"));

  const failure = messages.at(-1);
  assert.equal(failure?.kind, "failure");
  if (failure?.kind !== "failure") return;
  assert.equal(failure.code, "STATUS_LOOKUP_FAILED");
  assert.equal(failure.outcome, "not-started");
  assert.equal(messages.some((message) => message.kind === "status"), false);
}

function createHost(
  messages: RepoWriteChildMessage[],
  outcome: (opId: string) => ReturnType<typeof committedTerminalOutcome>
) {
  return createRepoWriteChildHost({
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 3,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport: { send: (message) => messages.push(message) },
    hooks: {
      prepare: async ({ requestId }) => {
        const opId = `op-${requestId}`;
        return { opId, execute: async () => outcome(opId) };
      },
      lookup: async () => ({ state: "not-found" }),
      shutdown: async () => undefined
    }
  });
}

function hostOptions(messages: RepoWriteChildMessage[]) {
  return {
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 3,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport: { send: (message: RepoWriteChildMessage) => messages.push(message) }
  } as const;
}

function submit(requestId: string): Extract<RepoWriteParentMessage, { kind: "submit" }> {
  return {
    ...parentBase("submit"),
    requestId,
    command: {
      commandName: "progress.append",
      actor: { personId: "person_zeyu" },
      context: {},
      payload: { taskId: "task_01KY", text: "progress" }
    }
  };
}

function proceed(requestId: string, opId: string): Extract<RepoWriteParentMessage, { kind: "proceed" }> {
  return { ...parentBase("proceed"), requestId, opId };
}

function direct(requestId: string): Extract<RepoWriteParentMessage, { kind: "direct" }> {
  return {
    ...parentBase("direct"),
    requestId,
    command: {
      commandName: "task.claim",
      actor: { personId: "person_zeyu" },
      context: {},
      payload: { taskId: "task_direct" }
    }
  };
}

function status(requestId: string, opId: string): Extract<RepoWriteParentMessage, { kind: "status" }> {
  return { ...parentBase("status"), requestId, opId };
}

function parentBase<K extends RepoWriteParentMessage["kind"]>(kind: K) {
  return { protocol: repoWriteProtocolType, repoId: "repo-canonical", generation: 3, kind } as const;
}

function childBase<K extends RepoWriteChildMessage["kind"]>(kind: K) {
  return { protocol: repoWriteProtocolType, repoId: "repo-canonical", generation: 3, kind } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
