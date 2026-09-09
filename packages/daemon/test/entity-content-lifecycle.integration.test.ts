// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const researchKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
  binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-entity-content" },
        executor: { kind: "agent" as const, id: "entity-content-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  // A remote edge with no role binding: neither a declared repo-write role nor the local default binding holds
  // for it, so the policy is the only thing standing between this caller and a durable entity write.
  unauthorized = {
    actor: {
      principal: { personId: "person-entity-content-reader" },
      executor: { kind: "agent" as const, id: "entity-content-reader-edge" },
    },
    source: "remote_direct" as const,
    roleBindings: [],
  },
  secondaryNodeBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-entity-content-secondary" },
        executor: { kind: "agent" as const, id: "entity-content-edge-secondary" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

interface OwnedContent {
  readonly content: readonly { readonly sha256: string; readonly byteLength: number }[];
  readonly bindings: readonly { readonly path: string; readonly contentSha256: string }[];
  readonly directories: readonly { readonly path: string }[];
  readonly retirements: readonly { readonly path: string; readonly baseBlobSha256: string }[];
  readonly directoryRetirements: readonly { readonly path: string }[];
}

/**
 * Git has no empty-tree entry, so an empty directory only survives if the manifest states it. The source is
 * deleted before every read below: what is asserted is what the center published, never the source.
 */
test("An imported directory keeps its empty directories through publication and cold rebuild", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-empty-directory-")),
    sourcePath = "research/with-empty-directories",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-empty-directory");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "held", "deeper"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "reserved"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "outbox", "pending"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), "# Empty directories\n");
    writeFileSync(path.join(absoluteSource, "held", "deeper", "kept.txt"), "kept\n");
    // Git cannot commit `reserved/` or `outbox/pending/`; only the manifest can carry them.
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add directory source with empty directories");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-empty-directory-center",
      now: () => "2026-09-09T04:00:00.000Z",
    });

    const receipt = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
        binding,
      ),
      entityId = (JSON.parse(String(receipt.evidence)) as { preview: { entityId: string } }).preview.entityId,
      root = `entities/research/${entityId}`;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(cell, receipt.opId, binding);
    rmSync(absoluteSource, { recursive: true });

    const manifest = acceptedManifest(repoId, rootDir, receipt.opId);
    assert.deepEqual(
      manifest.directories.map(({ path: held }) => held),
      [`${root}/outbox/pending`, `${root}/reserved`],
      "the manifest is the only durable record an empty directory has",
    );
    assert.equal(
      readFileSync(path.join(rootDir, "harness", root, "README.md"), "utf8"),
      "# Empty directories\n",
      "the file side of the same snapshot must be materialized",
    );
    assert.ok(
      existsSync(path.join(rootDir, "harness", root, "reserved")) &&
        statSync(path.join(rootDir, "harness", root, "reserved")).isDirectory(),
      "materialization must restore the empty directory itself",
    );
    assert.ok(statSync(path.join(rootDir, "harness", root, "outbox", "pending")).isDirectory());
    assert.deepEqual(
      execFileSync("git", ["-C", rootDir, "ls-files", "--", `harness/${root}/reserved`], { encoding: "utf8" }),
      "",
      "recovery must not invent a placeholder file to make Git carry the directory",
    );

    // Recovery: throw the whole materialized tree away and let the ledger put it back through the same
    // materializer an operator reaches for. Git can restore the files on its own; only the manifest can
    // restore the directories, and a recovery that returns without them is not the roundtrip that was asked for.
    rmSync(path.join(rootDir, "harness", root), { recursive: true, force: true });
    const restored = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(restored.outcome, "applied", JSON.stringify(restored));
    assert.equal(readFileSync(path.join(rootDir, "harness", root, "README.md"), "utf8"), "# Empty directories\n");
    assert.ok(
      existsSync(path.join(rootDir, "harness", root, "reserved")) &&
        statSync(path.join(rootDir, "harness", root, "reserved")).isDirectory(),
      "an empty directory that is absent after recovery is not a complete directory roundtrip",
    );
    assert.ok(existsSync(path.join(rootDir, "harness", root, "outbox", "pending")));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * Identity is minted, not derived. Two sources holding byte-identical material are two entities; the same
 * source presented twice is one; and moving an entity's source leaves its identity and its bytes alone.
 */
