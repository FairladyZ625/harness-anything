import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { sha256Bytes } from "@harness-anything/kernel";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { fleetManifestDigest, type FleetEntry, type FleetDeltaChange } from "../src/fleet/contract.ts";
import { edgeManifestBlob, edgeManifestEntries, edgeManifestPaths } from "../src/fleet/replica-read-model.ts";

const { root } = workerData as { root: string };
const count = 400_000;
const view = openFleetEdgeView(root, 1024 ** 3);
const viewDir = path.join(root, "repos/repo/views/edge");
const body = Buffer.from("shared content isolates manifest work from unique-blob transfer cost\n");
const blob = { sha256: sha256Bytes(body), size: body.length, mediaType: "text/markdown" };
const entries: FleetEntry[] = Array.from({ length: count }, (_, i) => ({
  path: `tasks/task-${String(i).padStart(8, "0")}/task_plan.md`,
  blob,
}));
const cut = (revision: number) => ({ revision, schemaGeneration: 0, headDigest: String(revision).repeat(64) });
const readChars = () =>
  process.platform === "linux" ? Number(/^rchar: (\d+)$/mu.exec(readFileSync("/proc/self/io", "utf8"))![1]) : null;
function phase(name: string, run: () => void): void {
  parentPort!.postMessage({ event: "start", phase: name, count });
  const started = performance.now(),
    before = readChars();
  run();
  const after = readChars();
  parentPort!.postMessage({
    event: "end",
    phase: name,
    count,
    ms: performance.now() - started,
    readChars: before === null || after === null ? null : after - before,
  });
}
function snapshot(revision: number): void {
  const transferId = `snapshot-${revision}`,
    digest = fleetManifestDigest(entries);
  view.receive({
    schema: "fleet.snapshot.begin/v1",
    messageId: "begin",
    transferId,
    repoId: "repo",
    viewId: "edge",
    cut: cut(revision),
    manifest: { digest, entryCount: entries.length, totalBytes: count * body.length },
  });
  for (let offset = 0; offset < entries.length; offset += 128)
    view.receive({
      schema: "fleet.snapshot.page/v1",
      messageId: `page-${offset}`,
      transferId,
      pageIndex: offset / 128,
      entries: entries.slice(offset, offset + 128),
    });
  view.receive({
    schema: "fleet.snapshot.chunk/v1",
    messageId: "chunk",
    transferId,
    blobSha256: blob.sha256,
    offset: 0,
    dataBase64: body.toString("base64"),
  });
  const response = view.receive({
    schema: "fleet.snapshot.finish/v1",
    messageId: "finish",
    transferId,
    manifestDigest: digest,
  });
  assert.equal(response?.schema, "fleet.ack/v1");
  assert.deepEqual(view.current("repo", "edge")?.cut, cut(revision));
  assert.equal(edgeManifestEntries(viewDir, cut(revision))!.size, count);
  view.collect("repo", "edge", transferId);
}

phase("empty-edge-snapshot-ACK", () => snapshot(1));
phase("acknowledged-edge-replacement-snapshot-ACK", () => snapshot(2));
const replacement = Buffer.from("updated\n");
const nextBlob = { ...blob, sha256: sha256Bytes(replacement), size: replacement.length };
const changes: FleetDeltaChange[] = [];
const result = entries.slice();
for (let i = count - 1024; i < count; i++) {
  if (i % 2) changes.push({ op: "delete", path: entries[i]!.path });
  else {
    result[i] = { ...entries[i]!, blob: nextBlob };
    changes.push({ op: "put", ...result[i]! });
  }
}
const remaining = result.filter((_, i) => i < count - 1024 || i % 2 === 0);
phase("sparse-delta-ACK", () => {
  const transferId = "delta",
    digest = fleetManifestDigest(remaining);
  view.receive({
    schema: "fleet.delta.begin/v1",
    messageId: "begin",
    transferId,
    repoId: "repo",
    viewId: "edge",
    fromCut: cut(2),
    toCut: cut(3),
    changeCount: changes.length,
    resultManifestDigest: digest,
  });
  for (let offset = 0; offset < changes.length; offset += 128)
    view.receive({
      schema: "fleet.delta.page/v1",
      messageId: `page-${offset}`,
      transferId,
      pageIndex: offset / 128,
      changes: changes.slice(offset, offset + 128),
    });
  view.receive({
    schema: "fleet.delta.chunk/v1",
    messageId: "chunk",
    transferId,
    blobSha256: nextBlob.sha256,
    offset: 0,
    dataBase64: replacement.toString("base64"),
  });
  assert.equal(
    view.receive({ schema: "fleet.delta.finish/v1", messageId: "finish", transferId, resultManifestDigest: digest })
      ?.schema,
    "fleet.ack/v1",
  );
  view.collect("repo", "edge", transferId);
});
phase("point-prefix-blob-and-retained-cut-reads", () => {
  const before = edgeManifestEntries(viewDir, cut(2))!,
    after = edgeManifestEntries(viewDir, cut(3))!;
  for (let i = count - 1024; i < count; i++) {
    assert.deepEqual(before.get(entries[i]!.path), blob);
    assert.deepEqual(after.get(entries[i]!.path), i % 2 ? undefined : nextBlob);
  }
  for (let i = count - 16; i < count; i++) {
    const entry = entries[i]!;
    assert.deepEqual(
      edgeManifestPaths(viewDir, cut(3), entry.path.slice(0, -"task_plan.md".length)),
      i % 2 ? [] : [entry.path],
    );
  }
  assert.equal(edgeManifestBlob(viewDir, cut(3), "f".repeat(64)), null);
  assert.deepEqual(edgeManifestBlob(viewDir, cut(3), nextBlob.sha256), nextBlob);
  assert.equal(edgeManifestEntries(viewDir, cut(1))!.size, count, "replacement preserves the retained first cut");
  assert.equal(after.size, count - 512);
});
parentPort!.postMessage({ phase: "complete", count });
