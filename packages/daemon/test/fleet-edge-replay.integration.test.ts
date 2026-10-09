// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  READ_MODEL_META_PATH,
  READ_MODEL_SCHEMA_GENERATION,
  edgeReadAuthorizationShapeDigest,
  sha256Bytes,
} from "@harness-anything/kernel";
import {
  orderedEdgeManifestDigest,
  readEdgeManifestEntries,
  readEdgeManifestHeader,
  serializeEdgeManifest,
} from "../src/fleet/edge-manifest.ts";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { fleetManifestDigest, type FleetCut, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";

import { fleetMirrorCutFile, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { recordHeadConfirmation } from "../src/fleet/replica-read-model.ts";

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
    // copying the tree into cuts/<revision>-g<generation>/files/; only delta cuts
    // materialize changed files beside their manifest.
    assert.equal(existsSync(path.join(root, "repos/repo/views/many/cuts/1-g0/files/tasks/t/many-05.md")), false);
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
    assert.equal(readFileSync(path.join(root, "repos/repo/views/view/cuts/2-g0/files", pathA), "utf8"), "one-a-two");
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
  return {
    revision,
    headDigest: `sha256:${sha256Bytes(Buffer.from(`head-${revision}`))}`,
    schemaGeneration: 0,
  };
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

test("an immutable snapshot identity rejects changed bytes at the same revision and generation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-snapshot-identity-"));
  try {
    const view = openFleetEdgeView(root, replicaQuota),
      cut = wireCut(1);
    const original = Buffer.from("original"),
      changed = Buffer.from("changed");
    for (const frame of snapshotFrames("first", "view", cut, [wireEntry("context/note.md", original)], [original]))
      view.receive(frame);
    const before = view.current("repo", "view");
    for (const frame of snapshotFrames("repeat", "view", cut, [wireEntry("context/note.md", original)], [original]))
      view.receive(frame);
    assert.deepEqual(view.current("repo", "view"), before);
    assert.throws(() => {
      for (const frame of snapshotFrames("conflict", "view", cut, [wireEntry("context/note.md", changed)], [changed]))
        view.receive(frame);
    }, /immutable snapshot identity conflict/u);
    assert.deepEqual(view.current("repo", "view"), before);
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "repos/repo/views/view/cuts/1-g0/manifest.json"), "utf8")).manifestDigest,
      before!.manifestDigest,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two retained revision 415 cuts without wire generation converge from stale to fresh", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-retained-cut-"));
  try {
    const cut = { ...wireCut(415), schemaGeneration: READ_MODEL_SCHEMA_GENERATION },
      meta = Buffer.from(
        JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, sourceRevision: 415, rootThreshold: 0 }),
      ),
      entries = [wireEntry(READ_MODEL_META_PATH, meta)],
      owner = "person-one",
      authorizationShapeDigest = edgeReadAuthorizationShapeDigest({ repoId: "repo", owner }),
      read = (nodeId: string) =>
        withEdgeReadModel({ viewRoot: root, repoId: "repo", nodeId, principalId: owner }, (projection, frame) => ({
          list: projection.list({}),
          freshness: frame.freshness,
        })),
      deliver = (nodeId: string, transferId: string) => {
        const view = openFleetEdgeView(root, replicaQuota);
        let response: FleetFrameV1 | null = null;
        for (const frame of snapshotFrames(transferId, nodeId, cut, entries, [meta]))
          response = view.receive(
            frame.schema === "fleet.snapshot.begin/v1"
              ? { ...frame, authorizationOwner: owner, authorizationShapeDigest }
              : frame,
          );
        return response;
      };
    for (const nodeId of ["edge-one", "edge-two"]) {
      deliver(nodeId, `seed-${nodeId}`);
      const viewDir = path.join(root, "repos/repo/views", nodeId);
      // Match the deployed pre-B4 format: generation already exists at the
      // manifest top level and in the directory, but not inside its wire cut.
      for (const file of ["current.json", `cuts/415-g${READ_MODEL_SCHEMA_GENERATION}/manifest.json`]) {
        const target = path.join(viewDir, file),
          persisted = JSON.parse(readFileSync(target, "utf8"));
        delete persisted.cut.schemaGeneration;
        writeFileSync(target, JSON.stringify(persisted));
      }
      recordHeadConfirmation(viewDir, cut, Date.now() - 60 * 60 * 1000);
      assert.equal(read(nodeId).freshness.state, "stale");
    }
    for (const nodeId of ["edge-one", "edge-two"]) {
      const manifestPath = path.join(
          root,
          "repos/repo/views",
          nodeId,
          `cuts/415-g${READ_MODEL_SCHEMA_GENERATION}/manifest.json`,
        ),
        before = readFileSync(manifestPath);
      const retained = JSON.parse(before.toString("utf8"));
      for (const [name, divergent] of [
        ["generation", { ...retained, schemaGeneration: READ_MODEL_SCHEMA_GENERATION - 1 }],
        ["revision", { ...retained, cut: { ...retained.cut, revision: 414 } }],
        ["head", { ...retained, cut: { ...retained.cut, headDigest: wireCut(414).headDigest } }],
      ] as const) {
        writeFileSync(manifestPath, JSON.stringify(divergent));
        assert.throws(() => deliver(nodeId, `${name}-${nodeId}`), /immutable snapshot identity conflict/u);
        assert.equal(read(nodeId).freshness.state, "stale");
      }
      writeFileSync(manifestPath, before);
      assert.equal(deliver(nodeId, `upgrade-${nodeId}`)?.schema, "fleet.ack/v1");
      const local = read(nodeId);
      assert.equal(local.list.status, "ready");
      assert.equal(local.list.sourceRevision, 415);
      assert.equal(local.freshness.state, "fresh");
      assert.deepEqual(openFleetEdgeView(root, replicaQuota).current("repo", nodeId)?.cut, cut);
      assert.deepEqual(readFileSync(manifestPath), before, "the retained snapshot stays immutable");
      assert.equal(deliver(nodeId, `replay-${nodeId}`)?.schema, "fleet.ack/v1");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("received complete blobs are verified before finish and pinned across another view's collection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-ingest-"));
  try {
    const body = Buffer.from("waiting for finish"),
      entry = wireEntry("context/await.md", body),
      frames = snapshotFrames("receiving", "receiving", wireCut(1), [entry], [body]),
      view = openFleetEdgeView(root, replicaQuota);
    for (const frame of frames.slice(0, -1)) view.receive(frame);
    const cas = path.join(root, "repos/repo/cas/sha256", entry.blob.sha256.slice(0, 2), entry.blob.sha256);
    assert.equal(readFileSync(cas, "utf8"), body.toString());
    assert.equal(view.current("repo", "receiving"), null);
    const other = Buffer.from("other");
    for (const frame of snapshotFrames("other", "other", wireCut(1), [wireEntry("context/other.md", other)], [other]))
      view.receive(frame);
    assert.equal(readFileSync(cas, "utf8"), body.toString(), "GC must retain in-flight verified blobs");
    assert.equal(view.receive(frames.at(-1)!)?.schema, "fleet.ack/v1");
    const indexed = locateFleetMirrorView(root, "repo", "receiving")!,
      manifest = path.join(indexed.viewDir, "cuts/1-g0/manifest.json");
    // One already loaded view serves every document; per-document reads must
    // not reopen the entire manifest (including worktree reclamation reads).
    renameSync(manifest, `${manifest}.held`);
    assert.deepEqual(fleetMirrorCutFile(indexed, entry.path), body);
    writeFileSync(cas, Buffer.from("corrupt"));
    assert.throws(() => fleetMirrorCutFile(indexed, entry.path), /corrupt/u);
    writeFileSync(cas, body);
    renameSync(`${manifest}.held`, manifest);
    const corrupt = snapshotFrames(
      "bad",
      "bad",
      wireCut(2),
      [wireEntry("context/bad.md", Buffer.from("good"))],
      [Buffer.from("evil")],
    );
    view.receive(corrupt[0]!);
    view.receive(corrupt[1]!);
    assert.throws(() => view.receive(corrupt[2]!), /transfer blob mismatch/u);
    assert.equal(view.current("repo", "bad"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest batches preserve JSON, Unicode boundaries, digest and reject truncated input", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-manifest-batch-"));
  try {
    const file = path.join(root, "manifest.json"),
      entries = Array.from({ length: 1025 }, (_, index) =>
        wireEntry(`context/${String(index).padStart(4, "0")}-中文\\".md`, Buffer.from(String(index))),
      ),
      header = { cut: wireCut(1), schemaGeneration: 0, manifestDigest: fleetManifestDigest(entries) };
    writeFileSync(file, [...serializeEdgeManifest(header, entries)].join(""));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...header, entries });
    assert.deepEqual([...readEdgeManifestEntries(file)], entries);
    assert.deepEqual(readEdgeManifestHeader(file), header);
    assert.equal(orderedEdgeManifestDigest(readEdgeManifestEntries(file)), fleetManifestDigest(entries));
    // Arbitrary field order and whitespace use the same parser, not a format fallback.
    writeFileSync(file, JSON.stringify({ entries, ...header }, null, 2));
    assert.deepEqual([...readEdgeManifestEntries(file)], entries);
    assert.deepEqual(readEdgeManifestHeader(file), header);
    for (const invalid of [
      "{}",
      '{"entries":[],"entries":[]}',
      '{\u00a0"entries":[]}',
      '{"entries":[',
      '{"entries":[],}',
      '{"entries":[{},]}',
      '{"entries":[]}x',
      '{"entries":[]',
    ]) {
      writeFileSync(file, invalid);
      assert.throws(() => [...readEdgeManifestEntries(file)]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
