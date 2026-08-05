// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DocSyncSubmitRequestV1 } from "@harness-anything/application";
import { sha256Text } from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../src/identity/types.ts";
import type { AuthorityConnectionDispatch } from "../src/protocol/connection-context.ts";
import { RepoWriteIpcPayloadTooLargeError } from "../src/runtime/repo-write-client-errors.ts";
import {
  parseRepoWriteParentMessage,
  repoWriteProtocolType,
  stringifyRepoWriteParentMessage,
  type RepoWriteCommandDto
} from "../src/runtime/repo-write-protocol.ts";
import type { RepoWriteProcessSupervisor } from "../src/runtime/repo-write-process-supervisor.ts";
import { dispatchDocSyncSubmitToWriter } from "../src/service/doc-sync-writer-dispatch.ts";
import { resolveDocSyncChangePath } from "../src/service/doc-sync-writer-working-tree.ts";

test("doc-sync dispatch preserves a non-retryable structured IPC payload-size error", async () => {
  const error = new RepoWriteIpcPayloadTooLargeError(
    "parent",
    "$.command.payload.body",
    "string byte length",
    262_145,
    262_144
  );

  const result = await dispatchDocSyncSubmitToWriter(dispatchInput(request(), async () => {
    throw error;
  }));

  assert.deepEqual(result, {
    ok: false,
    _tag: "WriteRejected",
    schema: "daemon.doc-sync-submit-result/v1",
    status: "rejected",
    intentId: "intent-dispatch",
    code: "doc_sync_invalid_payload",
    reason: error.message,
    retryable: false,
    ipcError: {
      name: error.name,
      code: error.code,
      delivery: error.delivery,
      sender: error.sender,
      path: error.path,
      boundary: error.boundary,
      actualBytes: error.actualBytes,
      maximumBytes: error.maximumBytes,
      excessBytes: error.excessBytes
    }
  });
});