test("Instance identity is independent of source bytes, source path and retries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-identity-")),
    repoId = workspaceId("entity-identity"),
    shared = "# Shared material\n\nIdentical bytes.\n";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "research"), { recursive: true });
    writeFileSync(path.join(rootDir, "research", "left.md"), shared);
    writeFileSync(path.join(rootDir, "research", "right.md"), shared);
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add two sources with identical bytes");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-identity-center",
      now: () => "2026-09-09T05:00:00.000Z",
    });

    const importOf = async (locator: string, expectedVersion: number) => {
      const receipt = await cell!.run(
        { kind: "entity-import", entityKind: researchKind, locator, expectedVersion },
        binding,
      );
      return {
        receipt,
        entityId: (JSON.parse(String(receipt.evidence)) as { preview: { entityId: string } }).preview.entityId,
      };
    };

    const left = await importOf("research/left.md", 0),
      right = await importOf("research/right.md", 0);
    assert.equal(left.receipt.outcome, "applied", JSON.stringify(left.receipt));
    assert.equal(right.receipt.outcome, "applied", JSON.stringify(right.receipt));
    assert.match(left.entityId, /^RES-[a-f0-9]{32}$/u);
    assert.notEqual(left.entityId, right.entityId, "same bytes at two sources are two entities");
    assert.notEqual(left.receipt.opId, right.receipt.opId);

    // Same source presented again, from another node: one operation, one entity, no second mint.
    const retry = await cell.run(
      { kind: "entity-import", entityKind: researchKind, locator: "research/left.md", expectedVersion: 0 },
      secondaryNodeBinding,
    );
    assert.equal(retry.outcome, "no_changes", JSON.stringify(retry));
    assert.equal(retry.opId, left.receipt.opId);
    assert.equal(
      (JSON.parse(String(retry.evidence)) as { entityId: string }).entityId,
      left.entityId,
      "a retry resolves through the source binding instead of minting a second entity",
    );

    // A stale fence from a second node is refused rather than silently applied.
    writeFileSync(path.join(rootDir, "research", "left.md"), `${shared}More.\n`);
    const stale = await cell.run(
      { kind: "entity-import", entityKind: researchKind, locator: "research/left.md", expectedVersion: 0 },
      secondaryNodeBinding,
    );
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "revision_conflict");

    // Moving the material: the entity keeps its identity and the bytes it already owns.
    const moved = await cell.run(
      {
        kind: "entity-update",
        entityKind: researchKind,
        entityId: left.entityId,
        expectedVersion: left.receipt.revision,
        locator: "research/moved-left.md",
      },
      binding,
    );
    assert.equal(moved.outcome, "applied", JSON.stringify(moved));
    await waitForFixturePublication(cell, moved.opId, binding);
    const movedManifest = acceptedManifest(repoId, rootDir, moved.opId),
      ownedFile = `entities/research/${left.entityId}/left.md`;
    assert.ok(
      movedManifest.bindings.some(({ path: bound }) => bound === ownedFile),
      `a move must carry the entity's content forward, saw ${JSON.stringify(movedManifest.bindings)}`,
    );
    assert.deepEqual(movedManifest.retirements, [], "a move retires nothing it still owns");
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", ownedFile), "utf8"), shared);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * An update that drops a file retires exactly that path; a delete retires every path the entity still binds.
 * Neither erases the events that carried the bytes, so the history stays recoverable from the ledger.
 */
