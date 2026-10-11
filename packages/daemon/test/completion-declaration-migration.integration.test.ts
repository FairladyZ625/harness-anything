// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventStore,
  makeTaskEventReader,
  makeTaskProjection,
} from "@harness-anything/kernel";
import { migrateCompletion } from "@harness-anything/preset/internal/preset-resolver";
import { initRepo, ownerBinding, standardMigration } from "./doc-sync-slice-a.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { readCanonicalVerticalDeclaration } from "../src/vertical-declaration-action.ts";

test("converted historical declaration is accepted, replayed on reopen and permits a relation write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-declaration-migration-")),
    repoId = workspaceId("completion-migration"),
    oldBody = readFileSync(
      new URL("../../preset/fixtures/completion-migration/repository-before.json", import.meta.url),
      "utf8",
    );
  initRepo(root);
  const bootstrapped = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(root),
    ownerId: "migration-bootstrap",
  });
  await bootstrapped.close();
  const seed = makeTaskEventStore({ repoId, rootDir: root, activationPreflight: activateEmptyCanonicalGeneration });
  const historicalRevision = (seed.readHead()?.revision ?? 0) + 1;
  seed.append(standardMigration(historicalRevision, "vertical.json", oldBody));
  await seed.drain();
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "migration-test" });
  try {
    const source = path.join(root, "old.json"),
      candidate = path.join(root, "candidate.json");
    writeFileSync(source, oldBody);
    migrateCompletion({ source, destination: candidate, dryRun: false });
    writeFileSync(path.join(root, "harness", "vertical.json"), readFileSync(candidate));
    const accepted = await cell.run({ kind: "doc-submit", paths: ["vertical.json"] }, ownerBinding);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "migration-reopen" });
    const reader = makeTaskEventReader({ repoId, rootDir: root }),
      projection = makeTaskProjection({ rootDir: root, eventStore: reader });
    try {
      const declaration = readCanonicalVerticalDeclaration(projection)!;
      assert.deepEqual(declaration.definition.completion.gates, {
        ci: { source: "github-actions", appliesTo: "code" },
      });
      assert.equal(declaration.revision, 65820);
      assert.equal(reader.read().events[historicalRevision - 1]!.schema, "migration-import-event/v1");
    } finally {
      projection.close();
    }
    for (const taskId of ["task_migration_source", "task_migration_target"])
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, ownerBinding)).outcome, "applied");
    const relation = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_migration_source",
        targetRef: "task/task_migration_target",
        relationType: "depends-on",
        rationale: "Migration acceptance probe",
        expectedVersion: 0,
      },
      ownerBinding,
    );
    assert.equal(relation.outcome, "applied", JSON.stringify(relation));
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
