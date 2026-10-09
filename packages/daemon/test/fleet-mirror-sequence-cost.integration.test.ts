// harness-test-tier: integration
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { READ_MODEL_META_PATH, READ_MODEL_SCHEMA_GENERATION, sha256Bytes } from "@harness-anything/kernel";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { fleetManifestDigest, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { openEdgeReadModel } from "../src/fleet/replica-read-model.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

for (const size of [200, 2000]) {
  test(`measure one document update through the real mirror (${size})`, (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "ha-sequence-scope-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const viewRoot = path.join(root, "view"),
      workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "harness"), { recursive: true });
    const view = openFleetEdgeView(viewRoot, 64 * 1024 * 1024);
    const bodies = Array.from({ length: size }, (_, i) => Buffer.from(`first-${i}\n`));
    const body = bodies[0]!,
      next = Buffer.from("second\n");
    const blob = (bytes: Buffer) => ({ sha256: sha256Bytes(bytes), size: bytes.length, mediaType: "text/markdown" });
    const entries: FleetEntry[] = Array.from({ length: size }, (_, i) => ({
      path: `context/item-${String(i).padStart(4, "0")}.md`,
      blob: blob(bodies[i]!),
    }));
    const cut = (revision: number) => ({
      revision,
      headDigest: String(revision).repeat(64),
      schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
    });
    const meta = (revision: number) =>
      Buffer.from(
        JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, sourceRevision: revision, rootThreshold: 3 }),
      );
    entries.push({ path: READ_MODEL_META_PATH, blob: { ...blob(meta(1)), mediaType: "application/json" } });
    const casRoot = path.join(viewRoot, "repos/repo/cas/sha256");
    const model = () => openEdgeReadModel(locateFleetMirrorView(viewRoot, "repo", "edge")!, casRoot)!;
    const send = (frame: FleetFrameV1) => view.receive(frame);
    const beforeDigest = fleetManifestDigest(entries);
    send({
      schema: "fleet.snapshot.begin/v1",
      messageId: "begin",
      transferId: "snapshot",
      repoId: "repo",
      viewId: "edge",
      cut: cut(1),
      manifest: {
        digest: beforeDigest,
        entryCount: entries.length,
        totalBytes: bodies.reduce((sum, item) => sum + item.length, 0) + meta(1).length,
      },
    });
    for (let offset = 0; offset < entries.length; offset += 128)
      send({
        schema: "fleet.snapshot.page/v1",
        messageId: `page${offset}`,
        transferId: "snapshot",
        pageIndex: offset / 128,
        entries: entries.slice(offset, offset + 128),
      });
    for (const body of bodies)
      send({
        schema: "fleet.snapshot.chunk/v1",
        messageId: "chunk",
        transferId: "snapshot",
        blobSha256: blob(body).sha256,
        offset: 0,
        dataBase64: body.toString("base64"),
      });
    send({
      schema: "fleet.snapshot.chunk/v1",
      messageId: "meta",
      transferId: "snapshot",
      blobSha256: sha256Bytes(meta(1)),
      offset: 0,
      dataBase64: meta(1).toString("base64"),
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
    model().db.close();
    let readBytes = 0,
      statCalls = 0,
      sqliteRows = 0;
    const originalStat = fs.statSync,
      originalRead = fs.readFileSync,
      originalPrepare = DatabaseSync.prototype.prepare;
    const statMock = t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      statCalls++;
      return originalStat(...args);
    });
    const bytesMock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      const value = originalRead(...args);
      readBytes += Buffer.byteLength(value);
      return value;
    });
    const sqlMock = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql),
        all = statement.all.bind(statement);
      statement.all = (...args: Parameters<typeof all>) => {
        const rows = all(...args);
        sqliteRows += rows.length;
        return rows;
      };
      return statement;
    });
    syncBuiltinESMExports();
    entries[0] = { ...entries[0]!, blob: blob(next) };
    entries[entries.length - 1] = {
      path: READ_MODEL_META_PATH,
      blob: { ...blob(meta(2)), mediaType: "application/json" },
    };
    const afterDigest = fleetManifestDigest(entries);
    send({
      schema: "fleet.delta.begin/v1",
      messageId: "dbegin",
      transferId: "delta",
      repoId: "repo",
      viewId: "edge",
      fromCut: cut(1),
      toCut: cut(2),
      changeCount: 2,
      resultManifestDigest: afterDigest,
    });
    send({
      schema: "fleet.delta.page/v1",
      messageId: "dpage",
      transferId: "delta",
      pageIndex: 0,
      changes: [
        { op: "put", ...entries[0]! },
        { op: "put", ...entries.at(-1)! },
      ],
    });
    send({
      schema: "fleet.delta.chunk/v1",
      messageId: "dchunk",
      transferId: "delta",
      blobSha256: blob(next).sha256,
      offset: 0,
      dataBase64: next.toString("base64"),
    });
    send({
      schema: "fleet.delta.chunk/v1",
      messageId: "dmeta",
      transferId: "delta",
      blobSha256: sha256Bytes(meta(2)),
      offset: 0,
      dataBase64: meta(2).toString("base64"),
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
      const synced = model();
      assert.equal(synced.meta.sourceRevision, 2);
      assert.equal(
        synced.db
          .prepare("SELECT value_json FROM document WHERE path=?")
          .get(entries[0]!.path)!
          .value_json.includes("second"),
        true,
      );
      synced.db.close();
    } finally {
      readMock.mock.restore();
      statMock.mock.restore();
      bytesMock.mock.restore();
      sqlMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(settled.outcome, "applied");
    assert.equal(settled.toRevision, 2);
    assert.equal(fs.readFileSync(path.join(workspace, "harness", entries[0]!.path), "utf8"), next.toString());
    assert.equal(localDocumentReads, 1);
    assert.equal(localDocumentBytes, body.length);
    t.diagnostic(
      JSON.stringify({
        size,
        changedDocuments: 1,
        localDocumentReads,
        localDocumentBytes,
        readBytes,
        statCalls,
        sqliteRows,
      }),
    );
    assert.ok(readBytes < 64 * 1024, `delta plus model and mirror read ${readBytes} bytes`);
    assert.ok(statCalls < 150, `delta plus model and mirror stat ${statCalls} files`);
    assert.ok(sqliteRows < 100, `delta plus model and mirror read ${sqliteRows} SQLite rows`);
  });
}
