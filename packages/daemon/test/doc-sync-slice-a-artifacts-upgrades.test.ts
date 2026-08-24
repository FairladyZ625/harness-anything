// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyTextualArtifactPath,
  compileTaskLifecycleWrite,
  makeTaskEventStore,
  makeTaskProjection,
  reduceTaskEvent,
  rebuildTaskProjection,
  serializeCanonicalEvent,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import {
  DOC_POLICY_ID,
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  sha256Text,
  type CanonicalWriteBundle,
  type MigrationImportEventV1,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { readDocReceipt, runDocAction } from "../src/doc-sync-actions.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  blockedReason,
  git,
  initRepo,
  materializeReport,
  opaqueTextualMediaType,
  rows,
  standardMigration,
  write,
} from "./doc-sync-slice-a.fixtures.ts";
test("artifact add is the untracked UTF-8 canonical subset of doc submit", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-equivalence-")),
    left = path.join(parent, "left"),
    right = path.join(parent, "right"),
    now = () => "2026-08-14T00:00:00.000Z",
    binding = { actor, source: "local" as const },
    repoId = workspaceId("artifact-equivalence");
  mkdirSync(left);
  initRepo(left);
  const seed = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(left),
    ownerId: "artifact-seed",
    now,
  });
  try {
    assert.equal(
      (
        await seed.run(
          { kind: "task-create", taskId: "task-artifact", title: "Artifacts" },
          binding,
        )
      ).outcome,
      "applied",
    );
    await seed.close();
    cpSync(left, right, { recursive: true });
    const artifactCell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(left),
        ownerId: "artifact-route",
        now,
      }),
      docCell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(right),
        ownerId: "doc-route",
        now,
      }),
      destination = "tasks/task-artifact-artifacts/artifacts/report.md",
      source = path.join(left, "incoming.md"),
      body = "# Report\n\nCanonical evidence.\n";
    writeFileSync(source, body);
    write(right, destination, body);
    try {
      const artifact = (await artifactCell.run(
          {
            kind: "task-artifact-add",
            taskId: "task-artifact",
            source: "incoming.md",
            destination: "report.md",
          },
          binding,
        )) as Record<string, unknown>,
        doc = (await docCell.run(
          { kind: "doc-submit", paths: [destination] },
          binding,
        )) as Record<string, unknown>;
      assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
      assert.equal(doc.outcome, "applied", JSON.stringify(doc));
      assert.deepEqual(
        {
          opId: artifact.opId,
          revision: artifact.revision,
          commitSha: artifact.commitSha,
          settlement: artifact.settlement,
          receiptId: artifact.receiptId,
        },
        {
          opId: doc.opId,
          revision: doc.revision,
          commitSha: doc.commitSha,
          settlement: doc.settlement,
          receiptId: doc.receiptId,
        },
      );
      const artifactStore = makeTaskEventStore({ repoId, rootDir: left }),
        docStore = makeTaskEventStore({ repoId, rootDir: right }),
        artifactEvent = artifactStore.readEvent(String(artifact.opId)),
        docEvent = docStore.readEvent(String(doc.opId));
      assert.ok(artifactEvent && docEvent);
      assert.equal(
        serializeCanonicalEvent(artifactEvent),
        serializeCanonicalEvent(docEvent),
      );
      assert.equal(
        readFileSync(path.join(left, "harness/events/head.json"), "utf8"),
        readFileSync(path.join(right, "harness/events/head.json"), "utf8"),
      );
      const shown = (await artifactCell.run(
        { kind: "receipt-show", opId: String(artifact.receiptId) },
        binding,
      )) as Record<string, unknown>;
      assert.equal(shown.receiptId, artifact.receiptId);
      assert.equal(shown.commitSha, artifact.commitSha);
      writeFileSync(source, "next\n");
      const collision = await artifactCell.run(
        {
          kind: "task-artifact-add",
          taskId: "task-artifact",
          source: "incoming.md",
          destination: "report.md",
        },
        binding,
      );
      assert.equal(collision.code, "artifact_collision");
      writeFileSync(path.join(left, "harness", destination), "edited\n");
      const trackedEdit = await artifactCell.run(
        {
          kind: "task-artifact-add",
          taskId: "task-artifact",
          source: "incoming.md",
          destination: "report.md",
        },
        binding,
      );
      assert.equal(trackedEdit.code, "artifact_tracked_edit");
      assert.match(
        trackedEdit.nextAction ?? "",
        /ha doc sync --submit --path/u,
      );
      const trackedSource = await artifactCell.run(
        {
          kind: "task-artifact-add",
          taskId: "task-artifact",
          source: `harness/${destination}`,
          destination: "other.md",
        },
        binding,
      );
      assert.equal(trackedSource.code, "artifact_source_tracked");
      writeFileSync(path.join(left, "bad.md"), Buffer.from([0xff]));
      assert.equal(
        (
          await artifactCell.run(
            {
              kind: "task-artifact-add",
              taskId: "task-artifact",
              source: "bad.md",
              destination: "bad.md",
            },
            binding,
          )
        ).code,
        "artifact_invalid_utf8",
      );
      assert.equal(
        (
          await artifactCell.run(
            {
              kind: "task-artifact-add",
              taskId: "task-artifact",
              source: "incoming.md",
              destination: "../escape.md",
            },
            binding,
          )
        ).code,
        "invalid_artifact_path",
      );
    } finally {
      await artifactCell.close();
      await docCell.close();
    }
  } finally {
    await seed.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact unknown settlement returns the canonical DocEvent receipt id without retrying", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-unknown-"));
  initRepo(rootDir);
  let armed = false,
    cell = await openRepoCell({
      repoId: workspaceId("artifact-unknown"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-unknown-one",
      now: () => "2026-08-14T00:00:00.000Z",
      killpoint: (point) => {
        if (armed && point === "before_response_write")
          throw new Error("response lost");
      },
    });
  const binding = { actor, source: "local" as const };
  try {
    assert.equal(
      (
        await cell.run(
          { kind: "task-create", taskId: "task-unknown", title: "Unknown" },
          binding,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(path.join(rootDir, "unknown.md"), "# Unknown\n");
    armed = true;
    const unknown = await cell.run(
      {
        kind: "task-artifact-add",
        taskId: "task-unknown",
        source: "unknown.md",
        destination: "unknown.md",
      },
      binding,
    );
    assert.equal(unknown.outcome, "indeterminate");
    assert.equal(unknown.code, "publication_indeterminate");
    assert.match(unknown.opId, /^op_/u);
    assert.match(
      unknown.nextAction ?? "",
      new RegExp(`receipt show ${unknown.opId}`, "u"),
    );
    assert.equal(
      makeTaskEventStore({ repoId: "artifact-unknown", rootDir }).read()
        .revision,
      2,
    );
    await cell.close();
    cell = await openRepoCell({
      repoId: workspaceId("artifact-unknown"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-unknown-two",
      now: () => "2026-08-14T00:00:00.000Z",
    });
    const settled = (await cell.run(
      { kind: "receipt-show", opId: unknown.opId },
      binding,
    )) as Record<string, unknown>;
    assert.equal(settled.outcome, "applied");
    assert.equal(settled.receiptId, unknown.opId);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an authored edit of a migrated governance standard upgrades its policy in the same write event", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-upgrade-"));
  initRepo(rootDir);
  const standard = "governance/standards/doc-library-standard.md",
    legacy = "# Docs Library\n\nfact 用 invalidate。\n",
    repoId = workspaceId("upgrade"),
    binding = { actor, source: "local" as const };
  makeTaskEventStore({ repoId, rootDir }).append(
    standardMigration(1, standard, legacy),
  );
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "upgrade-daemon",
  });
  try {
    write(rootDir, standard, `${legacy}fact 退场用 supersedes-fact。\n`);
    const dry = await cell.run(
      { kind: "doc-dry-run", paths: [standard] },
      binding,
    );
    assert.deepEqual(
      rows(dry.evidence).map((row) => [row.path, row.state]),
      [[standard, "eligible"]],
    );
    const applied = await cell.run(
      { kind: "doc-submit", paths: [standard] },
      binding,
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const upgraded = makeTaskEventStore({ repoId, rootDir }).readEvent(
      applied.opId,
    );
    assert.equal(upgraded?.schema, "doc-event/v1");
    if (upgraded?.schema === "doc-event/v1")
      assert.deepEqual(upgraded.payload.changes[0]?.policyUpgrade, {
        from: MIGRATION_DOCUMENT_POLICY_ID,
        to: DOC_POLICY_ID,
      });

    const secondBody = `${legacy}fact 退场用 supersedes-fact。\n删前先查 relation 入边。\n`;
    write(rootDir, standard, secondBody);
    const second = await cell.run(
      { kind: "doc-submit", paths: [standard] },
      binding,
    );
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const native = makeTaskEventStore({ repoId, rootDir }).readEvent(
      second.opId,
    );
    if (native?.schema === "doc-event/v1")
      assert.equal("policyUpgrade" in native.payload.changes[0]!, false);

    write(rootDir, standard, `${secondBody}hand edit outside doc sync\n`);
    git(rootDir, "add", "harness");
    git(rootDir, "commit", "-qm", "manual ledger advance");
    const accepted = await cell.run(
      { kind: "doc-submit", paths: [standard] },
      binding,
    );
    assert.equal(accepted.outcome, "applied");
    assert.equal(accepted.commitSha, null);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
