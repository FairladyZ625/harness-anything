// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveArtifactContentVersion, makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const kind = "software/coding/architecture-decision-record@1",
  researchKind = "software/coding/research@1",
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
      ["import", "update", "archive", "distill-candidate"],
    );
    assert.equal(explained.subjects[0]?.actions[0]?.available, null);

    const observer = makeTaskEventReader({ repoId, rootDir }),
      beforeEvents = observer.read().events.length,
      beforeStatus = git(rootDir, "status", "--porcelain=v1"),
      request = { kind: "entity-import", entityKind: kind, locator: sourcePath, expectedVersion: 0 },
      previewReceipt = await cell.run({ ...request, dryRun: true }, binding);
    assert.equal(previewReceipt.outcome, "pending", JSON.stringify(previewReceipt));
    const preview = JSON.parse(String(previewReceipt.evidence)) as {
      entityId: string;
      candidateContentVersion: string;
      artifactOwner: string;
      operationId: string;
    };
    assert.equal(observer.read().events.length, beforeEvents, "dry-run must not append an event");
    assert.equal(git(rootDir, "status", "--porcelain=v1"), beforeStatus, "dry-run must not touch the worktree");
    assert.match(preview.entityId, /^ADR-[a-f0-9]{16}$/u);
    assert.match(preview.candidateContentVersion, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(preview.artifactOwner, `entity/${preview.entityId}/revision/${beforeEvents + 1}`);

    const first = await cell.run(request, binding),
      replay = await cell.run(request, secondaryNodeBinding);
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
    const entityRef = `${kind}/${preview.entityId}`,
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
        watermark: firstCandidateReceipt.revision,
        sourceRevision: firstCandidateReceipt.revision,
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
    assert.equal(updatedEvidence.preview.entityId, preview.entityId);
    assert.notEqual(updatedEvidence.preview.candidateContentVersion, preview.candidateContentVersion);

    rmSync(absoluteSource);
    const missing = await cell.run({ ...request, expectedVersion: updated.revision }, binding);
    assert.equal(missing.outcome, "applied", JSON.stringify(missing));
    const missingReplay = await cell.run({ kind: "receipt-show", opId: missing.opId }, binding);
    assert.equal(
      (JSON.parse(String(missingReplay.evidence)) as { eventType: string }).eventType,
      "entity_target_missing",
    );
    assert.equal(missingReplay.proof?.worktreeVisible, false);
    const descriptorUpdate = await cell.run(
      {
        kind: "entity-update",
        entityKind: kind,
        entityId: preview.entityId,
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
        entityId: preview.entityId,
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
        entityId: preview.entityId,
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
        entityId: preview.entityId,
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
        entityId: preview.entityId,
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
      listedEntities = (
        JSON.parse(String(listed.evidence)) as {
          entities: readonly { id: string; freshness: string; currentVersion: string | number | null }[];
        }
      ).entities;
    assert.deepEqual(
      listedEntities.map(({ id }) => id),
      [preview.entityId],
    );
    assert.equal(listedEntities[0]?.freshness, "orphaned");
    assert.equal(listedEntities[0]?.currentVersion, null);
    await cell.close();
    cell = undefined;

    const rebuildStore = makeTaskEventReader({ repoId, rootDir }),
      rebuilt = makeTaskProjection({ rootDir, eventStore: rebuildStore, now: () => "2026-09-02T02:01:00.000Z" });
    try {
      const receipt = rebuilt.rebuild(),
        row = rebuilt.getEntity(kind, preview.entityId);
      assert.equal(receipt.watermark, rebuildStore.readHead()?.revision);
      assert.equal(row?.id, preview.entityId);
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
    assert.match(firstPreview.entityId, /^RES-[a-f0-9]{16}$/u);

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
      entity = (
        JSON.parse(String(listed.evidence)) as {
          entities: readonly {
            id: string;
            value: { title: string };
            currentVersion: string | number | null;
          }[];
        }
      ).entities[0];
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

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
