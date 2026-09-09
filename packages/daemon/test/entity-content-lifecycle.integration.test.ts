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
    // than resurrecting the deleted one. The source is changed first because an unchanged source presents the
    // identical intent, and an intent the ledger already carries replays instead of starting anything.
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
