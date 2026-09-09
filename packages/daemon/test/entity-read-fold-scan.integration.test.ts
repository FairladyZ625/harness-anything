// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type CanonicalEventStore } from "../../kernel/src/index.ts";
import { compiledArtifactKinds, readCurrentArtifact, resolveSourceBinding } from "../src/artifact-entity-action.ts";
import type { VerticalDeclarationReader } from "../src/vertical-declaration-action.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const adrKind = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
  researchKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
  binding = withRoleBinding(
    {
      actor: { principal: { personId: "person-fold-scan" }, executor: { kind: "agent" as const, id: "fold-edge" } },
      source: "local" as const,
    },
    "repo-write",
  );

/**
 * Every way this read path can reach the ledger, counted. `read` is the full-history load the fold must never
 * perform; `foldedEvents` is how many event rows the fold actually consumed, so folding each accepted event
 * exactly once over a whole test is an observable property rather than a claim about wall clock.
 */
interface StoreScanCounts {
  read: number;
  readEvents: number;
  readBatch: number;
  foldedEvents: number;
  ledgerMetadata: number;
  contentBlob: number;
}

function countingStore(inner: CanonicalEventStore): {
  readonly store: CanonicalEventStore;
  readonly counts: StoreScanCounts;
} {
  const counts: StoreScanCounts = {
    read: 0,
    readEvents: 0,
    readBatch: 0,
    foldedEvents: 0,
    ledgerMetadata: 0,
    contentBlob: 0,
  };
  return {
    counts,
    store: {
      ...inner,
      read: () => {
        const stream = inner.read();
        counts.read += 1;
        counts.readEvents += stream.events.length;
        return stream;
      },
      readBatch: (cursor, maxItems) => {
        const batch = inner.readBatch(cursor, maxItems);
        counts.readBatch += 1;
        counts.foldedEvents += batch.events.length;
        return batch;
      },
      ledgerMetadata: () => {
        counts.ledgerMetadata += 1;
        return inner.ledgerMetadata();
      },
      readContentBlob: (sha256) => {
        counts.contentBlob += 1;
        return inner.readContentBlob(sha256);
      },
    },
  };
}

/** The compiled Kinds a read is answered against, taken from the declaration the ledger already accepted. */
function verticalReader(store: CanonicalEventStore): VerticalDeclarationReader {
  const declared = [...store.read().events]
    .reverse()
    .find(({ schema }) => schema === "vertical-declaration-event/v1") as
    | { readonly payload: { readonly declaration: unknown } }
    | undefined;
  if (!declared) throw new Error("fixture ledger has no accepted vertical declaration");
  const body = `${JSON.stringify(declared.payload.declaration, null, 2)}\n`;
  return { readDocument: () => ({ document: { body } }) } as unknown as VerticalDeclarationReader;
}

function seedSource(rootDir: string, relative: string, body: string): void {
  mkdirSync(path.join(rootDir, path.dirname(relative)), { recursive: true });
  writeFileSync(path.join(rootDir, relative), body);
}

function entityIdOf(evidence: unknown): string {
  return (JSON.parse(String(evidence)) as { preview: { entityId: string } }).preview.entityId;
}

