// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { replicationCommitChunks } from "@harness-anything/storage";
import { openReplicationCommitFile } from "../src/fleet/commit-file.ts";
import { runWalReceiver } from "../src/fleet/walreceiver.ts";
import { parseReplicationCommit, type ReplicationFrame } from "../src/fleet/protocol.ts";

const position = { history: "history", sequence: 1, revision: 0 };
const commit = { position, events: [], outcome: null, writer: null };

test("stream parsing retains claimed and retired paths without replaying staged rows", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-commit-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const digest = `sha256:${"a".repeat(64)}`,
    claim = { sha256: "a".repeat(64), size: 1, mediaType: "text/markdown" },
    row = {
      revision: 1,
      opId: "op",
      eventJson: JSON.stringify({
        schema: "doc-event/v1",
        type: "documents_written",
        payload: {
          changes: [
            { path: "new.md", candidate: claim, baseBlobSha256: null },
            { path: "new.md", candidate: claim, baseBlobSha256: null },
            { path: "old.md", candidate: null, baseBlobSha256: claim.sha256 },
          ],
        },
      }),
      occurredAt: "now",
      recordedAt: "now",
      digest,
    },
    staged = openReplicationCommitFile(path.join(root, "rows"), 64);
  try {
    staged.write(
      Buffer.from(
        JSON.stringify({
          ...commit,
          position: { ...position, revision: 1 },
          events: [row],
          outcome: {
            opId: "op",
            status: "accepted_durable",
            firstRevision: 1,
            lastRevision: 1,
            intentDigest: digest,
            summary: "paths",
            rejectionCode: null,
            recordedAt: "now",
            memberOpIds: ["op"],
          },
        }),
      ),
    );
    assert.deepEqual(staged.changedPaths(), ["new.md", "old.md"]);
    assert.deepEqual([...staged.finish().events], [row]);
  } finally {
    staged.close();
  }
});

test("record-wise encoding preserves the N-1 envelope byte for byte; staging accepts arbitrary byte boundaries", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-commit-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unicode = {
    ...commit,
    outcome: {
      opId: "op",
      status: "rejected" as const,
      firstRevision: null,
      lastRevision: null,
      intentDigest: `sha256:${"a".repeat(64)}`,
      summary: '台灣😀\\"\n',
      rejectionCode: "test",
      recordedAt: "now",
      memberOpIds: [],
    },
  };
  const wire = [...replicationCommitChunks(unicode)].join("");
  assert.equal(wire, JSON.stringify(unicode));
  const staged = openReplicationCommitFile(path.join(root, "rows"), 64);
  try {
    for (const byte of Buffer.from(wire)) staged.write(Buffer.from([byte]));
    const decoded = staged.finish();
    assert.deepEqual({ ...decoded, events: [...decoded.events] }, parseReplicationCommit(Buffer.from(wire)));
    assert.deepEqual([...decoded.events], [...decoded.events], "staged rows are replayable");
  } finally {
    staged.close();
    staged.close();
  }
  assert.deepEqual(readdirSync(root), [], "closing staging twice is harmless and leaves no file");
});

test("staged envelopes retain the protocol shape boundary", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-commit-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, wire] of [
    JSON.stringify({ ...commit, events: null }),
    JSON.stringify({ ...commit, extra: true }),
    JSON.stringify({ ...commit, position: { ...position, sequence: -1 } }),
    JSON.stringify(commit).slice(0, -1),
    JSON.stringify(commit).replace('"events":[]', '"events":{},"events":[]'),
    "[]",
  ].entries()) {
    const staged = openReplicationCommitFile(path.join(root, String(index)), 64);
    try {
      assert.throws(() => {
        staged.write(Buffer.from(wire));
        staged.finish();
      });
    } finally {
      staged.close();
    }
  }
});

test("quota, truncated transfer and malformed commit carry context and leave no staged files or apply", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-commit-abort-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["quota", "truncated", "malformed", "cancelled"] as const) {
    const signal = new AbortController();
    const frames: ReplicationFrame[] = [
      { type: "replica.accept", centerBuildCommit: null, taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION },
      { type: "replica.commit", size: mode === "quota" ? 1000 : 4 },
      { type: "replica.data", offset: 0, data: Buffer.from(mode === "malformed" ? "null" : "{").toString("base64") },
    ];
    let applied = false;
    const stopped = new Error("cancelled transfer");
    await assert.rejects(
      runWalReceiver({
        repoId: "context-repo",
        directory: root,
        quotaBytes: 100,
        maxBufferedBytes: 64,
        signal: signal.signal,
        peer: {
          send: async () => {},
          receive: async () => {
            const next = frames.shift();
            if (next) return next;
            if (mode === "cancelled") signal.abort(stopped);
            throw mode === "cancelled"
              ? stopped
              : Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
          },
        },
        target: {
          position: () => position,
          apply: () => {
            applied = true;
          },
          install: async () => assert.fail(),
          installObject: async () => assert.fail(),
          project: async () => assert.fail(),
        },
      }),
      (error) => {
        if (mode === "cancelled") return error === stopped;
        assert.ok(error instanceof Error);
        assert.match(error.message, /"repoId":"context-repo"/u);
        assert.match(error.message, /"size":(?:1000|4)/u);
        assert.match(error.message, /"position":\{"history":"history","sequence":1/u);
        assert.equal(
          (error as { code?: string }).code,
          mode === "quota" ? "replica_quota_exceeded" : mode === "truncated" ? "ECONNRESET" : "replica_protocol_error",
        );
        return true;
      },
    );
    assert.equal(applied, false);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("uncoded apply and projection errors retain a deterministic failure code on both peers", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-commit-apply-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const stage of ["apply", "project"]) {
    const bytes = Buffer.from(JSON.stringify(commit));
    const frames: ReplicationFrame[] = [
      { type: "replica.accept", centerBuildCommit: null, taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION },
      { type: "replica.commit", size: bytes.length },
      { type: "replica.data", offset: 0, data: bytes.toString("base64") },
      { type: "replica.commit.end" },
    ];
    const original = new Error(`${stage} cannot apply this cut`);
    let reported: ReplicationFrame | undefined;
    await assert.rejects(
      runWalReceiver({
        repoId: "context-repo",
        directory: root,
        quotaBytes: 1024,
        maxBufferedBytes: 64,
        signal: new AbortController().signal,
        peer: {
          send: async (frame) => {
            if (frame.type === "replica.failure") reported = frame;
          },
          receive: async () => {
            const frame = frames.shift();
            if (frame) return frame;
            throw new Error("sender closed after failure");
          },
        },
        target: {
          position: () => position,
          apply: () => {
            if (stage === "apply") throw original;
          },
          project: async () => {
            if (stage === "project") throw original;
          },
          install: async () => assert.fail(),
          installObject: async () => assert.fail(),
        },
      }),
      (error) => {
        assert.equal(error, original);
        assert.equal((error as Error & { code?: string }).code, "replica_apply_failed");
        return true;
      },
    );
    assert.equal(reported?.type, "replica.failure");
    if (reported?.type === "replica.failure") {
      assert.equal(reported.code, "replica_apply_failed");
      assert.match(reported.message, /"repoId":"context-repo"/u);
    }
    assert.deepEqual(readdirSync(root), []);
  }
});
