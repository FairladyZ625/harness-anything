// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { activateEmptyCanonicalGeneration, makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("temporary repository removal closes its SQLite owners and leaves sibling owners open", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-storage-cleanup-"));
  t.after(() => removeTempRepository(rootDir));
  const sibling = mkdtempSync(`${rootDir}-sibling-`);
  t.after(() => removeTempRepository(sibling));
  const repository = path.join(rootDir, "repo");
  mkdirSync(repository);
  activateEmptyCanonicalGeneration({ repoId: "storage-cleanup", rootInput: repository });
  activateEmptyCanonicalGeneration({ repoId: "storage-sibling", rootInput: sibling });
  const eventStore = makeTaskEventReader({ repoId: "storage-cleanup", rootDir: repository });
  const secondReader = makeTaskEventReader({ repoId: "storage-cleanup", rootDir: repository });
  const projection = makeTaskProjection({ rootDir: repository, eventStore });
  const siblingReader = makeTaskEventReader({ repoId: "storage-sibling", rootDir: sibling });
  projection.readCut();

  removeTempRepository(rootDir);

  assert.equal(existsSync(rootDir), false);
  assert.throws(() => eventStore.readHead(), { code: "ERR_INVALID_STATE" });
  assert.throws(() => secondReader.readHead(), { code: "ERR_INVALID_STATE" });
  assert.equal(siblingReader.readHead(), null);
});
