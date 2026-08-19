// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openPersistentWriterEpoch } from "../src/fleet/writer-epoch.ts";

test("persistent writer epochs allocate monotonically and fence a stale holder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-"));
  try {
    const first = openPersistentWriterEpoch({ stateRoot: root, holderId: "center-a", now: () => "2026-08-19T00:00:00.000Z" });
    const leaseA = first.acquire("repo");
    assert.equal(leaseA.epoch, 1);
    const second = openPersistentWriterEpoch({ stateRoot: root, holderId: "center-b", now: () => "2026-08-19T00:00:01.000Z" });
    const leaseB = second.acquire("repo");
    assert.equal(leaseB.epoch, 2);
    assert.throws(() => first.assert("repo", leaseA.epoch), (error: unknown) => error instanceof Error && "code" in error && error.code === "writer_epoch_stale");
    second.close();
    first.close();
    const persisted = JSON.parse(readFileSync(path.join(root, "writer-epochs.json"), "utf8")) as { repos: Record<string, { epoch: number }> };
    assert.equal(persisted.repos.repo.epoch, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