test("Update retires only dropped files and delete retires every bound file with recoverable history", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-retirement-")),
    sourcePath = "research/retirement-package",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-retirement");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "notes"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), "# Retirement\n");
    writeFileSync(path.join(absoluteSource, "notes", "keep.md"), "keep\n");
    writeFileSync(path.join(absoluteSource, "notes", "drop.md"), "drop\n");
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add retirement source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-retirement-center",
      now: () => "2026-09-09T06:00:00.000Z",
    });

    const request = { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
      first = await cell.run(request, binding),
      entityId = (JSON.parse(String(first.evidence)) as { preview: { entityId: string } }).preview.entityId,
      root = `entities/research/${entityId}`;
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    await waitForFixturePublication(cell, first.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", root, "notes/drop.md")), true);

    rmSync(path.join(absoluteSource, "notes", "drop.md"));
    const updated = await cell.run({ ...request, expectedVersion: first.revision }, binding);
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    await waitForFixturePublication(cell, updated.opId, binding);
    const updatedManifest = acceptedManifest(repoId, rootDir, updated.opId);
    assert.deepEqual(
      updatedManifest.retirements.map(({ path: retired }) => retired),
      [`${root}/notes/drop.md`],
      "an update retires the file that fell out of the source and nothing else",
    );
    assert.equal(
      existsSync(path.join(rootDir, "harness", root, "notes/drop.md")),
      false,
      "a retired path must not stay in the worktree owned by no event",
    );
    assert.equal(readFileSync(path.join(rootDir, "harness", root, "notes/keep.md"), "utf8"), "keep\n");

    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId,
        expectedVersion: updated.revision,
        reason: "retire the whole package",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);
    const store = makeTaskEventReader({ repoId, rootDir }),
      deleteEvent = store.read().events.find((event) => event.opId === deleted.opId) as unknown as {
        payload: { ownedContent: OwnedContent };
      },
      retired = deleteEvent.payload.ownedContent.retirements.map(({ path: gone }) => gone).sort();
    assert.deepEqual(
      retired,
      [`${root}.json`, `${root}/README.md`, `${root}/notes/keep.md`].sort(),
      "delete must retire every path the entity still binds, declaration included",
    );
    for (const gone of retired)
      assert.equal(existsSync(path.join(rootDir, "harness", gone)), false, `${gone} must be retired on disk`);

    // The bytes are still reachable through the events that carried them: retirement is not erasure.
    const importedManifest = acceptedManifest(repoId, rootDir, first.opId),
      keepObject = importedManifest.bindings.find(({ path: bound }) => bound === `${root}/notes/keep.md`);
    assert.ok(keepObject, "the accepted import must still name the object it bound");
    assert.equal(
      Buffer.from(store.readContentBlob(keepObject.contentSha256) ?? []).toString("utf8"),
      "keep\n",
      "a deleted entity's history stays readable from the ledger",
    );

    // The source binding is released with the entity: importing that path again mints a new instance rather
    // than resurrecting the deleted one. Changed bytes here only prove the ordinary case; the unchanged-source
    // case is what the rebind test above pins down.
    writeFileSync(path.join(absoluteSource, "README.md"), "# Retirement, second life\n");
    const reimported = await cell.run({ ...request, expectedVersion: 0 }, binding),
      reimportedId = (JSON.parse(String(reimported.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.equal(reimported.outcome, "applied", JSON.stringify(reimported));
    assert.match(reimportedId, /^RES-[a-f0-9]{32}$/u);
    assert.notEqual(reimportedId, entityId);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * Deleting an entity releases the source it was bound to. Importing that source again is a new binding, so it
 * mints a new instance instead of replaying the receipt of the import the delete ended — while a retry inside
 * one binding still gets back the outcome that binding was accepted with, unchanged bytes and all.
 */
test("A deleted source imports again as a new entity while retries inside one binding replay", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-rebind-")),
    repoId = workspaceId("entity-rebind"),
    locator = "research/rebound.md",
    bytes = "# Rebound\n\nThe bytes never change in this test.\n";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "research"), { recursive: true });
    writeFileSync(path.join(rootDir, "research", "rebound.md"), bytes);
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add a source that will be imported twice");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-rebind-center",
      now: () => "2026-09-09T10:00:00.000Z",
    });
    const importRequest = { kind: "entity-import", entityKind: researchKind, locator, expectedVersion: 0 },
      idOf = (evidence: unknown) =>
        (JSON.parse(String(evidence)) as { preview: { entityId: string } }).preview.entityId;

    const first = await cell.run(importRequest, binding),
      firstId = idOf(first.evidence);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    await waitForFixturePublication(cell, first.opId, binding);

    // Retry inside the first binding: one operation, one entity, the outcome it was accepted with.
    const firstRetry = await cell.run(importRequest, secondaryNodeBinding);
    assert.equal(firstRetry.outcome, "no_changes", JSON.stringify(firstRetry));
    assert.equal(firstRetry.opId, first.opId);
    assert.equal((JSON.parse(String(firstRetry.evidence)) as { entityId: string }).entityId, firstId);

    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId: firstId,
        expectedVersion: first.revision,
        reason: "release the source",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);
    assert.equal(
      existsSync(path.join(rootDir, "harness", `entities/research/${firstId}.json`)),
      false,
      "the deleted entity must stay deleted",
    );

    // The same source, the same bytes, the same request: a released binding makes this a new import.
    const second = await cell.run(importRequest, binding),
      secondId = idOf(second.evidence);
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    assert.match(secondId, /^RES-[a-f0-9]{32}$/u);
    assert.notEqual(secondId, firstId, "re-importing a released source must not resurrect the deleted entity");
    assert.notEqual(second.opId, first.opId, "the new binding must not reuse the retired import's operation");
    await waitForFixturePublication(cell, second.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", `entities/research/${secondId}.json`)), true);
    assert.equal(
      existsSync(path.join(rootDir, "harness", `entities/research/${firstId}.json`)),
      false,
      "the old reference must remain deleted after the new import",
    );
    assert.equal(
      acceptedManifest(repoId, rootDir, second.opId).bindings.some(({ path: bound }) =>
        bound.startsWith(`entities/research/${secondId}`),
      ),
      true,
      "the new entity owns its own material rather than the retired entity's",
    );

    // Retry inside the second binding: back to replay, and to the identity that binding minted.
    const secondRetry = await cell.run(importRequest, secondaryNodeBinding);
    assert.equal(secondRetry.outcome, "no_changes", JSON.stringify(secondRetry));
    assert.equal(secondRetry.opId, second.opId);
    assert.equal((JSON.parse(String(secondRetry.evidence)) as { entityId: string }).entityId, secondId);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * A delete retires the directories the entity declared as well as the files it bound. Removal is one non-recursive
 * rmdir per known owned path, deepest first, so anything the user put inside one of those directories keeps it —
 * and keeps every parent of it — standing.
 */
test("Deleting an entity retires its declared empty directories and leaves user content standing", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-directory-retirement-")),
    sourcePath = "research/directory-retirement",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("entity-directory-retirement");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "outbox", "pending"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "reserved"), { recursive: true });
    mkdirSync(path.join(absoluteSource, "notes"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), "# Directory retirement\n");
    writeFileSync(path.join(absoluteSource, "notes", "keep.md"), "keep\n");
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add a source with nested empty directories");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-directory-retirement-center",
      now: () => "2026-09-09T11:00:00.000Z",
    });

    const imported = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
        binding,
      ),
      entityId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId,
      root = `entities/research/${entityId}`,
      held = (...segments: readonly string[]) => path.join(rootDir, "harness", root, ...segments);
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    await waitForFixturePublication(cell, imported.opId, binding);
    assert.deepEqual(
      acceptedManifest(repoId, rootDir, imported.opId).directories.map(({ path: empty }) => empty),
      [`${root}/outbox/pending`, `${root}/reserved`],
      "only the deepest empty directory is stated; its parent is implied by it",
    );
    assert.ok(statSync(held("outbox", "pending")).isDirectory());

    // What the user put inside an owned directory is not the entity's to take away.
    writeFileSync(held("reserved", "user-note.txt"), "mine\n");

    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId,
        expectedVersion: imported.revision,
        reason: "retire the directory package",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);

    assert.equal(existsSync(held("outbox", "pending")), false, "a declared empty directory must be retired");
    assert.equal(existsSync(held("outbox")), false, "its parent is retired once the child is gone: deepest first");
    assert.equal(existsSync(held("notes")), false, "a directory left empty by its retired files goes with them");
    assert.equal(existsSync(held("README.md")), false);
    assert.equal(readFileSync(held("reserved", "user-note.txt"), "utf8"), "mine\n", "user content must survive");
    assert.equal(existsSync(held()), true, "a content root holding user content must not be removed either");

    // Recovery through the operator's own entry point: retirement is not undone, and it is not re-attempted
    // against the directory the user is still using.
    const recovered = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(existsSync(held("outbox")), false, "recovery must not restore a retired directory");
    assert.equal(readFileSync(held("reserved", "user-note.txt"), "utf8"), "mine\n");

    // Once the user's own file is gone, the same retirement takes the directories it was holding open.
    rmSync(held("reserved", "user-note.txt"));
    const retried = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(retried.outcome, "applied", JSON.stringify(retried));
    assert.equal(existsSync(held("reserved")), false, "a retirement that was blocked is re-attempted, not dropped");
    assert.equal(existsSync(held()), false, "the entity's content root goes with the last directory it held");
    assert.equal(
      existsSync(path.join(rootDir, "harness", "entities", "research")),
      true,
      "the shared directory above the entity is not the entity's to retire",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** entity-delete is a durable repository write, so a caller with no repository write role is refused. */
test("Deleting an entity is refused for a caller with no repository write role", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-delete-authorization-")),
    repoId = workspaceId("entity-delete-authorization");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "research"), { recursive: true });
    writeFileSync(path.join(rootDir, "research", "governed.md"), "# Governed\n");
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add a source to govern");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-delete-authorization-center",
      now: () => "2026-09-09T12:00:00.000Z",
    });
    const imported = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: "research/governed.md", expectedVersion: 0 },
        binding,
      ),
      entityId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));

    const request = {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId,
        expectedVersion: imported.revision,
        reason: "unauthorized deletion attempt",
      },
      refused = await cell.run(request, unauthorized);
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.authorizationDecision?.outcome, "denied", JSON.stringify(refused.authorizationDecision));
    assert.equal(
      refused.authorizationDecision?.policyRef,
      "default@5",
      "the refusal must come from the declared policy, not from an ad hoc check",
    );
    assert.equal(
      existsSync(path.join(rootDir, "harness", `entities/research/${entityId}.json`)),
      true,
      "a refused delete must leave the entity exactly where it was",
    );

    // The same call with the repository write role goes through: the action is governed, not disabled.
    const allowed = await cell.run(request, binding);
    assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * Retirement is read off the entity's own accepted manifests, never off the worktree. A directory the user made
 * inside an entity's content root was never declared by any of its events, so it is not in the delete's
 * retirement list and cannot be removed by it — and while it stands, neither can any directory holding it. A
 * second entity living in the same shared parent is likewise untouched: one owner's delete names only its own.
 */
