// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { repoWriteCommandActionKinds } from "@harness-anything/application";
import {
  decodeRepoWriteParentMessage,
  repoWriteProtocolType
} from "../src/runtime/repo-write-protocol.ts";
import {
  commandClassForCliActionKind,
  repoCommandRunClassifiedActionKinds
} from "../src/protocol/method-registry.ts";

test("application action authority exactly covers every classified CLI writer kind", () => {
  const classifiedWriterKinds = repoCommandRunClassifiedActionKinds
    .filter((kind) => kind !== "task-complete" && kind !== "task-submit")
    .filter((kind) => {
      const commandClass = commandClassForCliActionKind(kind);
      return commandClass === "repo-write" || commandClass === "arbiter";
    })
    .sort();
  assert.deepEqual([...repoWriteCommandActionKinds].sort(), classifiedWriterKinds);
});

test("all 63 classified CLI writer actions reject a wrong wire shape", async (t) => {
  assert.equal(repoWriteCommandActionKinds.length, 63);
  for (const commandName of repoWriteCommandActionKinds) {
    await t.test(commandName, () => {
      assert.throws(() => decodeRepoWriteParentMessage(frame(commandName, {
        kind: commandName,
        unexpectedWireField: true
      })), /REPO_WRITE_COMMAND_ACTION_INVALID/u);
    });
  }
});

test("doc-sync-submit rejects a wrong typed request shape", () => {
  assert.throws(() => decodeRepoWriteParentMessage({
    protocol: repoWriteProtocolType,
    repoId: "repo-negative-wire",
    generation: 1,
    kind: "direct",
    requestId: "request-doc-sync-submit",
    command: {
      commandName: "doc-sync-submit",
      actor: {},
      context: {},
      payload: {
        command: {
          rootDir: "/repo",
          action: { kind: "doc-sync-submit" },
          request: {}
        },
        session: wireSession()
      }
    }
  }), /REPO_WRITE_COMMAND_ACTION_INVALID/u);
});

test("an unregistered command name has no generic payload fallback", () => {
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("task.create", { kind: "task.create" })),
    /registered repo-write command kind/u
  );
});

function frame(commandName: string, action: Readonly<Record<string, unknown>>): unknown {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-negative-wire",
    generation: 1,
    kind: "submit",
    requestId: `request-${commandName}`,
    command: {
      commandName,
      actor: {},
      context: {},
      payload: {
        command: { rootDir: "/repo", json: true, action },
        session: wireSession()
      }
    }
  };
}

function wireSession(): Readonly<Record<string, string>> {
  return {
    runtime: "codex",
    sessionId: "session-negative-wire",
    source: "runtime",
    detectedAt: "2026-08-05T00:00:00.000Z"
  };
}
