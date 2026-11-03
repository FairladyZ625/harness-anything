// harness-test-tier: integration
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { objectPath } from "../../src/store/content-objects.ts";
import { assertContentBlobRangeContract } from "../content-blob-range.assertions.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

test("SQLite content blob storage fulfills the shared range-read contract", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-content-range-")),
    body = Buffer.from("range reads stay bounded across storage backends"),
    sha256 = sha256Bytes(body),
    databasePath = sqliteLedgerPath(rootDir, 3),
    objectRoot = path.join(path.dirname(databasePath), "objects", "sha256"),
    target = objectPath(objectRoot, sha256),
    store = (() => {
      initRepo(rootDir);
      const value = makeTaskEventStore({ repoId: "content-range-contract", rootDir });
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
      return value;
    })();
  try {
    await assertContentBlobRangeContract(
      t,
      {
        readContentBlobRange: store.readContentBlobRange,
        readContentBlobSize: store.readContentBlobSize,
      },
      sha256,
      body,
    );
  } finally {
    store.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
