// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveArtifactContentVersion, makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const kind = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
  researchKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
  binding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-artifact-import" },
        executor: { kind: "agent" as const, id: "artifact-edge" },
      },
      source: "local" as const,
    },
    "repo-write",
  ),
  secondaryNodeBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-artifact-import-secondary" },
        executor: { kind: "agent" as const, id: "artifact-edge-secondary" },
      },
      source: "local" as const,
    },
    "repo-write",
  );

test("Artifact import is dry-run safe, edge-idempotent, fenced, and cold-rebuildable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-import-")),
    sourcePath = "docs/adr-0001.md",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("artifact-import");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.dirname(absoluteSource), { recursive: true });
    writeFileSync(absoluteSource, "# Adopt the event ledger\n\nFirst observation.\n");
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add artifact source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-import-center",
      now: () => "2026-09-02T02:00:00.000Z",
    });
    const explained = await cell.read(
      "repo.entity.actions.explain",
      { schema: "entity-action-explain-request/v1", mode: "catalog", entityKind: kind, refs: [] },
      binding,
    );
    assert.deepEqual(
      explained.subjects[0]?.actions.map(({ action }) => action.id),
      ["import", "update", "delete", "archive", "distill-candidate"],
    );
    assert.equal(explained.subjects[0]?.actions[0]?.available, null);

    const observer = makeTaskEventReader({ repoId, rootDir }),
      beforeEvents = observer.read().events.length,
      beforeStatus = git(rootDir, "status", "--porcelain=v1"),
      request = { kind: "entity-import", entityKind: kind, locator: sourcePath, expectedVersion: 0 },
      previewReceipt = await cell.run({ ...request, dryRun: true }, binding);
    assert.equal(previewReceipt.outcome, "pending", JSON.stringify(previewReceipt));
    const preview = JSON.parse(String(previewReceipt.evidence)) as {
      entityId: string | null;
      candidateContentVersion: string;
      artifactOwner: string | null;
      operationId: string;
    };
    assert.equal(observer.read().events.length, beforeEvents, "dry-run must not append an event");
    assert.equal(git(rootDir, "status", "--porcelain=v1"), beforeStatus, "dry-run must not touch the worktree");
    // A dry run of never-accepted material has no identity to report: minting happens on acceptance, so a
    // preview that named an id would be predicting one no event will ever carry.
    assert.equal(preview.entityId, null);
    assert.equal(preview.artifactOwner, null);
    assert.match(preview.candidateContentVersion, /^sha256:[a-f0-9]{64}$/u);

    const first = await cell.run(request, binding),
      replay = await cell.run(request, secondaryNodeBinding),
      entityId = (JSON.parse(String(first.evidence)) as { preview: { entityId: string } }).preview.entityId;
    assert.match(entityId, /^ADR-[a-f0-9]{32}$/u);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(replay.outcome, "no_changes", JSON.stringify(replay));
    assert.equal(first.opId, replay.opId);
    assert.equal(first.opId, preview.operationId);
    assert.equal(first.revision, beforeEvents + 1, "the first node advances the ledger by one revision");
    assert.equal(replay.revision, first.revision, "the second node reuses that observation revision");
    assert.equal(
      (JSON.parse(String(replay.evidence)) as { sameResult: boolean }).sameResult,
      true,
      "the second edge must receive the original same-result operation",
    );

    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-distill", title: "Distill artifact" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-distill-secondary", title: "Distill artifact" }, binding))
        .outcome,
      "applied",
    );
    const candidateCut = observer.read().revision;
    const entityRef = `${kind}/${entityId}`,
      firstCandidateReceipt = await cell.run({ kind: "distill-candidate", taskId: "task-distill", entityRef }, binding),
      firstCandidateReport = JSON.parse(String(firstCandidateReceipt.evidence)) as { candidatePath: string },
      firstCandidate = JSON.parse(
        readFileSync(path.join(rootDir, firstCandidateReport.candidatePath), "utf8"),
      ) as Record<string, unknown>,
      secondCandidate = firstCandidate;
    const { candidateId: _firstId, createdAt: _firstCreated, taskId: _firstTask, ...firstStable } = firstCandidate,
      { candidateId: _secondId, createdAt: _secondCreated, taskId: _secondTask, ...secondStable } = secondCandidate;
    assert.deepEqual(firstStable, secondStable);
    assert.deepEqual(firstStable.subject, {
      kind: "artifact-entity",
      ref: entityRef,
      title: "Adopt the event ledger",
      locator: { kind: "repository-path", value: sourcePath },
      contentVersion: preview.candidateContentVersion,
      source: `repo:${repoId}:${sourcePath}`,
      edges: [],
      projectionCut: {
        watermark: candidateCut,
        sourceRevision: candidateCut,
      },
    });

    const absent = await cell.run(
      { kind: "distill-candidate", taskId: "task-distill", entityRef: `${kind}/ADR-0000000000000000` },
      binding,
    );
    assert.equal(absent.outcome, "op_rejected", JSON.stringify(absent));
    assert.equal(absent.code, "invalid_command");

    writeFileSync(absoluteSource, "# Adopt the event ledger\n\nSecond observation.\n");
    const stale = await cell.run(request, binding);
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "revision_conflict");
    const updated = await cell.run({ ...request, expectedVersion: first.revision }, binding),
      updatedEvidence = JSON.parse(String(updated.evidence)) as {
        preview: { entityId: string; candidateContentVersion: string };
      };
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    assert.equal(updatedEvidence.preview.entityId, entityId);
    assert.notEqual(updatedEvidence.preview.candidateContentVersion, preview.candidateContentVersion);

    rmSync(absoluteSource);
    const missing = await cell.run({ ...request, expectedVersion: updated.revision }, binding);
    assert.equal(missing.outcome, "applied", JSON.stringify(missing));
    const missingReplay = await cell.run(
      { kind: "receipt-show", opId: missing.opId, waitFor: ["worktree_visible"], timeoutMs: 5_000 },
      binding,
    );
    assert.equal(
      (JSON.parse(String(missingReplay.evidence)) as { eventType: string }).eventType,
      "entity_target_missing",
    );
    assert.equal(missingReplay.proof?.worktreeVisible, true);
    assert.equal(existsSync(absoluteSource), false, "publishing the descriptor must not recreate the missing source");
    const descriptorUpdate = await cell.run(
      {
        kind: "entity-update",
        entityKind: kind,
        entityId: entityId,
        expectedVersion: missing.revision,
        title: "Revised title",
        locator: sourcePath,
        contentVersion: "revision:manual-2",
      },
      secondaryNodeBinding,
    );
    assert.equal(descriptorUpdate.outcome, "applied", JSON.stringify(descriptorUpdate));
    // Regression (task_d7058b77): an update that leaves contentVersion untouched must not collide with the
    // entity-import-* operation that first observed that content.
    const titleOnlyUpdate = await cell.run(
      {
        kind: "entity-update",
        entityKind: kind,
        entityId: entityId,
        expectedVersion: descriptorUpdate.revision,
        title: "Revised title again",
      },
      binding,
    );
    assert.equal(titleOnlyUpdate.outcome, "applied", JSON.stringify(titleOnlyUpdate));
    assert.notEqual(titleOnlyUpdate.opId, descriptorUpdate.opId);
    assert.match(String(titleOnlyUpdate.opId), /^entity-update-/u);
    // A retry that presents the same fence replays the applied update instead of revision_conflict.
    const titleOnlyRetry = await cell.run(
      {
        kind: "entity-update",
        entityKind: kind,
        entityId: entityId,
        expectedVersion: descriptorUpdate.revision,
        title: "Revised title again",
      },
      binding,
    );
    assert.equal(titleOnlyRetry.outcome, "no_changes", JSON.stringify(titleOnlyRetry));
    assert.equal(titleOnlyRetry.opId, titleOnlyUpdate.opId);
    assert.equal(titleOnlyRetry.revision, titleOnlyUpdate.revision);
    const archived = await cell.run(
      {
        kind: "entity-archive",
        entityKind: kind,
        entityId: entityId,
        expectedVersion: titleOnlyUpdate.revision,
        reason: "Superseded by ADR-0002",
      },
      binding,
    );
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    const archiveRetry = await cell.run(
      {
        kind: "entity-archive",
        entityKind: kind,
        entityId: entityId,
        expectedVersion: titleOnlyUpdate.revision,
        reason: "Superseded by ADR-0002",
      },
      binding,
    );
    assert.equal(archiveRetry.outcome, "no_changes", JSON.stringify(archiveRetry));
    assert.equal(archiveRetry.opId, archived.opId);
    const artifactEvents = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.filter((event) => event.schema === "entity-event/v1" && event.payload.entityKind === kind);
    assert.deepEqual(
      artifactEvents.map(({ type }) => type),
      [
        "entity_content_observed",
        "entity_content_observed",
        "entity_target_missing",
        "entity_updated",
        "entity_updated",
        "entity_archived",
      ],
    );

    const listed = await cell.run({ kind: "entity-list", entityKind: kind }, binding),
      shortListed = await cell.run({ kind: "entity-list", entityKind: "architecture-decision-record" }, binding),
      shortGet = await cell.run(
        { kind: "entity-get", entityKind: "architecture-decision-record", entityId: entityId },
        binding,
      ),
      listedEntities = (
        JSON.parse(String(listed.evidence)) as {
          entities: readonly { id: string; freshness: string; currentVersion: string | number | null }[];
        }
      ).entities,
      shortListEvidence = JSON.parse(String(shortListed.evidence)) as {
        kind: string;
        entities: readonly { id: string; freshness: string; currentVersion: string | number | null }[];
      },
      shortGetEvidence = JSON.parse(String(shortGet.evidence)) as {
        kind: string;
        entity: { id: string };
      };
    assert.equal(shortListed.outcome, "applied", JSON.stringify(shortListed));
    assert.equal(shortGet.outcome, "applied", JSON.stringify(shortGet));
    assert.equal(shortListEvidence.kind, kind);
    assert.equal(shortGetEvidence.kind, kind);
    assert.deepEqual(shortListEvidence.entities, listedEntities);
    assert.equal(shortGetEvidence.entity.id, entityId);
    assert.deepEqual(
      listedEntities.map(({ id }) => id),
      [entityId],
    );
    assert.equal(listedEntities[0]?.freshness, "orphaned");
    assert.equal(listedEntities[0]?.currentVersion, null);
    await cell.close();
    cell = undefined;

    const rebuildStore = makeTaskEventReader({ repoId, rootDir }),
      rebuilt = makeTaskProjection({ rootDir, eventStore: rebuildStore, now: () => "2026-09-02T02:01:00.000Z" });
    try {
      const receipt = rebuilt.rebuild(),
        row = rebuilt.getEntity(kind, entityId);
      assert.equal(receipt.watermark, rebuildStore.readHead()?.revision);
      assert.equal(row?.id, entityId);
      assert.equal(row?.workspaceRevision, archived.revision);
      assert.equal(row?.value.contentVersion, "revision:manual-2");
      assert.equal(row?.value.title, "Revised title again");
      assert.equal(row?.freshness, "orphaned");
      assert.equal(row?.currentVersion, null);
    } finally {
      rebuilt.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("URL source resolution does not block a concurrent repository write", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-url-artifact-import-")),
    repoId = workspaceId("url-artifact-import");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const server = createServer(() => {});
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "url-artifact-import-center",
      now: () => "2026-09-11T02:00:00.000Z",
    });
    const created = await cell.run(
      {
        kind: "vertical-kind-upsert",
        kindId: "remote-note",
        expectedVersion: 0,
        declaration: {
          id: "remote-note",
          entityType: "artifact",
          idPrefix: "RN",
          display: { singular: "Remote Note", plural: "Remote Notes" },
          descriptorSchemaRef: "schema://artifact-descriptor",
          store: { pathTemplate: "entities/remote-notes/{id}.json" },
          locatorKinds: ["url"],
        },
      },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const kindRef = (JSON.parse(String(created.evidence)) as { kindRef: string }).kindRef;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${String(address.port)}/hanging.md`;
    const importing = cell.run(
      { kind: "entity-import", entityKind: kindRef, locator: url, expectedVersion: 0 },
      binding,
    );
    const started = Date.now();
    const write = await Promise.race([
      cell.run({ kind: "task-create", taskId: "url-import-concurrent-write", title: "Concurrent write" }, binding),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("concurrent write exceeded 2 seconds")), 2_000),
      ),
    ]);
    assert.equal(write.outcome, "applied", JSON.stringify(write));
    assert.ok(Date.now() - started < 2_000);
    const imported = await importing;
    assert.equal(imported.outcome, "op_rejected", JSON.stringify(imported));
    assert.equal(imported.code, "source_resolution_timeout", JSON.stringify(imported));
  } finally {
    await cell?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Directory artifact import fingerprints files, replays unchanged content, and records missing", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-directory-artifact-import-")),
    sourcePath = "research/2026-09-05-directory-artifacts",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("directory-artifact-import");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "notes"), { recursive: true });
    const readmeContent = "# Directory artifacts\n\nResearch summary.\n",
      evidenceContent = "<p>first observation</p>\n";
    writeFileSync(path.join(absoluteSource, "README.md"), readmeContent);
    writeFileSync(path.join(absoluteSource, "Z-evidence.html"), evidenceContent);
    writeFileSync(path.join(absoluteSource, "notes", "a.md"), "supporting note\n");
    writeFileSync(path.join(absoluteSource, ".DS_Store"), "ignored metadata\n");
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add directory artifact source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "directory-artifact-import-center",
      now: () => "2026-09-05T02:00:00.000Z",
    });

    const request = { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
      first = await cell.run(request, binding),
      replay = await cell.run(request, secondaryNodeBinding),
      firstPreview = (
        JSON.parse(String(first.evidence)) as {
          preview: { entityId: string; candidateContentVersion: string };
        }
      ).preview;
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(replay.outcome, "no_changes", JSON.stringify(replay));
    assert.equal(replay.opId, first.opId);
    assert.match(firstPreview.entityId, /^RES-[a-f0-9]{32}$/u);

    const manifest = [
      `${sha256(readmeContent)}  "README.md"`,
      `${sha256(evidenceContent)}  "Z-evidence.html"`,
      `${sha256("supporting note\n")}  "notes/a.md"`,
    ].join("\n");
    assert.equal(
      firstPreview.candidateContentVersion,
      deriveArtifactContentVersion({ kind: "content", content: manifest }),
    );
    const listed = await cell.run({ kind: "entity-list", entityKind: researchKind }, binding),
      shortListed = await cell.run({ kind: "entity-list", entityKind: "research" }, binding),
      shortGet = await cell.run(
        { kind: "entity-get", entityKind: "research", entityId: firstPreview.entityId },
        binding,
      ),
      listedEvidence = JSON.parse(String(listed.evidence)) as {
        kind: string;
        entities: readonly {
          id: string;
          value: { title: string };
          currentVersion: string | number | null;
        }[];
      },
      shortListEvidence = JSON.parse(String(shortListed.evidence)) as typeof listedEvidence,
      shortGetEvidence = JSON.parse(String(shortGet.evidence)) as {
        kind: string;
        entity: { id: string };
      },
      entity = listedEvidence.entities[0];
    assert.equal(shortListed.outcome, "applied", JSON.stringify(shortListed));
    assert.equal(shortGet.outcome, "applied", JSON.stringify(shortGet));
    assert.equal(shortListEvidence.kind, researchKind);
    assert.equal(shortGetEvidence.kind, researchKind);
    assert.deepEqual(shortListEvidence.entities, listedEvidence.entities);
    assert.equal(shortGetEvidence.entity.id, firstPreview.entityId);
    assert.equal(entity?.value.title, "Directory artifacts");
    assert.equal(entity?.currentVersion, firstPreview.candidateContentVersion);

    writeFileSync(path.join(absoluteSource, ".DS_Store"), "changed ignored metadata\n");
    const systemFileOnly = await cell.run(request, binding);
    assert.equal(systemFileOnly.outcome, "no_changes", JSON.stringify(systemFileOnly));
    assert.equal(systemFileOnly.opId, first.opId);

    writeFileSync(path.join(absoluteSource, "Z-evidence.html"), "<p>second observation</p>\n");
    const updated = await cell.run({ ...request, expectedVersion: first.revision }, binding),
      updatedPreview = (
        JSON.parse(String(updated.evidence)) as {
          preview: { candidateContentVersion: string };
        }
      ).preview;
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    assert.notEqual(updatedPreview.candidateContentVersion, firstPreview.candidateContentVersion);

    const fallbackPath = "research/no-readme-package",
      fallbackSource = path.join(rootDir, fallbackPath);
    mkdirSync(fallbackSource, { recursive: true });
    writeFileSync(path.join(fallbackSource, "notes.md"), "No heading.\n");
    const fallback = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: fallbackPath, expectedVersion: 0 },
        binding,
      ),
      fallbackList = await cell.run({ kind: "entity-list", entityKind: researchKind }, binding),
      fallbackEntity = (
        JSON.parse(String(fallbackList.evidence)) as {
          entities: readonly { value: { title: string; locator: { value: string } } }[];
        }
      ).entities.find(({ value }) => value.locator.value === fallbackPath);
    assert.equal(fallback.outcome, "applied", JSON.stringify(fallback));
    assert.equal(fallbackEntity?.value.title, "no-readme-package");

    rmSync(absoluteSource, { recursive: true });
    const missing = await cell.run({ ...request, expectedVersion: updated.revision }, binding),
      missingReceipt = await cell.run({ kind: "receipt-show", opId: missing.opId }, binding);
    assert.equal(missing.outcome, "applied", JSON.stringify(missing));
    assert.equal(
      (JSON.parse(String(missingReceipt.evidence)) as { eventType: string }).eventType,
      "entity_target_missing",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Artifact import publishes original bytes to Git and the worktree independently of the source", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-binary-artifact-import-")),
    sourcePath = "evidence/raw.pdf",
    absoluteSource = path.join(rootDir, sourcePath),
    unrelatedPath = "notes/scratch.md",
    repoId = workspaceId("binary-artifact-import"),
    // NUL and 0xFF are the point: a byte sequence no UTF-8 decode round-trips.
    bytes = Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0, 255, 10, 128, 1]), Buffer.from("\n%%EOF\n")]);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.dirname(absoluteSource), { recursive: true });
    mkdirSync(path.join(rootDir, path.dirname(unrelatedPath)), { recursive: true });
    writeFileSync(absoluteSource, bytes);
    writeFileSync(path.join(rootDir, unrelatedPath), "committed line\n");
    git(rootDir, "add", sourcePath, unrelatedPath);
    git(rootDir, "commit", "-qm", "add binary artifact source");
    writeFileSync(path.join(rootDir, unrelatedPath), "uncommitted edit nobody asked to publish\n");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "binary-artifact-import-center",
      now: () => "2026-09-09T02:00:00.000Z",
    });

    const receipt = await cell.run(
        { kind: "entity-import", entityKind: researchKind, locator: sourcePath, expectedVersion: 0 },
        binding,
      ),
      entityId = (JSON.parse(String(receipt.evidence)) as { preview: { entityId: string } }).preview.entityId,
      ownedPath = `entities/research/${entityId}/raw.pdf`;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));

    const store = makeTaskEventReader({ repoId, rootDir }),
      observed = store.read().events.find((event) => event.opId === receipt.opId) as unknown as {
        payload: {
          ownedContent: {
            content: readonly { sha256: string; byteLength: number }[];
            bindings: readonly { path: string }[];
          };
        };
      };
    const owned = observed.payload.ownedContent.content.find(({ byteLength }) => byteLength === bytes.byteLength);
    assert.ok(owned, "the accepted event must own a content object the size of the source");
    assert.deepEqual(Buffer.from(store.readContentBlob(owned.sha256) ?? []), bytes);
    assert.ok(
      observed.payload.ownedContent.bindings.some(({ path: bound }) => bound === ownedPath),
      `owned content must bind under the entity, saw ${JSON.stringify(observed.payload.ownedContent.bindings)}`,
    );

    // Everything below reads only what the center published, so a passing assertion cannot be the source file.
    rmSync(absoluteSource);
    await waitForFixturePublication(cell, receipt.opId, binding);
    assert.deepEqual(
      execFileSync("git", ["-C", rootDir, "show", `HEAD:harness/${ownedPath}`], { maxBuffer: 1 << 24 }),
      bytes,
      "Git read-back must retain NUL and invalid UTF-8 bytes",
    );
    assert.deepEqual(
      readFileSync(path.join(rootDir, "harness", ownedPath)),
      bytes,
      "materialization must write the owned snapshot byte for byte",
    );
    assert.equal(existsSync(absoluteSource), false, "publishing must not recreate the external source");
    assert.equal(
      readFileSync(path.join(rootDir, unrelatedPath), "utf8"),
      "uncommitted edit nobody asked to publish\n",
      "publication must settle only what this event owns",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Artifact import owns empty and non-text files across a directory source", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-directory-binary-import-")),
    sourcePath = "research/binary-package",
    absoluteSource = path.join(rootDir, sourcePath),
    repoId = workspaceId("directory-binary-import"),
    latin1 = Buffer.from([0xc0, 0xc1, 0xf5, 0xff]),
    duplicate = Buffer.from("identical bytes\n");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(absoluteSource, "nested"), { recursive: true });
    writeFileSync(path.join(absoluteSource, "invalid.bin"), latin1);
    writeFileSync(path.join(absoluteSource, "zero.bin"), Buffer.alloc(0));
    writeFileSync(path.join(absoluteSource, "one.txt"), duplicate);
    writeFileSync(path.join(absoluteSource, "nested", "two.txt"), duplicate);
    git(rootDir, "add", sourcePath);
    git(rootDir, "commit", "-qm", "add binary directory source");
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "directory-binary-import-center",
      now: () => "2026-09-09T03:00:00.000Z",
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

    assert.deepEqual(readFileSync(path.join(rootDir, "harness", root, "invalid.bin")), latin1);
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", root, "zero.bin")), Buffer.alloc(0));
    // Same bytes at two paths: one content object, two bindings, neither overwriting the other.
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", root, "one.txt")), duplicate);
    assert.deepEqual(readFileSync(path.join(rootDir, "harness", root, "nested/two.txt")), duplicate);

    const store = makeTaskEventReader({ repoId, rootDir }),
      manifest = (
        store.read().events.find((event) => event.opId === receipt.opId) as unknown as {
          payload: {
            ownedContent: {
              content: readonly { sha256: string; byteLength: number }[];
              bindings: readonly { path: string }[];
            };
          };
        }
      ).payload.ownedContent;
    assert.equal(
      manifest.content.filter(({ sha256: digest }) => digest === sha256("identical bytes\n")).length,
      1,
      "identical bytes must be stored once",
    );
    assert.deepEqual(
      manifest.bindings.map(({ path: bound }) => bound).filter((bound) => bound.startsWith(`${root}/`)),
      [`${root}/invalid.bin`, `${root}/nested/two.txt`, `${root}/one.txt`, `${root}/zero.bin`],
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