test("Warm entity reads fold the accepted ledger forward instead of reloading its history", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-fold-scan-")),
    adrPath = "docs/adr-0007.md",
    researchPath = "research/2026-09-09-fold",
    repoId = workspaceId("entity-fold-scan");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    seedSource(rootDir, adrPath, "# Fold the ledger forward\n\nFirst observation.\n");
    seedSource(rootDir, path.join(researchPath, "README.md"), "# Fold research\n\nSupporting material.\n");
    git(rootDir, "add", "docs", "research");
    git(rootDir, "commit", "-qm", "add artifact sources");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-fold-scan-center",
      now: () => "2026-09-09T02:00:00.000Z",
    });

    const adrRequest = { kind: "entity-import", entityKind: adrKind, locator: adrPath, expectedVersion: 0 },
      imported = await cell.run(adrRequest, binding),
      adrId = entityIdOf(imported.evidence),
      importedResearch = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: researchPath, expectedVersion: 0 },
        binding,
      ),
      researchId = entityIdOf(importedResearch.evidence);
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    assert.equal(importedResearch.outcome, "applied", JSON.stringify(importedResearch));

    const probe = makeTaskEventReader({ repoId, rootDir }),
      contracts = compiledArtifactKinds(verticalReader(probe), repoId),
      { store, counts } = countingStore(makeTaskEventReader({ repoId, rootDir })),
      revisionNow = () => probe.ledgerMetadata().revision;

    // Cold fold: every accepted event is consumed once, and the whole-history load never happens at all.
    const coldRevision = revisionNow(),
      cold = readCurrentArtifact(store, contracts, adrKind, adrId);
    assert.equal(counts.read, 0, "a read must never load the whole event stream");
    assert.equal(counts.foldedEvents, coldRevision, "the cold fold consumes each accepted event exactly once");
    assert.equal(cold?.revision, imported.revision);
    assert.equal(cold?.descriptor?.locator.value, adrPath);
    assert.equal(counts.contentBlob, 1, "only the requested entity's descriptor blob is read");

    // Warm read at the same cut: no event rows at all, only the ledger's own revision row.
    const foldedAfterCold = counts.foldedEvents,
      metadataAfterCold = counts.ledgerMetadata,
      warm = readCurrentArtifact(store, contracts, adrKind, adrId);
    assert.equal(counts.foldedEvents, foldedAfterCold, "a warm read at an unchanged cut folds no further events");
    assert.equal(counts.ledgerMetadata - metadataAfterCold, 1, "the warm read costs one ledger revision row");
    assert.equal(counts.read, 0);
    assert.deepEqual(warm, cold, "the warm read answers exactly what the cold fold answered");

    // The source binding lookup shares that fold rather than opening a second scan of its own.
    const bound = resolveSourceBinding(store, adrKind, `repo:${repoId}:${adrPath}`);
    assert.deepEqual(bound, { entityId: adrId, generation: 0 });
    assert.equal(counts.foldedEvents, foldedAfterCold, "the binding lookup at the same cut folds no further events");

    // Two Kinds on one fold stay isolated: neither Kind can answer for the other's identity.
    assert.equal(readCurrentArtifact(store, contracts, researchKind, researchId)?.revision, importedResearch.revision);
    assert.equal(readCurrentArtifact(store, contracts, researchKind, adrId), null);
    assert.equal(readCurrentArtifact(store, contracts, adrKind, researchId), null);
    assert.deepEqual(resolveSourceBinding(store, researchKind, `repo:${repoId}:${adrPath}`), {
      entityId: null,
      generation: 0,
    });
    assert.equal(counts.foldedEvents, foldedAfterCold, "cross-Kind reads at the same cut fold no further events");

    // An unrelated acceptance advances the cut: the fold takes only the new events, never the history again.
    const beforeUnrelated = revisionNow(),
      unrelated = await cell.run({ kind: "task-create", taskId: "task-fold", title: "Fold" }, binding);
    assert.equal(unrelated.outcome, "applied", JSON.stringify(unrelated));
    const afterUnrelated = revisionNow(),
      foldedBeforeUnrelated = counts.foldedEvents,
      acrossUnrelated = readCurrentArtifact(store, contracts, adrKind, adrId);
    assert.ok(afterUnrelated > beforeUnrelated, "the fixture must actually advance the ledger");
    assert.equal(
      counts.foldedEvents - foldedBeforeUnrelated,
      afterUnrelated - beforeUnrelated,
      "an unrelated acceptance costs its own events, not the accepted history",
    );
    assert.deepEqual(acrossUnrelated, cold, "an unrelated revision must not change what this entity is");

    // A descriptor update is folded the same incremental way and is visible at the next cut.
    const beforeUpdate = revisionNow(),
      updated = await cell.run(
        {
          kind: "entity-update",
          entityKind: adrKind,
          entityId: adrId,
          expectedVersion: imported.revision,
          title: "Folded title",
        },
        binding,
      ),
      afterUpdate = revisionNow(),
      foldedBeforeUpdate = counts.foldedEvents,
      afterUpdateRead = readCurrentArtifact(store, contracts, adrKind, adrId);
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    assert.equal(counts.foldedEvents - foldedBeforeUpdate, afterUpdate - beforeUpdate);
    assert.equal(afterUpdateRead?.revision, updated.revision);
    assert.equal(afterUpdateRead?.descriptor?.title, "Folded title");

    // A delete releases the source and leaves the entity at the revision it was deleted on, so the next command
    // still has a fence to present and a re-import of the same path starts a new binding.
    const deleted = await cell.run(
        {
          kind: "entity-delete",
          entityKind: adrKind,
          entityId: adrId,
          expectedVersion: updated.revision,
          reason: "release the source",
        },
        binding,
      ),
      afterDelete = readCurrentArtifact(store, contracts, adrKind, adrId);
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    assert.equal(afterDelete?.revision, deleted.revision, "a deleted entity keeps the revision it was deleted on");
    assert.equal(afterDelete?.descriptor, null, "a deleted entity has no descriptor");
    assert.deepEqual(resolveSourceBinding(store, adrKind, `repo:${repoId}:${adrPath}`), {
      entityId: null,
      generation: 1,
    });

    const reimported = await cell.run(adrRequest, binding),
      reimportedId = entityIdOf(reimported.evidence);
    assert.equal(reimported.outcome, "applied", JSON.stringify(reimported));
    assert.notEqual(reimportedId, adrId, "a re-import of a released source must mint a new instance");
    assert.deepEqual(resolveSourceBinding(store, adrKind, `repo:${repoId}:${adrPath}`), {
      entityId: reimportedId,
      generation: 1,
    });
    assert.equal(readCurrentArtifact(store, contracts, adrKind, reimportedId)?.revision, reimported.revision);

    // The oracle for the whole run: no full-history load ever happened, and across every read above each
    // accepted event was folded exactly once. A read that rescanned the history would multiply this count.
    assert.equal(counts.read, 0, "no read on this path may load the whole event stream");
    assert.equal(counts.readEvents, 0);
    assert.equal(counts.foldedEvents, revisionNow(), "each accepted event is folded exactly once across all reads");

    // A cold fold of the same ledger has to answer identically to the incrementally folded one.
    const rebuilt = makeTaskEventReader({ repoId, rootDir });
    for (const [kind, entityId] of [
      [adrKind, adrId],
      [adrKind, reimportedId],
      [researchKind, researchId],
    ] as const)
      assert.deepEqual(
        readCurrentArtifact(rebuilt, contracts, kind, entityId),
        readCurrentArtifact(store, contracts, kind, entityId),
        `cold rebuild must answer identically for ${kind}/${entityId}`,
      );
    assert.deepEqual(
      resolveSourceBinding(rebuilt, adrKind, `repo:${repoId}:${adrPath}`),
      resolveSourceBinding(store, adrKind, `repo:${repoId}:${adrPath}`),
    );
    await rebuilt.drain();
    await probe.drain();
    await store.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("An entity fold answers only for the ledger it was built from", async () => {
  const roots = [
      mkdtempSync(path.join(tmpdir(), "ha-entity-fold-repo-a-")),
      mkdtempSync(path.join(tmpdir(), "ha-entity-fold-repo-b-")),
    ] as const,
    adrPath = "docs/adr-0009.md",
    repoIds = [workspaceId("entity-fold-repo-a"), workspaceId("entity-fold-repo-b")] as const,
    cells: (Awaited<ReturnType<typeof openRepoCell>> | undefined)[] = [];
  try {
    const imports: { readonly entityId: string; readonly repoId: string; readonly rootDir: string }[] = [];
    for (const [index, rootDir] of roots.entries()) {
      initRepo(rootDir);
      seedSource(rootDir, adrPath, `# Repository ${String(index)}\n\nSame path, different ledger.\n`);
      git(rootDir, "add", "docs");
      git(rootDir, "commit", "-qm", "add artifact source");
      const cell = await openRepoCell({
        repoId: repoIds[index]!,
        rootDir: canonicalRoot(rootDir),
        ownerId: `entity-fold-repo-${String(index)}-center`,
        now: () => "2026-09-09T03:00:00.000Z",
      });
      cells.push(cell);
      const imported = await cell.run(
        { kind: "entity-import", entityKind: adrKind, locator: adrPath, expectedVersion: 0 },
        binding,
      );
      assert.equal(imported.outcome, "applied", JSON.stringify(imported));
      imports.push({ entityId: entityIdOf(imported.evidence), repoId: repoIds[index]!, rootDir });
    }
    const [first, second] = imports as [(typeof imports)[number], (typeof imports)[number]];
    assert.notEqual(first.entityId, second.entityId);

    const stores = imports.map(({ repoId, rootDir }) => makeTaskEventReader({ repoId, rootDir })),
      contracts = compiledArtifactKinds(verticalReader(stores[0]!), first.repoId);
    try {
      // Warm both folds, then ask each one for the other repository's material.
      assert.equal(
        readCurrentArtifact(stores[0]!, contracts, adrKind, first.entityId)?.descriptor?.locator.value,
        adrPath,
      );
      assert.equal(
        readCurrentArtifact(stores[1]!, contracts, adrKind, second.entityId)?.descriptor?.locator.value,
        adrPath,
      );
      assert.equal(readCurrentArtifact(stores[0]!, contracts, adrKind, second.entityId), null);
      assert.equal(readCurrentArtifact(stores[1]!, contracts, adrKind, first.entityId), null);
      assert.deepEqual(resolveSourceBinding(stores[0]!, adrKind, `repo:${first.repoId}:${adrPath}`), {
        entityId: first.entityId,
        generation: 0,
      });
      assert.deepEqual(
        resolveSourceBinding(stores[0]!, adrKind, `repo:${second.repoId}:${adrPath}`),
        { entityId: null, generation: 0 },
        "one repository's fold must never answer for another repository's source",
      );
    } finally {
      for (const store of stores) await store.drain();
    }
  } finally {
    for (const cell of cells) await cell?.close();
    for (const rootDir of roots) rmSync(rootDir, { recursive: true, force: true });
  }
});