test("A user's own empty directory inside an entity's content root survives that entity's deletion", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-undeclared-directory-")),
    sourcePath = "research/undeclared-directory",
    absoluteSource = path.join(rootDir, sourcePath),
    neighbourPath = "research/neighbour",
    repoId = workspaceId("entity-undeclared-directory");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "outbox", "pending"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "README.md"), "# Undeclared directory\n");
    mkdirSync(path.join(rootDir, neighbourPath, "spool"), { recursive: true });
    writeFileSync(path.join(rootDir, neighbourPath, "README.md"), "# Neighbour\n");
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add two sources under one shared parent");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-undeclared-directory-center",
      now: () => "2026-09-09T16:00:00.000Z",
    });

    const importOf = async (locator: string) => {
        const receipt = await cell!.run(
          { kind: "entity-import", entityKind: researchKind, locator, expectedVersion: 0 },
          binding,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        await waitForFixturePublication(cell!, receipt.opId, binding);
        return {
          receipt,
          entityId: (JSON.parse(String(receipt.evidence)) as { preview: { entityId: string } }).preview.entityId,
        };
      },
      imported = await importOf(sourcePath),
      neighbour = await importOf(neighbourPath),
      held = (...segments: readonly string[]) =>
        path.join(rootDir, "harness", `entities/research/${imported.entityId}`, ...segments),
      neighbourHeld = (...segments: readonly string[]) =>
        path.join(rootDir, "harness", `entities/research/${neighbour.entityId}`, ...segments);
    assert.ok(statSync(held("outbox", "pending")).isDirectory());
    assert.ok(statSync(neighbourHeld("spool")).isDirectory());

    // Two empty directories the entity never declared, made by the user inside the content root it owns.
    mkdirSync(held("scratch", "deep"), { recursive: true });

    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: researchKind,
        entityId: imported.entityId,
        expectedVersion: imported.receipt.revision,
        reason: "delete the entity, not the user's directory",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);

    assert.equal(existsSync(held("outbox", "pending")), false, "a declared empty directory must be retired");
    assert.equal(existsSync(held("outbox")), false, "its parent goes once the child is gone");
    assert.equal(existsSync(held("README.md")), false, "the entity's own file goes with it");
    assert.ok(statSync(held("scratch", "deep")).isDirectory(), "an empty directory the user made is not the entity's");
    assert.ok(statSync(held("scratch")).isDirectory(), "nor is the directory holding it");
    assert.equal(existsSync(held()), true, "a content root still holding the user's directory must stand");
    assert.ok(statSync(neighbourHeld("spool")).isDirectory(), "another owner's directory is not in this delete");
    // And the reason it went that way: the delete named exactly what the entity held, and nothing else.
    assert.deepEqual(
      acceptedManifest(repoId, rootDir, deleted.opId).directoryRetirements.map(({ path: retired }) => retired),
      [
        `entities/research/${imported.entityId}`,
        `entities/research/${imported.entityId}/outbox`,
        `entities/research/${imported.entityId}/outbox/pending`,
      ],
      "a delete retires its own footprint, stated by name",
    );

    // Rebuild reaches the same answer from the ledger alone: still no restoration, still no removal.
    const recovered = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(existsSync(held("outbox")), false, "recovery must not restore a retired directory");
    assert.ok(statSync(held("scratch", "deep")).isDirectory(), "recovery must not remove what the entity never held");
    assert.ok(statSync(neighbourHeld("spool")).isDirectory());

    // Once the user takes their own directory away, the retirement the entity did state completes.
    rmSync(held("scratch"), { recursive: true });
    const retried = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(retried.outcome, "applied", JSON.stringify(retried));
    assert.equal(existsSync(held()), false, "the blocked retirement is re-attempted, not dropped");
    assert.ok(statSync(neighbourHeld("spool")).isDirectory(), "the surviving entity keeps everything it declared");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/**
 * Relinking an entity to another locator restates the directories it holds, so it retires none of them — and it
 * names no path outside its own content root, which is what keeps a concurrent owner in the same shared parent
 * out of the settlement entirely.
 */
