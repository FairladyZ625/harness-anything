// harness-test-tier: fast
// Rolling upgrade: a new client must be able to read a previous daemon's v2 document response.
// Missing v3 fields are normalized to an explicit unobservable answer, never guessed.
import assert from "node:assert/strict";
import test from "node:test";
import { validateDaemonDocumentRead } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResponse } from "../src/protocol/gui-result-validation.ts";

const v2Response = {
  ok: true,
  status: "ready",
  taskId: "task-v2-document",
  path: "task_plan.md",
  body: "# Plan\n",
  blobSha256: "a".repeat(64),
  contentKind: "text",
  mediaType: "text/markdown",
  size: 100,
  bytes: null,
  repositoryPath: "harness/tasks/task-v2-document/task_plan.md",
  worktreeBody: "# Plan\n",
  uncommitted: false,
  watermark: 7,
  sourceRevision: 7,
} as const;

test("a v2 document response from the previous daemon parses as unobservable", () => {
  const parsed = parseDaemonGuiReadResponse("repo.tasks.document.read", v2Response);
  assert.equal(parsed.ok, true);
  assert.equal("source" in parsed ? parsed.source : null, "unobservable");
  assert.equal("syncState" in parsed ? parsed.syncState : null, "unobservable");
  assert.equal("unobservableReason" in parsed ? parsed.unobservableReason : null, "previous_daemon_response");
  assert.equal("canonicalVersion" in parsed ? parsed.canonicalVersion : "missing", null);
  assert.equal("execution" in parsed ? parsed.execution : "missing", null);
  assert.equal("body" in parsed ? parsed.body : "missing", "# Plan\n");
  assert.equal("worktreeBody" in parsed ? parsed.worktreeBody : "missing", "# Plan\n");
  assert.equal("blobSha256" in parsed ? parsed.blobSha256 : "missing", "a".repeat(64));
  assert.equal("size" in parsed ? parsed.size : "missing", 100);
});

test("the v3 writer contract still rejects a response without source metadata", () => {
  const errors = validateDaemonDocumentRead(v2Response);
  assert.match(errors.join("; "), /source.*field is required/u);
});
