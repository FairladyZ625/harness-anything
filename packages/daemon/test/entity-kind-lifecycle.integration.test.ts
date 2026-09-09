// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
  {
    actor: {
      principal: { personId: "person-kind-lifecycle" },
      executor: { kind: "agent" as const, id: "kind-lifecycle-edge" },
    },
    source: "local" as const,
  },
  "repo-write",
);

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

const fieldNote = {
  id: "field-note",
  entityType: "artifact",
  idPrefix: "FN",
  display: { singular: "Field Note", plural: "Field Notes" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/field-notes/{id}.json" },
  locatorKinds: ["repository-path"],
  attributes: { summary: { type: "string", required: true } },
};

/**
 * A Kind declared entirely at runtime must hold one identity for its whole life: publishing a second
 * immutable schema version, renaming it and archiving it all leave every existing instance readable
 * through the reference it was created with, still validated by the version it pinned.
 */
test("a runtime-declared Kind keeps identity and instance pins across schema v2, rename and archive", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kind-lifecycle-")),
    repoId = workspaceId("kind-lifecycle");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "notes"), { recursive: true });
    writeFileSync(path.join(rootDir, "notes", "first.md"), "# First note\n");
    writeFileSync(path.join(rootDir, "notes", "second.md"), "# Second note\n");
    writeFileSync(path.join(rootDir, "notes", "third.md"), "# Third note\n");
    git(rootDir, "add", "notes");
    git(rootDir, "commit", "-qm", "add note sources");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "kind-lifecycle-center",
      now: () => "2026-09-09T02:00:00.000Z",
    });
    const kindFence = async (kindRef: string) => {
        const row = (await cell!.read("repo.vertical.declaration.read", {}, binding)).declaration.entityKinds.find(
          (candidate: Record<string, unknown>) =>
            candidate.entityType === "artifact" && `entity-kind/${String(candidate.kindId)}` === kindRef,
        ) as { readonly revision?: number } | undefined;
        assert.ok(row, `declaration has no row for ${kindRef}`);
        return Number(row.revision);
      },
      rows = async () => (await cell!.read("repo.entity.rows.read", {}, binding)).rows,
      descriptorOf = async (kindRef: string, entityId: string) => {
        const receipt = await cell!.run({ kind: "entity-get", entityKind: kindRef, entityId }, binding);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        return (JSON.parse(String(receipt.evidence)) as { entity: { value: Record<string, unknown> } }).entity.value;
      };

    // 1. Create a Kind that exists nowhere in source; the center mints its opaque identity.
    const created = await cell.run(
      {
        kind: "vertical-kind-upsert",
        kindId: "field-note",
        expectedVersion: 0,
        declaration: fieldNote,
      },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const createdEvidence = JSON.parse(String(created.evidence)) as { kindRef: string; kindVersion: number },
      kindRef = createdEvidence.kindRef;
    assert.match(kindRef, /^entity-kind\/KND-[0-9a-f]{32}$/u, "creating a Kind mints a stable opaque identity");
    assert.equal(createdEvidence.kindVersion, 1);

    // 2. Import an instance; it pins the kind's newest schema version and carries pure attributes.
    const firstImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/first.md",
        expectedVersion: 0,
        attributes: { summary: "first" },
      },
      binding,
    );
    assert.equal(firstImport.outcome, "applied", JSON.stringify(firstImport));
    const firstId = (JSON.parse(String(firstImport.evidence)) as { preview: { entityId: string } }).preview.entityId,
      firstRef = `${kindRef}/${firstId}`;
    assert.deepEqual(await descriptorOf(kindRef, firstId).then((value) => [value.kindVersion, value.attributes]), [
      1,
      { summary: "first" },
    ]);

    // Negative: a non-scalar attribute value is refused rather than quietly dropped.
    const nonScalar = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/second.md",
        expectedVersion: 0,
        attributes: { summary: { nested: true } },
      },
      binding,
    );
    assert.equal(nonScalar.outcome, "op_rejected", JSON.stringify(nonScalar));
    assert.equal(nonScalar.code, "invalid_entity_contract", JSON.stringify(nonScalar));

    // Negative: version 1 declares no `confidence`, so the pinned schema refuses it.
    const undeclared = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/second.md",
        expectedVersion: 0,
        attributes: { summary: "second", confidence: 3 },
      },
      binding,
    );
    assert.equal(undeclared.outcome, "op_rejected", JSON.stringify(undeclared));
    assert.equal(undeclared.code, "invalid_entity_contract", JSON.stringify(undeclared));

    // 3. Publish schema version 2 under the SAME Kind identity.
    const published = await cell.run(
      {
        kind: "vertical-kind-publish-schema",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        attributes: { summary: { type: "string", required: true }, confidence: { type: "integer" } },
      },
      binding,
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));
    assert.deepEqual(
      JSON.parse(String(published.evidence)) as { kindRef: string; kindVersion: number },
      {
        schema: "vertical-declaration-result/v1",
        eventType: "vertical_kind_upserted",
        kindId: kindRef,
        kindRef,
        kindVersion: 2,
      } as never,
    );

    // Negative: a published version is immutable; restating the kind with different attributes is refused.
    const rewrite = await cell.run(
      {
        kind: "vertical-kind-upsert",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        declaration: {
          ...fieldNote,
          kindId: kindRef.slice("entity-kind/".length),
          attributes: { summary: { type: "string" } },
        },
      },
      binding,
    );
    assert.equal(rewrite.outcome, "op_rejected", JSON.stringify(rewrite));
    assert.equal(rewrite.code, "immutable_schema_version", JSON.stringify(rewrite));

    // 4. The version-1 instance keeps its pin, its reference and its reading.
    assert.deepEqual(await descriptorOf(kindRef, firstId).then((value) => [value.kindVersion, value.attributes]), [
      1,
      { summary: "first" },
    ]);
    assert.ok(
      (await rows()).some((row) => row.ref === firstRef),
      "publishing schema v2 must not hide the instance pinned to version 1",
    );

    // 5. A new instance pins version 2 and may use the attribute version 2 introduced.
    const secondImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/second.md",
        expectedVersion: 0,
        attributes: { summary: "second", confidence: 3 },
      },
      binding,
    );
    assert.equal(secondImport.outcome, "applied", JSON.stringify(secondImport));
    const secondId = (JSON.parse(String(secondImport.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.deepEqual(await descriptorOf(kindRef, secondId).then((value) => [value.kindVersion, value.attributes]), [
      2,
      { summary: "second", confidence: 3 },
    ]);

    // 6. Rename the Kind. Both references and both pins survive it unchanged.
    const renamed = await cell.run(
      {
        kind: "vertical-kind-upsert",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        declaration: {
          ...fieldNote,
          kindId: kindRef.slice("entity-kind/".length),
          id: "site-observation",
          display: { singular: "Site Observation", plural: "Site Observations" },
          attributes: undefined,
        },
      },
      binding,
    );
    assert.equal(renamed.outcome, "applied", JSON.stringify(renamed));
    assert.equal((JSON.parse(String(renamed.evidence)) as { kindRef: string }).kindRef, kindRef);
    const afterRename = await rows();
    assert.deepEqual(
      afterRename
        .filter((row) => row.kind === kindRef)
        .map((row) => row.ref)
        .sort(),
      [`${kindRef}/${firstId}`, `${kindRef}/${secondId}`].sort(),
      "renaming a Kind moves no instance reference",
    );
    assert.equal((await descriptorOf(kindRef, firstId)).kindVersion, 1);
    assert.equal((await descriptorOf("site-observation", secondId)).kindVersion, 2);

    // 7. Archive the Kind: no new material, but the material already inside stays managed and readable.
    const archived = await cell.run(
      {
        kind: "vertical-kind-retire",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        reason: "Superseded by the site survey pipeline.",
      },
      binding,
    );
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    const blocked = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "notes/third.md",
        expectedVersion: 0,
        attributes: { summary: "third" },
      },
      binding,
    );
    assert.equal(blocked.outcome, "op_rejected", JSON.stringify(blocked));
    assert.equal(blocked.code, "unsupported_command");
    const stillManaged = await cell.run(
      {
        kind: "entity-update",
        entityKind: kindRef,
        entityId: firstId,
        expectedVersion: firstImport.revision,
        title: "First note, revised after archive",
        attributes: { summary: "first, revised" },
      },
      binding,
    );
    assert.equal(stillManaged.outcome, "applied", JSON.stringify(stillManaged));
    const afterArchive = await descriptorOf(kindRef, firstId);
    assert.equal(afterArchive.kindVersion, 1, "an update never silently upgrades the instance's pin");
    assert.deepEqual(afterArchive.attributes, { summary: "first, revised" });
    assert.ok(
      (await rows()).some((row) => row.ref === firstRef),
      "archiving a Kind must not hide the instances already stored under it",
    );

    // 8. Publishing into an archived Kind, and a stale declaration fence, are both refused.
    const afterArchivePublish = await cell.run(
      {
        kind: "vertical-kind-publish-schema",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        attributes: { summary: { type: "string" } },
      },
      binding,
    );
    assert.equal(afterArchivePublish.outcome, "op_rejected", JSON.stringify(afterArchivePublish));
    assert.equal(afterArchivePublish.code, "kind_retired", JSON.stringify(afterArchivePublish));
    const stale = await cell.run(
      {
        kind: "vertical-kind-retire",
        kindId: kindRef,
        expectedVersion: (await kindFence(kindRef)) - 1,
        reason: "Stale fence must not win.",
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "revision_conflict", JSON.stringify(stale));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

const siteLog = {
  id: "site-log",
  entityType: "artifact",
  idPrefix: "SL",
  display: { singular: "Site Log", plural: "Site Logs" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/site-logs/{id}.json" },
  locatorKinds: ["repository-path"],
  attributes: { shift: { type: "string", required: true } },
};

/**
 * Two Kinds are two concurrency subjects. A write to one must not stale a fence a caller read for the
 * other, two writes to the same Kind must collide, and the whole answer must come from the canonical
 * record: an edge node whose `harness/vertical.json` is stale, absent or unpublishable still holds
 * every Kind it accepted, and must not re-seed itself back to the install package.
 */
test("Kind fences are per Kind, and an accepted Kind outlives its worktree materialization", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kind-fence-")),
    repoId = workspaceId("kind-fence");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "notes"), { recursive: true });
    writeFileSync(path.join(rootDir, "notes", "first.md"), "# First note\n");
    git(rootDir, "add", "notes");
    git(rootDir, "commit", "-qm", "add note sources");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "kind-fence-center",
      now: () => "2026-09-09T03:00:00.000Z",
    });
    const declaration = async () => await cell!.read("repo.vertical.declaration.read", {}, binding),
      fenceOf = async (kindRef: string) => {
        const row = (await declaration()).declaration.entityKinds.find(
          (candidate: Record<string, unknown>) =>
            candidate.entityType === "artifact" && `entity-kind/${String(candidate.kindId)}` === kindRef,
        ) as { readonly revision?: number } | undefined;
        assert.ok(row, `declaration has no row for ${kindRef}`);
        return Number(row.revision);
      },
      create = async (body: Record<string, unknown>) => {
        const receipt = await cell!.run(
          { kind: "vertical-kind-upsert", kindId: String(body.id), expectedVersion: 0, declaration: body },
          binding,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        return (JSON.parse(String(receipt.evidence)) as { kindRef: string }).kindRef;
      },
      rename = (kindRef: string, body: Record<string, unknown>, singular: string, expectedVersion: number) =>
        cell!.run(
          {
            kind: "vertical-kind-upsert",
            kindId: kindRef,
            expectedVersion,
            declaration: {
              ...body,
              kindId: kindRef.slice("entity-kind/".length),
              display: { singular, plural: `${singular}s` },
              attributes: undefined,
            },
          },
          binding,
        );

    const noteRef = await create(fieldNote),
      logRef = await create(siteLog),
      // Both fences are read here, before either Kind is written.
      noteFence = await fenceOf(noteRef),
      logFence = await fenceOf(logRef);

    // 1. Writing the field note must not move the site log's fence.
    const renamedNote = await rename(noteRef, fieldNote, "Field Report", noteFence);
    assert.equal(renamedNote.outcome, "applied", JSON.stringify(renamedNote));
    assert.equal(await fenceOf(logRef), logFence, "one Kind's acceptance must not restate another Kind's revision");
    const renamedLog = await rename(logRef, siteLog, "Site Report", logFence);
    assert.equal(
      renamedLog.outcome,
      "applied",
      `a fence read before an unrelated Kind changed must still apply: ${JSON.stringify(renamedLog)}`,
    );

    // 2. Two writes to the SAME Kind collide: the second presents a fence that has moved.
    const stale = await rename(logRef, siteLog, "Site Journal", logFence);
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "revision_conflict", JSON.stringify(stale));

    // 3. An instance exists under the accepted Kind.
    const imported = await cell.run(
      {
        kind: "entity-import",
        entityKind: noteRef,
        locator: "notes/first.md",
        expectedVersion: 0,
        attributes: { summary: "first" },
      },
      binding,
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const importedId = (JSON.parse(String(imported.evidence)) as { preview: { entityId: string } }).preview.entityId;

    // 4. A stale worktree copy of the install seed must not be able to un-declare an accepted Kind.
    const materialized = path.join(rootDir, "harness", "vertical.json"),
      draft = `${JSON.stringify(
        {
          schema: "repository-vertical-declaration/v1",
          revision: 1,
          definition: JSON.parse(readFileSync(path.join(defaultAssets, "vertical.json"), "utf8")),
        },
        null,
        2,
      )}\n`;
    writeFileSync(materialized, draft);
    const staleRead = await declaration();
    assert.ok(
      staleRead.declaration.entityKinds.some(
        (candidate: Record<string, unknown>) => `entity-kind/${String(candidate.kindId)}` === noteRef,
      ),
      "a stale materialized vertical.json must not drop an accepted Kind from the declaration read",
    );
    assert.ok(
      (await cell.read("repo.entity.rows.read", {}, binding)).rows.some(
        (row: { readonly ref: string }) => row.ref === `${noteRef}/${importedId}`,
      ),
      "a stale materialized vertical.json must not hide instances of an accepted Kind",
    );
    assert.equal(
      readFileSync(materialized, "utf8"),
      draft,
      "reading canonical Kind state must leave an unaccepted local draft exactly as its author left it",
    );

    // 5. With no worktree copy at all, the accepted Kind stays readable, mutable and un-re-migrated.
    rmSync(materialized, { force: true });
    assert.ok(
      (await declaration()).declaration.entityKinds.some(
        (candidate: Record<string, unknown>) => `entity-kind/${String(candidate.kindId)}` === logRef,
      ),
      "an absent materialized vertical.json must not drop an accepted Kind",
    );
    const remigrate = await cell.run({ kind: "vertical-declaration-migrate" }, binding);
    assert.equal(
      remigrate.outcome,
      "no_changes",
      `an absent worktree copy must not silently re-seed the install package: ${JSON.stringify(remigrate)}`,
    );
    const archived = await cell.run(
      { kind: "vertical-kind-retire", kindId: logRef, expectedVersion: await fenceOf(logRef), reason: "Field trial." },
      binding,
    );
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
