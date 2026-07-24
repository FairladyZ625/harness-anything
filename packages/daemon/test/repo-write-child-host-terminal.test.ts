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

function status(requestId: string, opId: string): Extract<RepoWriteParentMessage, { kind: "status" }> {
  return { ...parentBase("status"), requestId, opId };
}

function parentBase<K extends RepoWriteParentMessage["kind"]>(kind: K) {
  return { protocol: repoWriteProtocolType, repoId: "repo-canonical", generation: 3, kind } as const;
}

function childBase<K extends RepoWriteChildMessage["kind"]>(kind: K) {
  return { protocol: repoWriteProtocolType, repoId: "repo-canonical", generation: 3, kind } as const;
}