test("Relinking an entity retires none of its directories and none of another owner's", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-relink-directory-")),
    repoId = workspaceId("entity-relink-directory");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "research/relinked", "queue"), { recursive: true });
    writeFileSync(path.join(rootDir, "research/relinked", "README.md"), "# Relinked\n");
    mkdirSync(path.join(rootDir, "research/steady", "queue"), { recursive: true });
    writeFileSync(path.join(rootDir, "research/steady", "README.md"), "# Steady\n");
    git(rootDir, "add", "research");
    git(rootDir, "commit", "-qm", "add a source to relink and a source to leave alone");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "entity-relink-directory-center",
      now: () => "2026-09-09T17:00:00.000Z",
    });
    const importOf = async (locator: string) => {
        const receipt = await cell!.run(
          { kind: "entity-import", entityKind: researchKind, locator, expectedVersion: 0 },
          binding,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        await waitForFixturePublication(cell!, receipt.opId, binding);
        return {
          receipt,
          entityId: (JSON.parse(String(receipt.evidence)) as { preview: { entityId: string } }).preview.entityId,
        };
      },
      relinked = await importOf("research/relinked"),
      steady = await importOf("research/steady"),
      held = (...segments: readonly string[]) =>
        path.join(rootDir, "harness", `entities/research/${relinked.entityId}`, ...segments),
      steadyHeld = (...segments: readonly string[]) =>
        path.join(rootDir, "harness", `entities/research/${steady.entityId}`, ...segments);

    const updated = await cell.run(
      {
        kind: "entity-update",
        entityKind: researchKind,
        entityId: relinked.entityId,
        expectedVersion: relinked.receipt.revision,
        title: "Relinked elsewhere",
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    await waitForFixturePublication(cell, updated.opId, binding);
    const manifest = acceptedManifest(repoId, rootDir, updated.opId);
    assert.deepEqual(manifest.directoryRetirements, [], "an update that restates what it holds retires nothing");
    assert.deepEqual(
      manifest.directories.map(({ path: empty }) => empty),
      [`entities/research/${relinked.entityId}/queue`],
      "the declared empty directory is carried through the update",
    );
    assert.ok(statSync(held("queue")).isDirectory());
    assert.ok(statSync(steadyHeld("queue")).isDirectory(), "the other owner is not part of this settlement");
    assert.equal(readFileSync(steadyHeld("README.md"), "utf8"), "# Steady\n");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function acceptedManifest(repoId: string, rootDir: string, opId: string): OwnedContent {
  const event = makeTaskEventReader({ repoId, rootDir })
    .read()
    .events.find((candidate) => candidate.opId === opId) as unknown as
    | { readonly payload: { readonly ownedContent: OwnedContent } }
    | undefined;
  assert.ok(event, `no accepted event for ${opId}`);
  return event.payload.ownedContent;
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
