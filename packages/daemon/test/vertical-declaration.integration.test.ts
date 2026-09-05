// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEntityKindCatalog, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalVertical, compiledArtifactKinds } from "../src/artifact-entity-action.ts";
import { runVerticalDeclarationAction } from "../src/vertical-declaration-action.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("repository vertical migration, upsert conflict, and retirement share one revisioned declaration", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-declaration-")),
    repoId = "vertical-owner-test";
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    binding = { actor, source: "local" as const },
    run = (action: Readonly<Record<string, unknown>> & { readonly kind: string }) =>
      runVerticalDeclarationAction({
        action,
        binding,
        rootDir,
        store,
        projection,
        now: () => "2026-09-05T00:00:00.000Z",
      });
  try {
    const migrated = await run({ kind: "vertical-declaration-migrate" });
    assert.equal(migrated.outcome, "applied");
    const initial = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8"));
    assert.equal(initial.schema, "repository-vertical-declaration/v1");
    assert.equal((await run({ kind: "vertical-declaration-migrate" })).outcome, "no_changes");

    const declaration = initial.definition.entityKinds.find(
      (kind: { readonly entityType: string }) => kind.entityType === "artifact",
    );
    assert.ok(declaration);
    await assert.rejects(
      () => run({ kind: "vertical-kind-upsert", kindId: declaration.id, declaration, expectedVersion: 0 }),
      (error: unknown) => (error as { readonly code?: string }).code === "kind_exists",
    );
    const updated = { ...declaration, display: { ...declaration.display, singular: "Updated kind" } };
    const upserted = await run({
      kind: "vertical-kind-upsert",
      kindId: declaration.id,
      declaration: updated,
      expectedVersion: initial.revision,
    });
    assert.equal(upserted.outcome, "applied");
    assert.equal(
      compiledArtifactKinds(rootDir, repoId).find(({ declaration: row }) => row.id === declaration.id)?.declaration
        .display.singular,
      "Updated kind",
    );
    await assert.rejects(
      () =>
        run({
          kind: "vertical-kind-retire",
          kindId: declaration.id,
          expectedVersion: initial.revision,
          reason: "No longer supported.",
        }),
      (error: unknown) => (error as { readonly code?: string }).code === "revision_conflict",
    );
    const current = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8"));
    assert.equal(
      (
        await run({
          kind: "vertical-kind-retire",
          kindId: declaration.id,
          expectedVersion: current.revision,
          reason: "No longer supported.",
        })
      ).outcome,
      "applied",
    );
    assert.equal(
      compiledArtifactKinds(rootDir, repoId).some(({ declaration: row }) => row.id === declaration.id),
      true,
    );
    const retired = compiledArtifactKinds(rootDir, repoId).find(({ declaration: row }) => row.id === declaration.id);
    assert.equal(retired?.declaration.retired, true);
    assert.equal(retired?.declaration.reason, "No longer supported.");
    assert.equal(retired?.declaration.retiredAt, "2026-09-05T00:00:00.000Z");
    assert.equal(
      retired?.entityKindContract.actionCatalog?.actions.every(({ execution }) => execution === null),
      true,
    );
    const vertical = canonicalVertical(rootDir, repoId),
      catalog = buildEntityKindCatalog(vertical.contract.artifactKinds, vertical.revision),
      retiredRow = catalog.kinds.find(({ declaration: row }) => row?.id === declaration.id);
    assert.equal(catalog.declarationRevision, current.revision + 1);
    assert.equal(retiredRow?.retired, true);
    assert.equal(retiredRow?.importable, false);
    assert.equal(retiredRow?.origin, "vertical");
  } finally {
    projection.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("declaration read round-trips every materialized kind field through unchanged upsert", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-declaration-read-")),
    repoId = workspaceId("vertical-declaration-read"),
    binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "vertical-read-center" });
    const read = await cell.read("repo.vertical.declaration.read", {}, binding),
      materialized = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8")) as {
        revision: number;
        definition: typeof read.declaration;
      };
    assert.equal(read.declarationRevision, materialized.revision);
    assert.deepEqual(read.declaration, materialized.definition);
    const declaration = read.declaration.entityKinds.find(({ entityType }) => entityType === "artifact");
    assert.ok(declaration);
    const receipt = await cell.run(
      {
        kind: "vertical-kind-upsert",
        kindId: declaration.id,
        declaration,
        expectedVersion: read.declarationRevision,
      },
      binding,
    );
    assert.equal(receipt.outcome, "no_changes", JSON.stringify(receipt));
    assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8")), materialized);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
