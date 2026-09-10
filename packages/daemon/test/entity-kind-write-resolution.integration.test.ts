// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-kind-write-resolution" },
        executor: { kind: "agent" as const, id: "kind-write-resolution-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  // A runtime-declared Kind, not one of the bundled Research/ADR rows: the resolution under test must
  // hold for any declaration the center has accepted.
  releaseRunbook = {
    id: "release-runbook",
    entityType: "artifact",
    idPrefix: "RLB",
    display: { singular: "Release Runbook", plural: "Release Runbooks" },
    descriptorSchemaRef: "schema://artifact-descriptor",
    store: { pathTemplate: "entities/release-runbooks/{id}.json" },
    locatorKinds: ["repository-path"],
    attributes: { summary: { type: "string", required: true } },
  };

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

/**
 * The write surface addresses a Kind the same three ways the read surface does — stable ref, bare
 * kindId, qualified name — and the canonical event always records the stable ref, so two spellings of
 * one intent are one operation. An undeclared Kind is refused as undeclared; a declared Kind that
 * refuses the command (an archived one) keeps the executable-action refusal.
 */
test("entity import/update/archive/delete resolve kind display ids to the same operations as stable refs", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kind-write-resolution-")),
    repoId = workspaceId("kind-write-resolution");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "runbooks"), { recursive: true });
    writeFileSync(path.join(rootDir, "runbooks", "first.md"), "# First runbook\n");
    writeFileSync(path.join(rootDir, "runbooks", "second.md"), "# Second runbook\n");
    git(rootDir, "add", "runbooks");
    git(rootDir, "commit", "-qm", "add runbook sources");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "kind-write-resolution-center",
      now: () => "2026-09-10T02:00:00.000Z",
    });
    const events = makeTaskEventReader({ repoId, rootDir }),
      kindFence = async (kindRef: string) => {
        const row = (await cell!.read("repo.vertical.declaration.read", {}, binding)).declaration.entityKinds.find(
          (candidate: Record<string, unknown>) =>
            candidate.entityType === "artifact" && `entity-kind/${String(candidate.kindId)}` === kindRef,
        ) as { readonly revision?: number } | undefined;
        assert.ok(row, `declaration has no row for ${kindRef}`);
        return Number(row.revision);
      };

    // 1. Declare the Kind; the center mints its stable opaque identity.
    const created = await cell.run(
      { kind: "vertical-kind-upsert", kindId: "release-runbook", expectedVersion: 0, declaration: releaseRunbook },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const kindRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;
    assert.match(kindRef, /^entity-kind\/KND-[0-9a-f]{32}$/u);

    // 2. Import by qualified name; the accepted event still speaks the stable ref, so reads by any
    // spelling find the instance the write created.
    const firstImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: "release-runbook",
        locator: "runbooks/first.md",
        expectedVersion: 0,
        attributes: { summary: "first" },
      },
      binding,
    );
    assert.equal(firstImport.outcome, "applied", JSON.stringify(firstImport));
    const entityId = (JSON.parse(String(firstImport.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.match(entityId, /^RLB-[a-f0-9]{32}$/u);
    assert.equal(
      events.read().events.find((event) => event.opId === firstImport.opId)?.payload.entityKind,
      kindRef,
      "an import stated with the qualified name must record the stable ref",
    );

    // 3. The same import stated with the stable ref replays: both spellings are one operation.
    const replayedImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef,
        locator: "runbooks/first.md",
        expectedVersion: 0,
        attributes: { summary: "first" },
      },
      binding,
    );
    assert.equal(replayedImport.outcome, "no_changes", JSON.stringify(replayedImport));
    assert.equal(replayedImport.opId, firstImport.opId);

    // 4. The bare kindId is the third accepted spelling.
    const secondImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: kindRef.slice("entity-kind/".length),
        locator: "runbooks/second.md",
        expectedVersion: 0,
        attributes: { summary: "second" },
      },
      binding,
    );
    assert.equal(secondImport.outcome, "applied", JSON.stringify(secondImport));
    const secondId = (JSON.parse(String(secondImport.evidence)) as { preview: { entityId: string } }).preview.entityId;

    // 5. Update by qualified name, then the identical intent by stable ref: one opId, a replay.
    const updated = await cell.run(
      {
        kind: "entity-update",
        entityKind: "release-runbook",
        entityId,
        expectedVersion: firstImport.revision,
        title: "First runbook, revised",
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const replayedUpdate = await cell.run(
      {
        kind: "entity-update",
        entityKind: kindRef,
        entityId,
        expectedVersion: firstImport.revision,
        title: "First runbook, revised",
      },
      binding,
    );
    assert.equal(replayedUpdate.outcome, "no_changes", JSON.stringify(replayedUpdate));
    assert.equal(replayedUpdate.opId, updated.opId);
    assert.equal(
      events.read().events.find((event) => event.opId === updated.opId)?.payload.entityKind,
      kindRef,
      "an update stated with the qualified name must record the stable ref",
    );
    const retitled = await cell.run({ kind: "entity-get", entityKind: kindRef, entityId }, binding);
    assert.equal(
      (JSON.parse(String(retitled.evidence)) as { entity: { value: { title?: string } } }).entity.value.title,
      "First runbook, revised",
    );

    // 6. An undeclared Kind is refused as undeclared, on both the import and the mutation surface.
    for (const unknown of [
      { kind: "entity-import", locator: "runbooks/first.md", expectedVersion: 0, attributes: { summary: "first" } },
      { kind: "entity-update", entityId, expectedVersion: updated.revision, title: "no such kind" },
    ] as const) {
      const refused = await cell.run({ ...unknown, entityKind: "no-such-runbook" }, binding);
      assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
      assert.equal(refused.code, "entity_kind_not_found", JSON.stringify(refused));
    }

    // 7. Archiving the Kind leaves it declared but closes import: the refusal names the missing
    // executable action, not a Kind that cannot be found.
    const retired = await cell.run(
      {
        kind: "vertical-kind-retire",
        kindId: kindRef,
        expectedVersion: await kindFence(kindRef),
        reason: "Runbooks moved to the release pipeline.",
      },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const archivedImport = await cell.run(
      {
        kind: "entity-import",
        entityKind: "release-runbook",
        locator: "runbooks/first.md",
        expectedVersion: updated.revision,
        attributes: { summary: "first" },
      },
      binding,
    );
    assert.equal(archivedImport.outcome, "op_rejected", JSON.stringify(archivedImport));
    assert.equal(archivedImport.code, "unsupported_command", JSON.stringify(archivedImport));

    // 8. The material already inside stays manageable by qualified name: archive, then delete retires
    // the instance's declaration from the worktree.
    const archived = await cell.run(
      {
        kind: "entity-archive",
        entityKind: "release-runbook",
        entityId,
        expectedVersion: updated.revision,
        reason: "Superseded by the pipeline runbook.",
      },
      binding,
    );
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    const deleted = await cell.run(
      {
        kind: "entity-delete",
        entityKind: "release-runbook",
        entityId: secondId,
        expectedVersion: secondImport.revision,
        reason: "Folded into the primary runbook.",
      },
      binding,
    );
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    await waitForFixturePublication(cell, deleted.opId, binding);
    const deleteEvent = events.read().events.find((event) => event.opId === deleted.opId) as unknown as {
      payload: { entityKind: string; ownedContent: { retirements: readonly { path: string }[] } };
    };
    assert.equal(deleteEvent.payload.entityKind, kindRef);
    assert.ok(
      deleteEvent.payload.ownedContent.retirements.some(
        ({ path: gone }) => gone === `entities/release-runbooks/${secondId}.json`,
      ),
      "delete must retire the declaration document of the instance addressed by qualified name",
    );
    assert.equal(existsSync(path.join(rootDir, "harness", "entities", "release-runbooks", `${secondId}.json`)), false);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
