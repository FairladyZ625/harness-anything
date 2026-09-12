// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEntityKindCatalog, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalVertical, compiledArtifactKinds } from "../src/artifact-entity-action.ts";
import { runVerticalDeclarationAction } from "../src/vertical-declaration-action.ts";
import { resolveVerticalKindCommandAction } from "../src/vertical-kind-command-action.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("repository vertical migration, upsert conflict, and retirement fence on the kind's own revision", async () => {
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
        store,
        projection,
        now: () => "2026-09-05T00:00:00.000Z",
      }),
    kindRevision = (id: string) =>
      compiledArtifactKinds(projection, repoId).find(({ declaration: row }) => row.id === id)!.declaration.revision!;
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
    const staleFence = kindRevision(declaration.id),
      updated = { ...declaration, display: { ...declaration.display, singular: "Updated kind" } };
    const upserted = await run({
      kind: "vertical-kind-upsert",
      kindId: declaration.id,
      declaration: updated,
      expectedVersion: staleFence,
    });
    assert.equal(upserted.outcome, "applied");
    assert.equal(
      compiledArtifactKinds(projection, repoId).find(({ declaration: row }) => row.id === declaration.id)?.declaration
        .display.singular,
      "Updated kind",
    );
    await assert.rejects(
      () =>
        run({
          kind: "vertical-kind-retire",
          kindId: declaration.id,
          expectedVersion: staleFence,
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
          expectedVersion: kindRevision(declaration.id),
          reason: "No longer supported.",
        })
      ).outcome,
      "applied",
    );
    assert.equal(
      compiledArtifactKinds(projection, repoId).some(({ declaration: row }) => row.id === declaration.id),
      true,
    );
    const retired = compiledArtifactKinds(projection, repoId).find(({ declaration: row }) => row.id === declaration.id);
    assert.equal(retired?.declaration.retired, true);
    assert.equal(retired?.declaration.reason, "No longer supported.");
    assert.equal(retired?.declaration.retiredAt, "2026-09-05T00:00:00.000Z");
    // Archiving a kind closes new imports only; the material already stored under it stays manageable.
    assert.deepEqual(
      retired?.entityKindContract.actionCatalog?.actions
        .filter(({ execution }) => execution === null)
        .map(({ id }) => id),
      ["import"],
    );
    const vertical = canonicalVertical(projection, repoId),
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
        expectedVersion: declaration.revision,
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

test("declaration read revision drives create, catalog read, and retirement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-kind-crud-")),
    repoId = workspaceId("vertical-kind-crud"),
    binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "vertical-kind-crud-center" });
    const read = await cell.read("repo.vertical.declaration.read", {}, binding),
      source = read.declaration.entityKinds.find(({ entityType }) => entityType === "artifact");
    assert.ok(source);
    // A new kind is authored, never cloned from another kind's identity or published schema history.
    const { kindId: _sourceKindId, schemaVersions: _sourceVersions, revision: _sourceRevision, ...facets } = source,
      declaration = {
        ...facets,
        id: "e2e-runbook",
        idPrefix: "E2ERUN",
        display: { singular: "E2E Runbook", plural: "E2E Runbooks" },
        store: { pathTemplate: "entities/e2e-runbooks/{id}.json" },
        relations: [],
        attributes: { owner: { type: "string" } },
      },
      sourcePath = path.join(rootDir, "kind.json");
    writeFileSync(sourcePath, `${JSON.stringify(declaration)}\n`);
    const resolvedUpsert = await resolveVerticalKindCommandAction(cell, {
        kind: "vertical-kind-upsert",
        fromFile: "kind.json",
      }),
      upsert = await cell.run(resolvedUpsert, binding);
    assert.equal(resolvedUpsert.kindId, declaration.id);
    assert.equal(resolvedUpsert.expectedVersion, 0);
    assert.equal("fromFile" in resolvedUpsert, false);
    assert.equal(upsert.outcome, "applied", JSON.stringify(upsert));
    const kinds = await cell.read("repo.entity.kinds.read", {}, binding),
      row = kinds.kinds.find(({ declaration: candidate }) => candidate?.id === declaration.id);
    assert.equal(row?.retired, false);
    assert.equal(row?.importable, true);
    const created = (await cell.read("repo.vertical.declaration.read", {}, binding)).declaration.entityKinds.find(
      ({ id }) => id === declaration.id,
    );
    assert.ok(created && created.entityType === "artifact");
    writeFileSync(sourcePath, `${JSON.stringify(created)}\n`);
    const resolvedUpdate = await resolveVerticalKindCommandAction(cell, {
      kind: "vertical-kind-upsert",
      fromFile: "kind.json",
    });
    assert.equal(resolvedUpdate.kindId, created.kindId);
    assert.equal(resolvedUpdate.expectedVersion, created.revision);
    assert.equal("fromFile" in resolvedUpdate, false);
    const retire = await cell.run(
      {
        kind: "vertical-kind-retire",
        kindId: declaration.id,
        expectedVersion: created.revision,
        reason: "E2E lifecycle complete",
      },
      binding,
    );
    assert.equal(retire.outcome, "applied", JSON.stringify(retire));
    const retiredKinds = await cell.read("repo.entity.kinds.read", {}, binding),
      retired = retiredKinds.kinds.find(({ declaration: candidate }) => candidate?.id === declaration.id);
    assert.equal(retired?.retired, true);
    assert.equal(retired?.importable, false);
    console.log(
      JSON.stringify({
        schema: "vertical-kind-crud-receipt-summary/v1",
        isolatedRoot: path.basename(rootDir),
        readRevision: read.declarationRevision,
        upsert: { outcome: upsert.outcome, revision: upsert.revision },
        kindsRead: { declarationRevision: kinds.declarationRevision, kind: row?.kind, retired: row?.retired },
        retire: { outcome: retire.outcome, revision: retire.revision },
        retiredRead: { declarationRevision: retiredKinds.declarationRevision, retired: retired?.retired },
      }),
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
