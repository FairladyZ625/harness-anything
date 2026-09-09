// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

/**
 * Fault and recovery across the stages one entity import passes through: the bytes are read at the ingress,
 * the manifest is accepted into SQLite, and only then does the Git follower publish and materialize. The
 * lifecycle tests next door prove the settled shapes; what is proven here is what an interruption between two
 * of those stages leaves behind, and what a later process can still recover from the ledger alone.
 */
const researchKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
  binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-entity-durability" },
        executor: { kind: "agent" as const, id: "entity-durability-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  // Bytes a text-shaped roundtrip would quietly repair: an interior NUL, a high byte that is not valid UTF-8,
  // and a CRLF pair. If anything on the path decodes and re-encodes, this file comes back different.
  binaryBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x7f]),
  readmeBytes = "# Interrupted\n\nThe bytes that must survive the interruption.\n";

interface OwnedContent {
  readonly content: readonly { readonly sha256: string; readonly byteLength: number }[];
  readonly bindings: readonly { readonly path: string; readonly contentSha256: string }[];
  readonly directories: readonly { readonly path: string }[];
}

/**
 * The interruption lands after SQLite has accepted the manifest and before the Git follower is ever scheduled:
 * the operation is durable, nothing is published, and the caller is told exactly that. A later process holding
 * only the ledger has to be able to put every byte back — including a zero-byte file, a binary file and an
 * empty directory — with the imported source already gone from the worktree.
 */
