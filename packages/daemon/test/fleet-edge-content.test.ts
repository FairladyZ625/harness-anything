// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { openFleetDocContentSink, readFleetDocContentMetadata } from "../src/fleet-edge-content.ts";
import { runFleetDocShowRange } from "../src/fleet-edge-task.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("Fleet doc content sink resumes from its fsynced offset and seals exact bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-content-")),
    bytes = Buffer.from("prefix\0middle\xffsuffix"),
    metadata = {
      path: "tasks/demo/artifacts/blob.bin",
      sha256: sha256(bytes),
      size: bytes.byteLength,
      sourceRevision: 12,
      encoding: "base64" as const,
    },
    options = {
      rootDir: root,
      key: "doc-resume",
      metadata,
      nodeId: "edge-one",
      repoId: "repo-one",
      opId: "op-one",
    },
    first = openFleetDocContentSink(options);
  await first.sink.write(0, bytes.subarray(0, 7), new AbortController().signal);
  await first.sink.flush(new AbortController().signal);
  assert.equal((await first.sink.status(new AbortController().signal)).durableOffset, 7);

  const resumed = openFleetDocContentSink(options);
  assert.equal((await resumed.sink.status(new AbortController().signal)).durableOffset, 7);
  await resumed.sink.write(7, bytes.subarray(7), new AbortController().signal);
  await resumed.sink.flush(new AbortController().signal);
  await resumed.sink.seal(new AbortController().signal);
  assert.deepEqual(resumed.readSealed(), bytes);
  assert.deepEqual(readFleetDocContentMetadata(root, "doc-resume"), metadata);
  resumed.cleanup();
});

test("Fleet doc content sink rejects gaps and replay mismatches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-content-")),
    bytes = Buffer.from("0123456789"),
    options = {
      rootDir: root,
      key: "doc-replay",
      metadata: {
        path: "context/blob.txt",
        sha256: sha256(bytes),
        size: bytes.byteLength,
        sourceRevision: 4,
        encoding: "utf8" as const,
      },
      nodeId: "edge-one",
      repoId: "repo-one",
      opId: "op-two",
    },
    sink = openFleetDocContentSink(options),
    signal = new AbortController().signal;
  await assert.rejects(() => sink.sink.write(2, bytes.subarray(2), signal), { code: "upload_gap" });
  await sink.sink.write(0, bytes.subarray(0, 4), signal);
  await assert.rejects(() => sink.sink.write(0, Buffer.from("xxxx"), signal), { code: "upload_replay_mismatch" });
  await sink.sink.abort(signal);
});

test("Fleet edge range aggregation preserves binary reviewer bytes and resumes after disconnect", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-range-")),
    bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]), Buffer.from("binary\0payload")]),
    chunkSize = 7,
    responses = (offset: number) => ({
      outcome: "applied",
      receipt: {
        outcome: "applied",
        evidence: bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)).toString("base64"),
        evidenceEncoding: "base64",
        evidenceOffset: offset,
        evidenceSize: bytes.byteLength,
        evidenceDone: offset + chunkSize >= bytes.byteLength,
        evidenceBlobSha256: sha256(bytes),
        evidenceSourceRevision: 12,
        evidenceContentEncoding: "base64",
      },
    });
  let first = true;
  const request = async (input: { readonly action: Record<string, unknown> }) => {
    const offset = Number(input.action.offset ?? 0);
    if (first && offset > 0) {
      first = false;
      throw new Error("Fleet connection closed");
    }
    return responses(offset) as never;
  };
  await assert.rejects(
    () =>
      runFleetDocShowRange({
        peer: {} as never,
        action: { kind: "doc-show", path: "tasks/demo/artifacts/blob.bin" },
        opId: "binary-resume",
        workspaceRoot: root,
        nodeId: "edge-one",
        repoId: "repo-one",
        request,
      }),
    /connection closed/u,
  );
  const resumed = await runFleetDocShowRange({
    peer: {} as never,
    action: { kind: "doc-show", path: "tasks/demo/artifacts/blob.bin" },
    opId: "binary-resume",
    workspaceRoot: root,
    nodeId: "edge-one",
    repoId: "repo-one",
    request: async (input) => responses(Number(input.action.offset ?? 0)) as never,
  });
  assert.equal(resumed.outcome, "applied");
  assert.deepEqual(Buffer.from(String(resumed.receipt?.evidence), "base64"), bytes);
});
