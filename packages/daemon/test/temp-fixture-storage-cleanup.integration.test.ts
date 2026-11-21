// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventReader,
  makeTaskProjection,
  openPersistentWriterEpoch,
  withWriterEpochFenceDescriptor,
} from "@harness-anything/storage";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("temporary repository removal closes its SQLite and writer-epoch owners", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-storage-cleanup-"));
  t.after(() => removeTempRepository(rootDir));
  const sibling = mkdtempSync(`${rootDir}-sibling-`);
  t.after(() => removeTempRepository(sibling));
  activateEmptyCanonicalGeneration({ repoId: "storage-cleanup", rootInput: rootDir });
  activateEmptyCanonicalGeneration({ repoId: "storage-sibling", rootInput: sibling });
  const eventStore = makeTaskEventReader({ repoId: "storage-cleanup", rootDir });
  const projection = makeTaskProjection({ rootDir, eventStore });
  const siblingReader = makeTaskEventReader({ repoId: "storage-sibling", rootDir: sibling });
  projection.readCut();
  const stateRoot = path.join(rootDir, "user/fleet"),
    epochAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "fixture-cleanup" }),
    lease = epochAuthority.acquire("storage-cleanup");
  epochAuthority.close();
  withWriterEpochFenceDescriptor(
    {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId: "storage-cleanup",
      holderId: lease.holderId,
      epoch: lease.epoch,
    },
    () => undefined,
  );

  removeTempRepository(rootDir);

  assert.equal(existsSync(rootDir), false);
  assert.throws(() => eventStore.readHead(), { code: "ERR_INVALID_STATE" });
  assert.equal(siblingReader.readHead(), null);
});