test("An entity accepted into SQLite recovers its bytes after its publication is interrupted", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-interrupted-publication-")),
    sourcePath = "research/interrupted",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-interrupted-publication");
  let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    armed = true;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "blobs"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "reserved"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), readmeBytes);
    writeFileSync(path.join(absoluteSource, "blobs", "empty.bin"), Buffer.alloc(0));
    writeFileSync(path.join(absoluteSource, "blobs", "binary.bin"), binaryBytes);
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add a source whose publication will be interrupted");

    crashed = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-interrupted-generation-one",
      now: () => "2026-09-09T20:00:00.000Z",
      killpoint: (point) => {
        if (armed && point === "after_sqlite_commit") {
          armed = false;
          throw new Error("crash:after_sqlite_commit");
        }
      },
    });
    const baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
      interrupted = await crashed.run(
        { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
        binding,
      );
    // The receipt is the whole point of this stage: durable acceptance, no claim of publication, and the opId
    // to ask again with. Nothing here may read as success.
    assert.equal(interrupted.outcome, "pending", JSON.stringify(interrupted));
    assert.equal(interrupted.code, "publication_indeterminate", JSON.stringify(interrupted));
    assert.equal(interrupted.status, "accepted_durable", JSON.stringify(interrupted));
    assert.equal(interrupted.acceptance?.revisionTo, baselineRevision + 1, JSON.stringify(interrupted.acceptance));
    assert.deepEqual(
      {
        durable: interrupted.proof?.durable,
        visible: interrupted.proof?.canonicalVisible,
        worktree: interrupted.proof?.worktreeVisible,
      },
      { durable: true, visible: false, worktree: false },
      "an accepted-but-unpublished import must state exactly that",
    );
    assert.ok(
      (interrupted.git?.cut?.revision ?? 0) < (interrupted.acceptance?.cut.revision ?? 0),
      `Git must still be behind the accepted cut, saw ${JSON.stringify(interrupted.git)}`,
    );

    // Durable: the manifest is in SQLite under the opId the caller was handed, and it is the only one there.
    const accepted = makeTaskEventReader({ repoId, rootDir }).read(),
      entityEvents = accepted.events.filter((event) => event.schema === "entity-event/v1");
    assert.ok(accepted.revision > baselineRevision, "an interrupted publication must not roll back its acceptance");
    assert.equal(entityEvents.length, 1, JSON.stringify(entityEvents.map(({ opId }) => opId)));
    const acceptedEvent = entityEvents[0] as unknown as {
        readonly opId: string;
        readonly payload: { readonly entityId: string; readonly ownedContent: OwnedContent };
      },
      entityId = acceptedEvent.payload.entityId,
      root = `entities/research/${entityId}`;
    assert.equal(acceptedEvent.opId, interrupted.opId, "the receipt must name the operation that was accepted");

    // Not published: the follower was never scheduled, so nothing was materialized and nothing was committed.
    assert.equal(
      existsSync(path.join(rootDir, "harness", root)),
      false,
      "acceptance is not publication: an interrupted import must not leave a materialized tree",
    );

    // The source goes away before anything is read back, so every byte below comes from the center.
    rmSync(absoluteSource, { recursive: true });
    await crashed.close();
    crashed = undefined;
    assert.equal(
      existsSync(path.join(rootDir, "harness", root)),
      false,
      "closing the interrupted process must not publish what it never scheduled",
    );

    recovered = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-interrupted-generation-two",
      now: () => "2026-09-09T20:30:00.000Z",
    });
    const settled = await recovered.run(
      {
        kind: "receipt-show",
        opId: interrupted.opId,
        waitFor: ["git_verified", "worktree_visible"],
        timeoutMs: 20_000,
      },
      binding,
    );
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));

    // Byte proof, from the ledger's own objects and from the tree the recovery materialized.
    const reader = makeTaskEventReader({ repoId, rootDir }),
      blobOf = (bound: string) => {
        const object = acceptedEvent.payload.ownedContent.bindings.find(({ path: held }) => held === bound);
        assert.ok(object, `the accepted manifest must bind ${bound}`);
        const bytes = reader.readContentBlob(object.contentSha256);
        assert.ok(bytes, `${bound} must still be readable from canonical storage`);
        return Buffer.from(bytes);
      };
    assert.equal(blobOf(`${root}/README.md`).toString("utf8"), readmeBytes);
    assert.equal(blobOf(`${root}/blobs/empty.bin`).byteLength, 0, "a zero-byte object is content, not absence");
    assert.deepEqual(blobOf(`${root}/blobs/binary.bin`), binaryBytes, "binary bytes must survive byte for byte");

    const held = (...segments: readonly string[]) => path.join(rootDir, "harness", root, ...segments);
    assert.equal(readFileSync(held("README.md"), "utf8"), readmeBytes);
    assert.equal(statSync(held("blobs", "empty.bin")).size, 0);
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes);
    assert.ok(statSync(held("reserved")).isDirectory(), "only the manifest can carry an empty directory back");
    assert.equal(existsSync(absoluteSource), false, "the recovery must owe nothing to the deleted source");

    // Git is the second durable record, and it carries the same bytes the manifest named.
    assert.equal(
      git(rootDir, "cat-file", "-p", `HEAD:harness/${root}/README.md`),
      readmeBytes.trim(),
      "the published commit must hold the entity's own bytes",
    );

    // Cold rebuild: throw the materialized tree away and let the ledger put it back through the operator's
    // own entry point, with the source still gone.
    rmSync(path.join(rootDir, "harness", root), { recursive: true, force: true });
    const rebuilt = await recovered.run({ kind: "doc-materialize" }, binding);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
    assert.deepEqual(readFileSync(held("blobs", "binary.bin")), binaryBytes, "a cold rebuild restores the same bytes");
    assert.equal(statSync(held("blobs", "empty.bin")).size, 0);
    assert.ok(statSync(held("reserved")).isDirectory());
  } finally {
    await crashed?.close();
    await recovered?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * The negative control for the case above: the same import, interrupted one stage earlier. Nothing is accepted,
 * so there is nothing to recover — and the receipt says so rather than reporting a success the ledger cannot
 * back. The same request after a restart is a first import, not a replay.
 */
test("An entity import interrupted before acceptance leaves nothing accepted and nothing published", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-preaccept-interruption-")),
    sourcePath = "research/preaccept",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-preaccept-interruption");
  let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    armed = true;
  try {
    initRepo(rootDir);
    mkdirSync(absoluteSource, { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), readmeBytes);
    writeFileSync(path.join(absoluteSource, "binary.bin"), binaryBytes);
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add a source whose acceptance will be interrupted");

    crashed = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-preaccept-generation-one",
      now: () => "2026-09-09T21:00:00.000Z",
      killpoint: (point) => {
        if (armed && point === "before_event_write") {
          armed = false;
          throw new Error("crash:before_event_write");
        }
      },
    });
    const request = { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
      baselineRevision = makeTaskEventReader({ repoId, rootDir }).read().revision,
      refused = await crashed.run(request, binding);
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.acceptance, null, JSON.stringify(refused));
    const rolledBack = makeTaskEventReader({ repoId, rootDir }).read();
    assert.equal(rolledBack.revision, baselineRevision, "a pre-acceptance crash must roll its transaction back");
    assert.equal(
      rolledBack.events.filter((event) => event.schema === "entity-event/v1").length,
      0,
      "no entity event may survive a crash before the event write",
    );

    await crashed.close();
    crashed = undefined;
    recovered = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-preaccept-generation-two",
      now: () => "2026-09-09T21:30:00.000Z",
    });
    const missing = await recovered.run({ kind: "receipt-show", opId: refused.opId }, binding);
    assert.equal(missing.acceptance, null, JSON.stringify(missing));
    assert.notEqual(missing.outcome, "applied", JSON.stringify(missing));
    assert.equal(
      existsSync(path.join(rootDir, "harness", "entities", "research")),
      false,
      "a refused import must leave no content root behind",
    );

    // The retry is a first import: it mints an identity and publishes the bytes the crashed attempt never held.
    const retried = await recovered.run(request, binding);
    assert.equal(retried.outcome, "applied", JSON.stringify(retried));
    const entityId = (JSON.parse(String(retried.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.match(entityId, /^RES-[a-f0-9]{32}$/u);
    const published = await recovered.run(
      { kind: "receipt-show", opId: retried.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 20_000 },
      binding,
    );
    assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", `entities/research/${entityId}`, "binary.bin")),
      binaryBytes,
    );
  } finally {
    await crashed?.close();
    await recovered?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * A center that has lost its writer epoch is exactly the node that does not know it: it still holds a repo cell,
 * a valid role binding and a well-formed import. The fence is the only thing between it and a durable write, so
 * what it must produce is nothing at all — no event, no object, no content root — while the same request under
 * the current epoch goes through, which is what keeps this a statement about the fence and not about the request.
 */
test("An entity import under a superseded writer epoch writes nothing while the current epoch writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-stale-fence-")),
    repoId = workspaceId("entity-stale-fence"),
    stateRoot = path.join(rootDir, "writer-epochs"),
    fenceOf = (lease: { readonly epoch: number; readonly holderId: string }) =>
      ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      }) as const,
    fenced = (
      authority: ReturnType<typeof openPersistentWriterEpoch>,
      lease: { readonly epoch: number; readonly holderId: string },
    ) => ({
      ...binding,
      assertWriterEpoch: () => authority.assert(repoId, lease.epoch, lease.holderId),
      writerEpochFence: fenceOf(lease),
    });
  let stale: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    current: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const oldAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" }),
    newAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "new-center" });
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "research"), { recursive: true });
    writeFileSync(path.join(rootDir, "research", "held.md"), readmeBytes);
    writeFileSync(path.join(rootDir, "research", "refused.md"), "# Refused\n");
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add a source per epoch");

    const oldLease = oldAuthority.acquire(repoId);
    stale = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-stale-fence-old-center",
      now: () => "2026-09-09T22:00:00.000Z",
      defaultWriterEpochFence: fenceOf(oldLease),
    });
    const held = await stale.run(
      { kind: "entity-import", entityKind: researchKind, locator: "research/held.md", expectedVersion: 0 },
      fenced(oldAuthority, oldLease),
    );
    assert.equal(held.outcome, "applied", JSON.stringify(held));

    // Another center takes the epoch. The old cell is not told; it is only fenced.
    const newLease = newAuthority.acquire(repoId);
    assert.ok(newLease.epoch > oldLease.epoch, JSON.stringify({ oldLease, newLease }));
    const beforeStale = makeTaskEventReader({ repoId, rootDir }).read();
    const refused = await stale
      .run(
        { kind: "entity-import", entityKind: researchKind, locator: "research/refused.md", expectedVersion: 0 },
        fenced(oldAuthority, oldLease),
      )
      .then(
        (receipt) => ({ code: (receipt as { readonly code?: string }).code, receipt }),
        (error: unknown) => ({ code: (error as { readonly code?: string }).code, receipt: null }),
      );
    assert.equal(refused.code, "writer_epoch_stale", JSON.stringify(refused));
    const afterStale = makeTaskEventReader({ repoId, rootDir }).read();
    assert.equal(afterStale.revision, beforeStale.revision, "a fenced-out writer must not move the ledger");
    assert.equal(
      afterStale.events.filter((event) => event.schema === "entity-event/v1").length,
      1,
      "the superseded epoch must leave exactly the entity the current epoch accepted",
    );

    await stale.close().catch(() => undefined);
    stale = undefined;

    // Negative control: the identical refused request, under the epoch that now holds the repository.
    current = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-stale-fence-new-center",
      now: () => "2026-09-09T22:30:00.000Z",
      defaultWriterEpochFence: fenceOf(newLease),
    });
    const accepted = await current.run(
      { kind: "entity-import", entityKind: researchKind, locator: "research/refused.md", expectedVersion: 0 },
      fenced(newAuthority, newLease),
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(
      makeTaskEventReader({ repoId, rootDir })
        .read()
        .events.filter((event) => event.schema === "entity-event/v1").length,
      2,
      "the request the fence refused is accepted once the caller holds the epoch",
    );
  } finally {
    oldAuthority.close();
    newAuthority.close();
    await stale?.close().catch(() => undefined);
    await current?.close().catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * An import copies material into the center; it does not take the material away from whoever handed it over. The
 * source keeps every file, every empty directory and every byte through the import, through a restart, and
 * through the delete that retires the entity's own copy — and the same request sent twice across a restart is
 * still one operation with one outcome.
 */
test("An import and the delete that ends it leave the source untouched, and a resent import replays", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-source-preservation-")),
    sourcePath = "research/source-package",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-source-preservation");
  let first: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    second: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "spool"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), readmeBytes);
    writeFileSync(path.join(absoluteSource, "binary.bin"), binaryBytes);
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add a source that must outlive its entity");
    const sourceIntact = (stage: string) => {
      assert.equal(readFileSync(path.join(absoluteSource, "README.md"), "utf8"), readmeBytes, `README at ${stage}`);
      assert.deepEqual(readFileSync(path.join(absoluteSource, "binary.bin")), binaryBytes, `binary at ${stage}`);
      assert.ok(statSync(path.join(absoluteSource, "spool")).isDirectory(), `empty source directory at ${stage}`);
    };

    first = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-source-preservation-center",
      now: () => "2026-09-09T23:00:00.000Z",
    });
    const request = { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
      imported = await first.run(request, binding),
      entityId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId,
      root = `entities/research/${entityId}`;
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const published = await first.run(
      { kind: "receipt-show", opId: imported.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 20_000 },
      binding,
    );
    assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
    sourceIntact("import");

    await first.close();
    first = undefined;
    second = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-source-preservation-successor",
      now: () => "2026-09-09T23:30:00.000Z",
    });

    // The same intent, resent by a process that never saw the first one: one operation, one entity, one outcome.
    const resent = await second.run(request, binding);
    assert.equal(resent.outcome, "no_changes", JSON.stringify(resent));
    assert.equal(resent.opId, imported.opId, "a resent import must replay the accepted operation, not open a new one");
    assert.equal((JSON.parse(String(resent.evidence)) as { entityId: string }).entityId, entityId);
    sourceIntact("replay");

    const deleted = await second.run(
      {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId,
        expectedVersion: resent.revision,
        reason: "retire the entity, keep the source",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    const retired = await second.run(
      { kind: "receipt-show", opId: deleted.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 20_000 },
      binding,
    );
    assert.equal(retired.wait?.state, "satisfied", JSON.stringify(retired));
    assert.equal(existsSync(path.join(rootDir, "harness", root)), false, "the entity's own copy is retired");
    assert.equal(existsSync(path.join(rootDir, "harness", `${root}.json`)), false);
    sourceIntact("delete");
  } finally {
    await first?.close();
    await second?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * An instance is validated against the schema version it was accepted under, and that pin is a durable fact
 * rather than something a warm fold happens to remember. Publishing v2 and then reading the v1 instance from a
 * process that folded the ledger cold must reach the same descriptor and the same bytes — while a new instance
 * in that same process pins v2, which is how this stays a statement about the pin and not about a stale reader.
 */
test("An instance pinned to schema v1 reads back unchanged from a cold process after v2 is published", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-pinned-version-")),
    repoId = workspaceId("entity-pinned-version"),
    noteKind = {
      id: "durability-note",
      entityType: "artifact",
      idPrefix: "DN",
      display: { singular: "Durability Note", plural: "Durability Notes" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/durability-notes/{id}.json" },
      locatorKinds: ["repository-path"],
      attributes: { summary: { type: "string", required: true } },
    };
  let declaring: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    cold: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "notes"), { recursive: true });
    writeFileSync(path.join(rootDir, "notes", "pinned.md"), readmeBytes);
    writeFileSync(path.join(rootDir, "notes", "later.md"), "# Later\n");
    git(rootDir, "add", "notes");
    git(rootDir, "commit", "-qm", "add note sources");

    declaring = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-pinned-version-center",
      now: () => "2026-09-09T18:00:00.000Z",
    });
    const created = await declaring.run(
      { kind: "vertical-kind-upsert", kindId: "durability-note", expectedVersion: 0, declaration: noteKind },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const kindRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef,
      pinned = await declaring.run(
        {
          kind: "entity-import",
          entityKind: kindRef,
          locator: "notes/pinned.md",
          expectedVersion: 0,
          attributes: { summary: "pinned to v1" },
        },
        binding,
      );
    assert.equal(pinned.outcome, "applied", JSON.stringify(pinned));
    const pinnedId = (JSON.parse(String(pinned.evidence)) as { preview: { entityId: string } }).preview.entityId,
      kindRow = (await declaring.read("repo.vertical.declaration.read", {}, binding)).declaration.entityKinds.find(
        (candidate: Record<string, unknown>) => `entity-kind/${String(candidate.kindId)}` === kindRef,
      ) as { readonly revision: number };
    const publishedV2 = await declaring.run(
      {
        kind: "vertical-kind-publish-schema",
        kindId: kindRef,
        expectedVersion: Number(kindRow.revision),
        attributes: { summary: { type: "string", required: true }, confidence: { type: "integer" } },
      },
      binding,
    );
    assert.equal(publishedV2.outcome, "applied", JSON.stringify(publishedV2));
    assert.equal((JSON.parse(String(publishedV2.evidence)) as { kindVersion: number }).kindVersion, 2);

    await declaring.close();
    declaring = undefined;
    cold = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-pinned-version-cold",
      now: () => "2026-09-09T18:30:00.000Z",
    });

    // The pin, folded from the ledger by a process that never saw the v1 registry.
    const descriptor = await cold.run({ kind: "entity-get", entityKind: kindRef, entityId: pinnedId }, binding);
    assert.equal(descriptor.outcome, "applied", JSON.stringify(descriptor));
    assert.deepEqual(
      (() => {
        const value = (JSON.parse(String(descriptor.evidence)) as { entity: { value: Record<string, unknown> } }).entity
          .value;
        return [value.kindVersion, value.attributes];
      })(),
      [1, { summary: "pinned to v1" }],
      "a cold rebuild must not re-pin an accepted instance to the newest schema version",
    );
    const content = (await cold.read(
      "repo.entity.content.read",
      { entityKind: kindRef, entityId: pinnedId, path: "pinned.md" },
      binding,
    )) as { readonly outcome: string; readonly content: string | null };
    assert.deepEqual([content.outcome, content.content], ["file", readmeBytes], "the pinned instance keeps its bytes");

    // Control: the registry really did move, so the v1 answer above is a pin and not a reader that missed v2.
    const later = await cold.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/later.md",
        expectedVersion: 0,
        attributes: { summary: "after v2", confidence: 7 },
      },
      binding,
    );
    assert.equal(later.outcome, "applied", JSON.stringify(later));
    const laterId = (JSON.parse(String(later.evidence)) as { preview: { entityId: string } }).preview.entityId,
      laterDescriptor = await cold.run({ kind: "entity-get", entityKind: kindRef, entityId: laterId }, binding);
    assert.deepEqual(
      (() => {
        const value = (JSON.parse(String(laterDescriptor.evidence)) as { entity: { value: Record<string, unknown> } })
          .entity.value;
        return [value.kindVersion, value.attributes];
      })(),
      [2, { summary: "after v2", confidence: 7 }],
      "an instance accepted after the publication pins the version it was accepted under",
    );
  } finally {
    await declaring?.close();
    await cold?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
