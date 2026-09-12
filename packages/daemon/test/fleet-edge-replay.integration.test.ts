// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../../kernel/src/index.ts";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { fleetManifestDigest, type FleetCut, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";

const replicaQuota = 64 * 1024 * 1024;

test("edge staging replays snapshot/delta pages and chunks and switches only complete cuts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-replay-"));
  try {
    const pathA = "tasks/t/a.md",
      pathB = "tasks/t/b.md",
      oneA = Buffer.from("one-a"),
      oneB = Buffer.from("one-b"),
      entriesOne = [wireEntry(pathA, oneA), wireEntry(pathB, oneB)],
      cutOne = wireCut(1),
      snapshot = snapshotFrames("snap", "view", cutOne, entriesOne, [oneA, oneB]);
    let view = openFleetEdgeView(root, replicaQuota, (point) => {
      if (point === "after_page") throw new Error("crash-after-page");
    });
    view.receive(snapshot[0]!);
    assert.throws(() => view.receive(snapshot[1]!), /crash-after-page/u);
    assert.equal(view.current("repo", "view"), null);
    view = openFleetEdgeView(root, replicaQuota);
    for (const frame of snapshot) view.receive(frame);
    assert.equal(view.current("repo", "view")?.cut.revision, 1);
    const manyBodies = Array.from({ length: 12 }, (_, index) =>
        index === 5 ? Buffer.alloc(0) : Buffer.from(`many-${index}`),
      ),
      manyEntries = manyBodies.map((body, index) =>
        wireEntry(`tasks/t/many-${String(index).padStart(2, "0")}.md`, body),
      ),
      manyDigest = fleetManifestDigest(manyEntries),
      manyCut = wireCut(1);
    view.receive({
      schema: "fleet.snapshot.begin/v1",
      messageId: "many-begin",
      transferId: "many",
      repoId: "repo",
      viewId: "many",
      cut: manyCut,
      manifest: {
        digest: manyDigest,
        entryCount: manyEntries.length,
        totalBytes: manyBodies.reduce((sum, body) => sum + body.byteLength, 0),
      },
    });
    for (const index of [10, 0, 11, 1, 9, 2, 8, 3, 7, 4, 6, 5])
      view.receive({
        schema: "fleet.snapshot.page/v1",
        messageId: `many-page-${index}`,
        transferId: "many",
        pageIndex: index,
        entries: [manyEntries[index]!],
      });
    for (const [index, body] of manyBodies.entries())
      if (body.length > 0)
        view.receive({
          schema: "fleet.snapshot.chunk/v1",
          messageId: `many-chunk-${index}`,
          transferId: "many",
          blobSha256: manyEntries[index]!.blob.sha256,
          offset: 0,
          dataBase64: body.toString("base64"),
        });
    assert.equal(
      view.receive({
        schema: "fleet.snapshot.finish/v1",
        messageId: "many-finish",
        transferId: "many",
        manifestDigest: manyDigest,
      })?.schema,
      "fleet.ack/v1",
    );
    assert.equal(view.current("repo", "many")?.cut.revision, 1);
    // Snapshot cuts address their blobs through the verified CAS instead of
    // copying the tree into cuts/<revision>/files/; only delta cuts
    // materialize changed files beside their manifest.
    assert.equal(existsSync(path.join(root, "repos/repo/views/many/cuts/1/files/tasks/t/many-05.md")), false);
    assert.equal(
      readFileSync(
        path.join(root, "repos/repo/cas/sha256", manyEntries[5]!.blob.sha256.slice(0, 2), manyEntries[5]!.blob.sha256),
        "utf8",
      ),
      "",
    );
    const otherBody = Buffer.from("other-view"),
      otherEntry = wireEntry("tasks/t/other.md", otherBody),
      otherSnapshot = snapshotFrames("snap-other", "other", cutOne, [otherEntry], [otherBody]);
    for (const frame of otherSnapshot) view.receive(frame);
    const otherCas = path.join(
      root,
      "repos/repo/cas/sha256",
      otherEntry.blob.sha256.slice(0, 2),
      otherEntry.blob.sha256,
    );
    assert.equal(existsSync(otherCas), true);
    const twoA = Buffer.from("one-a-two"),
      entriesTwo = [wireEntry(pathA, twoA)],
      cutTwo = wireCut(2),
      deltaTwo = deltaFrames(
        "delta2",
        "view",
        cutOne,
        cutTwo,
        fleetManifestDigest(entriesTwo),
        [
          { op: "put", path: pathA, blob: entriesTwo[0]!.blob },
          { op: "delete", path: pathB },
        ],
        [twoA],
      );
    view = openFleetEdgeView(root, replicaQuota, (point) => {
      if (point === "after_chunk") throw new Error("crash-after-chunk");
    });
    view.receive(deltaTwo[0]!);
    view.receive(deltaTwo[1]!);
    assert.throws(() => view.receive(deltaTwo[2]!), /crash-after-chunk/u);
    assert.equal(view.current("repo", "view")?.cut.revision, 1);
    view = openFleetEdgeView(root, replicaQuota);
    for (const frame of deltaTwo) view.receive(frame);
    assert.equal(view.current("repo", "view")?.cut.revision, 2);
    assert.equal(readFileSync(path.join(root, "repos/repo/views/view/cuts/2/files", pathA), "utf8"), "one-a-two");
    assert.equal(existsSync(otherCas), true);
    const threeA = Buffer.from("one-a-two-three"),
      entriesThree = [wireEntry(pathA, threeA)],
      cutThree = wireCut(3),
      deltaThree = deltaFrames(
        "delta3",
        "view",
        cutTwo,
        cutThree,
        fleetManifestDigest(entriesThree),
        [{ op: "put", path: pathA, blob: entriesThree[0]!.blob }],
        [threeA],
      );
    view = openFleetEdgeView(root, replicaQuota, (point) => {
      if (point === "before_current_rename") throw new Error("crash-before-current");
    });
    for (const frame of deltaThree.slice(0, -1)) view.receive(frame);
    assert.throws(() => view.receive(deltaThree.at(-1)!), /crash-before-current/u);
    assert.equal(view.current("repo", "view")?.cut.revision, 2);
    view = openFleetEdgeView(root, replicaQuota);
    for (const frame of deltaThree) view.receive(frame);
    assert.equal(view.current("repo", "view")?.cut.revision, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge chunk replay compares only the named window against the staged blob", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-edge-window-"));
  try {
    const body = Buffer.concat([Buffer.from("a".repeat(100 * 1024)), Buffer.from("b".repeat(100 * 1024))]),
      entry = wireEntry("tasks/t/big.md", body),
      digest = fleetManifestDigest([entry]),
      cut = wireCut(1),
      begin = {
        schema: "fleet.snapshot.begin/v1" as const,
        messageId: "big-begin",
        transferId: "big",
        repoId: "repo",
        viewId: "view",
        cut,
        manifest: { digest, entryCount: 1, totalBytes: body.byteLength },
      },
      page = {
        schema: "fleet.snapshot.page/v1" as const,
        messageId: "big-page",
        transferId: "big",
        pageIndex: 0,
        entries: [entry],
      },
      first = {
        schema: "fleet.snapshot.chunk/v1" as const,
        messageId: "big-chunk-0",
        transferId: "big",
        blobSha256: entry.blob.sha256,
        offset: 0,
        dataBase64: body.subarray(0, 100 * 1024).toString("base64"),
      },
      second = {
        schema: "fleet.snapshot.chunk/v1" as const,
        messageId: "big-chunk-1",
        transferId: "big",
        blobSha256: entry.blob.sha256,
        offset: 100 * 1024,
        dataBase64: body.subarray(100 * 1024).toString("base64"),
      };
    let view = openFleetEdgeView(root, replicaQuota, (point) => {
      if (point === "after_chunk") throw new Error("crash-after-chunk");
    });
    view.receive(begin);
    view.receive(page);
    assert.throws(() => view.receive(first), /crash-after-chunk/u);
    view = openFleetEdgeView(root, replicaQuota);
    view.receive(begin);
    view.receive(page);
    view.receive(first);
    view.receive(second);
    // Replaying the identical mid-blob window at a non-zero offset is
    // accepted; a chunk whose window diverges is refused without re-reading
    // the whole staged blob.
    view.receive(second);
    assert.throws(
      () => view.receive({ ...second, dataBase64: Buffer.from("c".repeat(100 * 1024)).toString("base64") }),
      /chunk replay mismatch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function wireEntry(itemPath: string, bytes: Buffer): FleetEntry {
  return { path: itemPath, blob: { sha256: sha256Bytes(bytes), size: bytes.byteLength, mediaType: "text/markdown" } };
}
function wireCut(revision: number): FleetCut {
  return { revision, headDigest: `sha256:${sha256Bytes(Buffer.from(`head-${revision}`))}` };
}
function snapshotFrames(
  transferId: string,
  viewId: string,
  cut: FleetCut,
  entries: readonly FleetEntry[],
  bodies: readonly Buffer[],
): FleetFrameV1[] {
  const digest = fleetManifestDigest(entries);
  return [
    {
      schema: "fleet.snapshot.begin/v1",
      messageId: `${transferId}_begin`,
      transferId,
      repoId: "repo",
      viewId,
      cut,
      manifest: {
        digest,
        entryCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.blob.size, 0),
      },
    },
    { schema: "fleet.snapshot.page/v1", messageId: `${transferId}_page`, transferId, pageIndex: 0, entries },
    ...entries.map((entry, index) => ({
      schema: "fleet.snapshot.chunk/v1" as const,
      messageId: `${transferId}_chunk${index}`,
      transferId,
      blobSha256: entry.blob.sha256,
      offset: 0,
      dataBase64: bodies[index]!.toString("base64"),
    })),
    { schema: "fleet.snapshot.finish/v1", messageId: `${transferId}_finish`, transferId, manifestDigest: digest },
  ];
}
function deltaFrames(
  transferId: string,
  viewId: string,
  fromCut: FleetCut,
  toCut: FleetCut,
  digest: string,
  changes: Extract<FleetFrameV1, { schema: "fleet.delta.page/v1" }>["changes"],
  bodies: readonly Buffer[],
): FleetFrameV1[] {
  const puts = changes.filter((change) => change.op === "put");
  return [
    {
      schema: "fleet.delta.begin/v1",
      messageId: `${transferId}_begin`,
      transferId,
      repoId: "repo",
      viewId,
      fromCut,
      toCut,
      changeCount: changes.length,
      resultManifestDigest: digest,
    },
    { schema: "fleet.delta.page/v1", messageId: `${transferId}_page`, transferId, pageIndex: 0, changes },
    ...puts.map((change, index) => ({
      schema: "fleet.delta.chunk/v1" as const,
      messageId: `${transferId}_chunk${index}`,
      transferId,
      blobSha256: change.blob.sha256,
      offset: 0,
      dataBase64: bodies[index]!.toString("base64"),
    })),
    { schema: "fleet.delta.finish/v1", messageId: `${transferId}_finish`, transferId, resultManifestDigest: digest },
  ];
}
