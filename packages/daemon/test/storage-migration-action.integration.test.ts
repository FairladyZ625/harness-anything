// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { makeTaskEventStore } from "@harness-anything/storage";
import { openSqliteEventStore } from "../../storage/src/store/sqlite-event-store.ts";

test("storage migration is authorized at the current cut before opening locations and runs through the writer", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-migrate-action-")),
    sourceRoot = path.join(root, "source"),
    targetRoot = path.join(root, "target"),
    repoId = workspaceId("migration-action"),
    scope = { tenantId: "migration", projectId: "action", policyEpoch: 0, readers: [] },
    actor = { principal: { personId: "person-migration-admin" }, executor: null } as const;
  mkdirSync(sourceRoot);
  mkdirSync(targetRoot);
  initRepo(sourceRoot);
  initRepo(targetRoot);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(sourceRoot), ownerId: "migration-action" });
  try {
    const action = {
      kind: "migrate-storage",
      from: "sqlite",
      to: "sqlite",
      sourceLocation: "source.json",
      targetLocation: "target.json",
      runId: "action-switch",
      exportDirectory: path.join(root, "export"),
      mode: "migrate",
    };
    const denied = await cell.run(
      action,
      withPolicyGroup(
        { actor: { ...actor, principal: { personId: "person-migration-contributor" } }, source: "local" },
        "contributor",
      ),
    );
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    assert.equal(denied.acceptance, null);
    for (const [file, rootDir] of [
      ["source.json", sourceRoot],
      ["target.json", targetRoot],
    ]) {
      writeFileSync(path.join(sourceRoot, file!), JSON.stringify({ rootDir, storage: { backend: "sqlite", scope } }));
    }
    const allowed = await cell.run(action, withPolicyGroup({ actor, source: "local" }, "admin"));
    assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
    assert.equal(JSON.parse(String(allowed.evidence)).phase, "target_activated");
    const oldWriter = openSqliteEventStore({ repoId, rootInput: sourceRoot });
    try {
      assert.throws(
        () => oldWriter.claimWriter({ repoId, holder: "stale", epoch: 9999 }),
        /storage_migration_read_only/,
      );
    } finally {
      oldWriter.close();
    }
    const freshWriter = makeTaskEventStore({ repoId, rootDir: targetRoot });
    assert.ok(freshWriter.currentCut().revision > 0);
    await freshWriter.drain();
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
