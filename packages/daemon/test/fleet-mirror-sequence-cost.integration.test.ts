// harness-test-tier: integration
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { fleetManifestDigest, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";

for (const size of [200, 2000]) {
  test(`measure one document update through the real mirror (${size})`, (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "ha-sequence-scope-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const viewRoot = path.join(root, "view"),
      workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "harness"), { recursive: true });
    const view = openFleetEdgeView(viewRoot, 64 * 1024 * 1024);
    const body = Buffer.from("first\n"),
      next = Buffer.from("second\n");
    const blob = (bytes: Buffer) => ({ sha256: sha256Bytes(bytes), size: bytes.length, mediaType: "text/markdown" });
    const entries: FleetEntry[] = Array.from({ length: size }, (_, i) => ({
      path: `context/item-${String(i).padStart(4, "0")}.md`,
      blob: blob(body),
    }));
    const cut = (revision: number) => ({ revision, headDigest: String(revision).repeat(64), schemaGeneration: 0 });
    const send = (frame: FleetFrameV1) => view.receive(frame);
    const beforeDigest = fleetManifestDigest(entries);
    send({
      schema: "fleet.snapshot.begin/v1",
      messageId: "begin",
      transferId: "snapshot",
      repoId: "repo",
      viewId: "edge",
      cut: cut(1),
      manifest: { digest: beforeDigest, entryCount: size, totalBytes: size * body.length },
    });
    for (let offset = 0; offset < size; offset += 128)
      send({
        schema: "fleet.snapshot.page/v1",
        messageId: `page${offset}`,
        transferId: "snapshot",
        pageIndex: offset / 128,
        entries: entries.slice(offset, offset + 128),
      });
    send({
      schema: "fleet.snapshot.chunk/v1",
      messageId: "chunk",
      transferId: "snapshot",
      blobSha256: blob(body).sha256,
      offset: 0,
      dataBase64: body.toString("base64"),
    });
    assert.equal(
      send({
        schema: "fleet.snapshot.finish/v1",
        messageId: "finish",
        transferId: "snapshot",
        manifestDigest: beforeDigest,
      })?.schema,
      "fleet.ack/v1",
    );
    assert.equal(applyFleetMirrorCut(viewRoot, "repo", workspace, "pull").outcome, "applied");
    entries[0] = { ...entries[0]!, blob: blob(next) };
    const afterDigest = fleetManifestDigest(entries);
    send({
      schema: "fleet.delta.begin/v1",
      messageId: "dbegin",
      transferId: "delta",
      repoId: "repo",
      viewId: "edge",
      fromCut: cut(1),
      toCut: cut(2),
      changeCount: 1,
      resultManifestDigest: afterDigest,
    });
    send({
      schema: "fleet.delta.page/v1",
      messageId: "dpage",
      transferId: "delta",
      pageIndex: 0,
      changes: [{ op: "put", ...entries[0]! }],
    });
    send({
      schema: "fleet.delta.chunk/v1",
      messageId: "dchunk",
      transferId: "delta",
      blobSha256: blob(next).sha256,
      offset: 0,
      dataBase64: next.toString("base64"),
    });
    assert.equal(
      send({
        schema: "fleet.delta.finish/v1",
        messageId: "dfinish",
        transferId: "delta",
        resultManifestDigest: afterDigest,
      })?.schema,
      "fleet.ack/v1",
    );
    let localDocumentReads = 0,
      localDocumentBytes = 0;
    const original = fs.readFileSync;
    const readMock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      const result = original(...args);
      if (String(args[0]).startsWith(path.join(workspace, "harness", "context") + path.sep)) {
        localDocumentReads++;
        localDocumentBytes += Buffer.byteLength(result);
      }
      return result;
    });
    syncBuiltinESMExports();
    let settled;
    try {
      settled = applyFleetMirrorCut(viewRoot, "repo", workspace, "pull");
    } finally {
      readMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(settled.outcome, "applied");
    assert.equal(settled.toRevision, 2);
    assert.equal(fs.readFileSync(path.join(workspace, "harness", entries[0]!.path), "utf8"), next.toString());
    assert.equal(localDocumentReads, 1);
    assert.equal(localDocumentBytes, body.length);
    t.diagnostic(JSON.stringify({ size, changedDocuments: 1, localDocumentReads, localDocumentBytes }));
  });
}