test("doc-sync dispatch rejects an externally supplied writer-working-tree content kind", async () => {
  let directCalls = 0;
  const externalReference = request({ kind: "writer-working-tree/v1" });

  const result = await dispatchDocSyncSubmitToWriter(dispatchInput(externalReference, async () => {
    directCalls += 1;
    return acceptedReceipt();
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "doc_sync_invalid_payload");
    assert.equal(result.retryable, false);
    assert.match(result.reason, /internal writer-working-tree content kind/u);
  }
  assert.equal(directCalls, 0);
});

test("doc-sync's actual dispatch producer survives strict parent-frame serialization", async () => {
  let decodedCommandName: string | undefined;
  await dispatchDocSyncSubmitToWriter(dispatchInput(request(), async (command) => {
    const text = stringifyRepoWriteParentMessage({
      protocol: repoWriteProtocolType,
      repoId: "canonical",
      generation: 1,
      kind: "direct",
      requestId: "request-doc-sync-producer",
      command
    });
    const decoded = parseRepoWriteParentMessage(text);
    assert.equal(decoded.kind, "direct");
    if (decoded.kind === "direct") decodedCommandName = decoded.command.commandName;
    return acceptedReceipt();
  }));

  assert.equal(decodedCommandName, "doc-sync-submit");
});

test("doc-sync dispatch applies authored-root layout overrides before framing", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-dispatch-"));
  const body = "large custom-root evidence\n";
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const targetPath = path.join(rootDir, ".custom-harness", relativePath);
  let framedCommand: RepoWriteCommandDto | undefined;
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, body, "utf8");
    const result = await dispatchDocSyncSubmitToWriter({
      ...dispatchInput(request({ kind: "inline", body }), async (command) => {
        framedCommand = command;
        return acceptedReceipt();
      }),
      rootDir,
      layoutOverrides: { authoredRoot: ".custom-harness" }
    });

    assert.equal(result.ok, true);
    const wireRequest = ((framedCommand?.payload as {
      readonly command?: { readonly request?: DocSyncSubmitRequestV1 };
    }).command?.request);
    assert.equal(wireRequest?.payload.changes[0]?.content.kind, "writer-working-tree/v1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc-sync dispatch rejects an accepted report whose applied change is absent from the reported ledger", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-dispatch-"));
  try {
    const result = await dispatchDocSyncSubmitToWriter({
      ...dispatchInput(request(), async () => acceptedReceipt({
        appliedLedgerSha: "missing-ledger",
        appliedChanges: [{
          path: "tasks/task_A/artifacts/large.raw.jsonl",
          baseBlobSha256: null,
          newBlobSha256: "a".repeat(64),
          zoneClassesTouched: ["task-authored-prose-or-stage"]
        }]
      })),
      rootDir
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "doc_sync_invalid_payload");
      assert.match(result.reason, /reported accepted but did not materialize/u);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc-sync dispatch verifies a materialized blob larger than the default exec buffer", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-dispatch-"));
  const authoredRoot = path.join(rootDir, "authored");
  const body = `${"x".repeat(1_100_000)}\n`;
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  try {
    execFileSync("git", ["init", "-q", authoredRoot]);
    execFileSync("git", ["-C", authoredRoot, "config", "user.name", "Harness Test"]);
    execFileSync("git", ["-C", authoredRoot, "config", "user.email", "harness@example.test"]);
    mkdirSync(path.dirname(path.join(authoredRoot, relativePath)), { recursive: true });
    writeFileSync(path.join(authoredRoot, relativePath), body, "utf8");
    execFileSync("git", ["-C", authoredRoot, "add", relativePath]);
    execFileSync("git", ["-C", authoredRoot, "commit", "-qm", "materialize large blob"]);
    const appliedLedgerSha = execFileSync("git", ["-C", authoredRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const largeRequest = request({ kind: "inline", body });

    const result = await dispatchDocSyncSubmitToWriter({
      ...dispatchInput(largeRequest, async () => acceptedReceipt({
        appliedLedgerSha,
        appliedChanges: [{
          path: relativePath,
          baseBlobSha256: null,
          newBlobSha256: sha256Text(body),
          zoneClassesTouched: ["task-authored-prose-or-stage"]
        }]
      })),
      rootDir,
      layoutOverrides: { authoredRoot: "authored" }
    });

    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("writer working-tree paths use the canonical portable path normalizer", () => {
  const backslash = resolveDocSyncChangePath("/tmp/authored", "tasks\\task_A\\note.md");
  const nul = resolveDocSyncChangePath("/tmp/authored", "tasks/task_A/note\0.md");
  const nfc = resolveDocSyncChangePath("/tmp/authored", "notes/cafe\u0301.md");
  assert.equal(backslash.ok, false);
  assert.equal(nul.ok, false);
  assert.equal(nfc.ok, true);
  if (!backslash.ok) assert.match(backslash.reason, /POSIX separators/u);
  if (!nul.ok) assert.match(nul.reason, /NUL/u);
  if (nfc.ok) assert.equal(nfc.path, path.resolve("/tmp/authored", "notes/café.md"));
});

function request(
  content: DocSyncSubmitRequestV1["payload"]["changes"][number]["content"] = {
    kind: "inline",
    body: "inline evidence\n"
  }
): DocSyncSubmitRequestV1 {
  return {
    repo: { repoId: "canonical" },
    session: {
      sessionId: "session-dispatch",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-31T00:00:00.000Z"
    },
    payload: {
      baseLedgerSha: "base",
      intentId: "intent-dispatch",
      declaredIntent: "session-export",
      changes: [{
        path: "tasks/task_A/artifacts/large.raw.jsonl",
        baseBlobSha256: null,
        newBlobSha256: "a".repeat(64),
        mediaType: "application/jsonl",
        size: "body" in content && typeof content.body === "string" ? Buffer.byteLength(content.body) : 0,
        content
      }]
    }
  };
}

function dispatchInput(
  docSyncRequest: DocSyncSubmitRequestV1,
  direct: (command: RepoWriteCommandDto) => Promise<ReturnType<typeof acceptedReceipt>>
) {
  const actor: AuthenticatedActor = {
    personId: "person_local",
    displayName: "Local Person",
    providerId: "local-socket",
    resolvedCredential: {
      kind: "unix-socket-owner-boundary",
      issuer: "fixture",
      subject: "501"
    }
  };
  const authority: AuthorityConnectionDispatch = {
    available: true,
    assertActive: () => undefined,
    context: {
      schema: "authority-connection-context/v1",
      connectionId: "connection-dispatch",
      connectionGeneration: "generation-dispatch" as never,
      actor,
      repoId: "canonical",
      channelBinding: {
        digest: Buffer.alloc(32, 0x61) as never,
        source: "transport-observed"
      },
      peerCredential: {
        schema: "os-observed-peer-credential/v1",
        platform: "darwin",
        source: "getpeereid",
        uid: 501,
        gid: 20
      }
    }
  };
  return {
    rootDir: "/tmp/doc-sync-dispatch",
    request: docSyncRequest,
    actor,
    authority,
    supervisor: { direct } as unknown as RepoWriteProcessSupervisor
  };
}

function acceptedReceipt(overrides: {
  readonly appliedLedgerSha?: string;
  readonly appliedChanges?: ReadonlyArray<{
    readonly path: string;
    readonly baseBlobSha256: string | null;
    readonly newBlobSha256: string;
    readonly zoneClassesTouched: ReadonlyArray<string>;
  }>;
} = {}) {
  return {
    ok: true as const,
    schema: "command-receipt/v2" as const,
    command: "repo.doc.sync.submit",
    action: "submit",
    summary: "accepted",
    next: [],
    details: {
      data: {
        ok: true,
        schema: "daemon.doc-sync-submit-result/v1",
        status: "accepted",
        intentId: "intent-dispatch",
        baseLedgerSha: "base",
        appliedLedgerSha: overrides.appliedLedgerSha ?? "head",
        appliedChanges: overrides.appliedChanges ?? []
      }
    },
    meta: {
      generatedAt: "2026-07-31T00:00:00.000Z",
      compatibility: {}
    }
  };
}
