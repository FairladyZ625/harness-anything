// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalJson,
  hashCanonicalJsonTextFieldChunks,
  hashCanonicalJsonTextFieldChunksAsync,
} from "../../src/projection/rebuildable-task-projection-sql.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("streamed JSON text-field hashing preserves the previous canonical bytes", async () => {
  const previousDigest = "f".repeat(64),
    value = 'quotes" slash/ nul\0 newline\n snow 雪 emoji 😀',
    row = { path: "tasks/one.md", value_json: value, workspace_revision: 3 },
    expected = sha256Text(`${previousDigest}\n${canonicalJson(row)}`),
    bytes = Buffer.from(value),
    chunks = [bytes.subarray(0, 24), bytes.subarray(24, 29), bytes.subarray(29)];
  assert.equal(
    hashCanonicalJsonTextFieldChunks(
      previousDigest,
      { path: row.path, value_json: "", workspace_revision: row.workspace_revision },
      "value_json",
      chunks,
    ),
    expected,
  );
  async function* asyncChunks(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  assert.equal(
    await hashCanonicalJsonTextFieldChunksAsync(
      previousDigest,
      { path: row.path, value_json: "", workspace_revision: row.workspace_revision },
      "value_json",
      asyncChunks(),
    ),
    expected,
  );
});

test("SQLite state digest reads a document larger than the probe's V8 heap in bounded chunks", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "state-digest-stream", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      initialized = projection.catchUp(),
      db = new DatabaseSync(projection.path);
    assert.equal(initialized.watermark, 0);
    db.prepare(
      `INSERT INTO document(path, workspace_revision, value_json)
       VALUES (?, 0, '{"body":"' || replace(hex(zeroblob(?)), '00', 'xxxx') || '"}')`,
    ).run("tasks/large/artifacts/evidence/heap-probe.bin", 40 * 1024 * 1024);
    db.close();
    projection.close();

    const moduleUrl = new URL("../../src/projection/rebuildable-task-projection-sql.ts", import.meta.url).href,
      source = `
        import { DatabaseSync } from "node:sqlite";
        import { readStateDigest } from ${JSON.stringify(moduleUrl)};
        const db = new DatabaseSync(process.argv[1], { readOnly: true });
        try {
          const digest = readStateDigest(db, 0);
          if (digest === null) throw new Error("source-complete projection did not return a digest");
          console.log(digest);
        } finally { db.close(); }
      `,
      result = spawnSync(
        process.execPath,
        ["--max-old-space-size=128", "--input-type=module", "--eval", source, projection.path],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    assert.equal(
      result.status,
      0,
      `state digest child failed (status=${result.status}, signal=${result.signal}): ${result.stderr.slice(0, 800)}`,
    );
    assert.match(result.stdout.trim(), /^sha256:[a-f0-9]{64}$/u);
  });
});
