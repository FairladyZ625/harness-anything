// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createRepoWriteChildHost } from "../src/runtime/repo-write-child-host.ts";
import {
  RepoWriteClient,
  RepoWriteDirectOutcomeUnknownError
} from "../src/runtime/repo-write-client.ts";
import { reportCurrentRepoWriteTelemetry } from "../src/runtime/repo-write-telemetry-context.ts";
import {
  type RepoWriteChildMessage,
  type RepoWriteCommandDto
} from "../src/runtime/repo-write-protocol.ts";
import {
  committedCommandReceipt,
  committedTerminalOutcome
} from "./support/repo-write-terminal-fixture.ts";
import { repoWriteProgressCommand } from "./support/repo-write-command-fixture.ts";

test("direct failure telemetry cannot poison the parent client for the next command", async () => {
  const messages: RepoWriteChildMessage[] = [];
  let directAttempts = 0;
  let childMessageListener: ((message: RepoWriteChildMessage) => void) | undefined;
  const direct = async () => {
    directAttempts += 1;
    if (directAttempts === 1) {
      setImmediate(() => reportCurrentRepoWriteTelemetry("projection"));
      throw new Error("direct fixture failure");
    }
    return committedCommandReceipt("direct recovered");
  };
  const client = new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 3,
    transport: {
      send: (message) => host.receive(message),
      onMessage: (listener) => {
        childMessageListener = listener;
        return () => {
          if (childMessageListener === listener) childMessageListener = undefined;
        };
      },
      onDisconnect: () => () => undefined
    },
    onTelemetry: () => undefined
  });
  const host = createRepoWriteChildHost({
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 3,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport: {
      send: (message) => {
        messages.push(message);
        queueMicrotask(() => childMessageListener?.(message));
      }
    },
    hooks: {
      prepare: async ({ requestId }) => ({
        opId: `op-${requestId}`,
        execute: async () => committedTerminalOutcome(`op-${requestId}`)
      }),
      direct,
      lookup: async () => ({ state: "not-found" }),
      shutdown: async () => undefined
    }
  });

  await host.start();
  await client.waitUntilReady();
  await assert.rejects(client.direct(command()), RepoWriteDirectOutcomeUnknownError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const recovered = await client.direct(command());
  assert.deepEqual(recovered, committedCommandReceipt("direct recovered"));
  assert.equal(directAttempts, 2);
  assert.equal(messages.some((message) => message.kind === "telemetry" && message.phase === "projection"), false);
});

function command(): RepoWriteCommandDto {
  return repoWriteProgressCommand({ personId: "person_zeyu" });
}
