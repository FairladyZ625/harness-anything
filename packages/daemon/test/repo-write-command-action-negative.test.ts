// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { repoWriteCommandActionKinds } from "@harness-anything/application";
import {
  decodeRepoWriteParentMessage,
  repoWriteProtocolType
} from "../src/runtime/repo-write-protocol.ts";
import { repoWriteCommandDtoFromDecodedFields } from "../src/runtime/repo-write-command-dto.ts";
import {
  commandClassForCliActionKind,
  repoCommandRunClassifiedActionKinds
} from "../src/protocol/method-registry.ts";
import { isAuthorityCutoverAction } from "../src/authority/authority-cutover-command.ts";

test("application action authority exactly covers every CLI kind routed to the writer child", () => {
  const classifiedWriterKinds = repoCommandRunClassifiedActionKinds
    .filter((kind) => kind !== "task-complete" && kind !== "task-submit")
    .filter((kind) => {
      const commandClass = commandClassForCliActionKind(kind);
      // Authority cutover controls are admin-class yet still cross the child
      // boundary: a production daemon keeps no authority engine of its own, so
      // the controls must reach the child that owns it. Deriving the expected
      // set from the same predicate the router uses keeps both sides together.
      return commandClass === "repo-write"
        || commandClass === "arbiter"
        || isAuthorityCutoverAction({ kind });
    })
    .sort();
  assert.deepEqual([...repoWriteCommandActionKinds].sort(), classifiedWriterKinds);
});

test("all 70 classified CLI writer actions reject a wrong wire shape", async (t) => {
  assert.equal(repoWriteCommandActionKinds.length, 70);
  for (const commandName of repoWriteCommandActionKinds) {
    await t.test(commandName, () => {
      assert.throws(() => decodeRepoWriteParentMessage(frame(commandName, {
        kind: commandName,
        unexpectedWireField: true
      })), /REPO_WRITE_COMMAND_INVALID/u);
    });
  }
});

test("doc-sync-submit rejects a wrong typed request shape", () => {
  assert.throws(
    () => decodeRepoWriteParentMessage(docSyncFrame({})),
    /REPO_WRITE_COMMAND_INVALID/u
  );
});

test("doc-sync content is a true discriminated union", () => {
  const validRequest = docSyncRequest({ kind: "writer-working-tree/v1" });
  assert.doesNotThrow(() => decodeRepoWriteParentMessage(docSyncFrame(validRequest)));
  for (const content of [{ kind: "inline" }, { kind: "unknown-reference" }]) {
    assert.throws(
      () => decodeRepoWriteParentMessage(docSyncFrame(docSyncRequest(content))),
      /REPO_WRITE_COMMAND_INVALID/u
    );
  }
});

test("CLI wire envelope rejects malformed layout and deprecation contracts", () => {
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("gui", { kind: "gui" }, {
      layoutOverrides: { authoredRoot: 7 }
    })),
    /REPO_WRITE_COMMAND_INVALID/u
  );
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("gui", { kind: "gui" }, {
      deprecatedInvocation: {
        kind: "alias-grammar",
        commandKind: "gui",
        syntax: "gui",
        replacement: "ha gui",
        sunsetStage: "warning",
        decisionId: "dec_UNKNOWN"
      }
    })),
    /REPO_WRITE_COMMAND_INVALID/u
  );
});

test("strict object decoding rejects an empty-string unknown key", () => {
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("gui", { kind: "gui", "": true })),
    /REPO_WRITE_COMMAND_INVALID/u
  );
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("gui", { kind: "gui" }, { "": true })),
    /no unknown fields/u
  );
});

test("decoded DTO construction projects only declared outer fields", () => {
  const input = {
    commandName: "gui",
    actor: {},
    context: {},
    payload: {
      command: { rootDir: "/repo", json: true, action: { kind: "gui" } },
      session: wireSession()
    },
    unexpectedOuterField: "must-not-survive"
  };
  const decoded = repoWriteCommandDtoFromDecodedFields(input);
  assert.equal("unexpectedOuterField" in decoded, false);
});

test("an unregistered command name has no generic payload fallback", () => {
  assert.throws(
    () => decodeRepoWriteParentMessage(frame("task.create", { kind: "task.create" })),
    /registered repo-write command kind/u
  );
});

function frame(
  commandName: string,
  action: Readonly<Record<string, unknown>>,
  commandFields: Readonly<Record<string, unknown>> = {}
): unknown {
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
        command: { rootDir: "/repo", json: true, action, ...commandFields },
        session: wireSession()
      }
    }
  };
}

function docSyncFrame(request: unknown): unknown {
  return {
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
          request
        },
        session: wireSession()
      }
    }
  };
}

function docSyncRequest(content: Readonly<Record<string, unknown>>): unknown {
  return {
    repo: { repoId: "repo-negative-wire" },
    payload: {
      baseLedgerSha: "base-ledger",
      intentId: "intent-negative-wire",
      declaredIntent: "prose-edit",
      changes: [{
        path: "tasks/task_A/note.md",
        baseBlobSha256: null,
        newBlobSha256: "new-blob",
        mediaType: "text/markdown",
        size: 0,
        content
      }]
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
