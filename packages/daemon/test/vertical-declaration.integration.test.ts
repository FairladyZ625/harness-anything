// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import { compiledArtifactKinds } from "../src/artifact-entity-action.ts";
import { runVerticalDeclarationAction } from "../src/vertical-declaration-action.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";

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
      () => run({ kind: "vertical-kind-retire", kindId: declaration.id, expectedVersion: initial.revision }),
      (error: unknown) => (error as { readonly code?: string }).code === "revision_conflict",
    );
    const current = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8"));
    assert.equal(
      (await run({ kind: "vertical-kind-retire", kindId: declaration.id, expectedVersion: current.revision })).outcome,
      "applied",
    );
    assert.equal(
      compiledArtifactKinds(rootDir, repoId).some(({ declaration: row }) => row.id === declaration.id),
      false,
    );
  } finally {
    projection.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
