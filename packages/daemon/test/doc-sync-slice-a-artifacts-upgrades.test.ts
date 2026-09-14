// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DOC_POLICY_ID,
  MIGRATION_DOCUMENT_POLICY_ID,
  activateEmptyCanonicalGeneration,
  classifyTextualArtifactPath,
  compileTaskLifecycleWrite,
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  reduceTaskEvent,
  serializeCanonicalEvent,
  sha256Text,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

import { actor, git, initRepo, ownerBinding, rows, standardMigration, write } from "./doc-sync-slice-a.fixtures.ts";
test("artifact add is the untracked UTF-8 canonical subset of doc submit", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-equivalence-")),
    left = path.join(parent, "left"),
    right = path.join(parent, "right"),
    now = () => "2026-08-14T00:00:00.000Z",
    binding = ownerBinding,
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
      (await seed.run({ kind: "task-create", taskId: "task-artifact", title: "Artifacts" }, binding)).outcome,
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
        doc = (await docCell.run({ kind: "doc-submit", paths: [destination] }, binding)) as Record<string, unknown>;
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
      const artifactStore = makeTaskEventReader({ repoId, rootDir: left }),
        docStore = makeTaskEventReader({ repoId, rootDir: right }),
        artifactEvent = artifactStore.readEvent(String(artifact.opId)),
        docEvent = docStore.readEvent(String(doc.opId));
      assert.ok(artifactEvent && docEvent);
      assert.equal(serializeCanonicalEvent(artifactEvent), serializeCanonicalEvent(docEvent));
      assert.deepEqual(artifactStore.readHead(), docStore.readHead());
      await waitForFixturePublication(artifactCell, String(artifact.opId), binding);
      await waitForFixturePublication(docCell, String(doc.opId), binding);
      const shown = (await artifactCell.run(
        { kind: "receipt-show", opId: String(artifact.receiptId) },
        binding,
      )) as Record<string, unknown>;
      assert.equal(shown.receiptId, artifact.receiptId);
      assert.match(String(shown.commitSha), /^[0-9a-f]{40}$/u);
      const replay = (await artifactCell.run(
        {
          kind: "task-artifact-add",
          taskId: "task-artifact",
          source: "incoming.md",
          destination: "report.md",
        },
        binding,
      )) as Record<string, unknown>;
      assert.deepEqual(
        {
          outcome: replay.outcome,
          opId: replay.opId,
          revision: replay.revision,
          receiptId: replay.receiptId,
          source: replay.source,
          destination: replay.destination,
        },
        {
          outcome: "applied",
          opId: artifact.opId,
          revision: artifact.revision,
          receiptId: artifact.receiptId,
          source: "incoming.md",
          destination,
        },
        JSON.stringify(replay),
      );
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
      assert.deepEqual(trackedEdit.diagnostic, { kind: "failure", code: "artifact_tracked_edit" });
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
        if (armed && point === "before_response_write") throw new Error("response lost");
      },
    });
  const binding = ownerBinding;
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-unknown", title: "Unknown" }, binding)).outcome,
      "applied",
    );
    writeFileSync(path.join(rootDir, "unknown.md"), "# Unknown\n");
    const revisionBeforeArtifact = makeTaskEventReader({ repoId: "artifact-unknown", rootDir }).read().revision;
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
    assert.equal(unknown.outcome, "pending");
    assert.equal(unknown.status, "accepted_durable");
    assert.ok(unknown.acceptance);
    assert.equal(unknown.code, "publication_indeterminate");
    assert.match(unknown.opId, /^op_/u);
    assert.deepEqual(unknown.guidance, [{ kind: "retry-receipt", args: { opId: unknown.opId } }]);
    assert.equal(
      makeTaskEventReader({ repoId: "artifact-unknown", rootDir }).read().revision,
      revisionBeforeArtifact + 1,
    );
    await cell.close();
    cell = await openRepoCell({
      repoId: workspaceId("artifact-unknown"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "artifact-unknown-two",
      now: () => "2026-08-14T00:00:00.000Z",
    });
    const settled = (await cell.run({ kind: "receipt-show", opId: unknown.opId }, binding)) as Record<string, unknown>;
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
    binding = ownerBinding;
  const seed = makeTaskEventStore({ repoId, rootDir, activationPreflight: activateEmptyCanonicalGeneration });
  seed.append(standardMigration(1, standard, legacy));
  await seed.drain();
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "upgrade-daemon",
  });
  try {
    write(rootDir, standard, `${legacy}fact 退场用 supersedes-fact。\n`);
    const dry = await cell.run({ kind: "doc-dry-run", paths: [standard] }, binding);
    assert.deepEqual(
      rows(dry.evidence).map((row) => [row.path, row.state]),
      [[standard, "eligible"]],
    );
    const applied = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const upgraded = makeTaskEventReader({ repoId, rootDir }).readEvent(applied.opId);
    assert.equal(upgraded?.schema, "doc-event/v1");
    if (upgraded?.schema === "doc-event/v1")
      assert.deepEqual(upgraded.payload.changes[0]?.policyUpgrade, {
        from: MIGRATION_DOCUMENT_POLICY_ID,
        to: DOC_POLICY_ID,
      });

    const secondBody = `${legacy}fact 退场用 supersedes-fact。\n删前先查 relation 入边。\n`;
    write(rootDir, standard, secondBody);
    const second = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const native = makeTaskEventReader({ repoId, rootDir }).readEvent(second.opId);
    if (native?.schema === "doc-event/v1") assert.equal("policyUpgrade" in native.payload.changes[0]!, false);

    // The receipt reports git pending; the hand commit must land on top of the second submit's publication.
    await waitForFixturePublication(cell, String(second.opId), binding);
    write(rootDir, standard, `${secondBody}hand edit outside doc sync\n`);
    git(rootDir, "add", "harness");
    git(rootDir, "commit", "-qm", "manual ledger advance");
    const accepted = await cell.run({ kind: "doc-submit", paths: [standard] }, binding);
    assert.equal(accepted.outcome, "applied");
    assert.equal(accepted.commitSha, null);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a renamed task plan H1 remains authored prose and submits normally", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-h1-restore-"));
  initRepo(rootDir);
  const repoId = workspaceId("h1-restore"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "h1-restore-daemon",
    }),
    binding = { actor, source: "local" as const },
    taskId = "task_H1REST0RE000000000000AAAAA",
    title = "很长的自解释标题:带括号与路径的完整 create title";
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title }, binding)) as {
        packagePath?: string;
        opId: string;
      },
      plan = `${created.packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    await waitForFixturePublication(cell, created.opId, binding);
    const scaffold = readFileSync(target, "utf8");
    assert.match(
      scaffold.split("\n")[0] ?? "",
      new RegExp(`^# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"),
    );
    writeFileSync(target, scaffold.replace(`# ${title}`, "# 好读的短标题"));
    const restore = new RegExp(
      `restore the H1 of ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} to the task title verbatim \\("# ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\), then rerun ha doc sync --submit --path ${plan.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
      "u",
    );
    const status = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(status.evidence)[0]?.state, "eligible", JSON.stringify(status));
    assert.doesNotMatch(JSON.stringify(status), restore);
    const submitted = await cell.run({ kind: "doc-submit", paths: [plan] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("amending the title retitles the published plan through the typed route and the plan stays prose-submittable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-amend-retitle-"));
  initRepo(rootDir);
  const repoId = workspaceId("amend-retitle"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-retitle-daemon",
    }),
    binding = { actor, source: "local" as const },
    taskId = "task_AMENDRETITLE000000AAAAAA",
    firstTitle = "amend retitle first title",
    secondTitle = "amend retitle second title";
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title: firstTitle }, binding)) as {
        packagePath?: string;
        opId: string;
      },
      plan = `${created.packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    await waitForFixturePublication(cell, created.opId, binding);
    const scaffold = readFileSync(target, "utf8");
    assert.match(scaffold.split("\n")[0] ?? "", /^# amend retitle first title$/u);
    writeFileSync(target, `${scaffold}\n## Worker Notes\n\nfirst round of worker prose\n`);
    const synced = await cell.run({ kind: "doc-submit", paths: [plan] }, binding);
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    await waitForFixturePublication(cell, synced.opId, binding);
    const amended = (await cell.run(
      {
        kind: "task-amend",
        taskId,
        patches: [{ field: "title", value: secondTitle }],
      },
      binding,
    )) as { outcome?: string; opId?: string; changedPaths?: readonly string[] };
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.ok(
      amended.changedPaths?.includes(plan),
      `amend changedPaths must retitle the plan: ${JSON.stringify(amended.changedPaths)}`,
    );
    await waitForFixturePublication(cell, amended.opId!, binding);
    const retitled = readFileSync(target, "utf8");
    assert.match(retitled.split("\n")[0] ?? "", /^# amend retitle second title$/u);
    assert.match(retitled, /## Worker Notes\n\nfirst round of worker prose/u);
    const amendEvent = makeTaskEventStore({ repoId, rootDir, mutable: false }).readEvent(amended.opId!);
    assert.equal(amendEvent?.type, "task_amended");
    if (amendEvent?.type === "task_amended") {
      const planClaim = amendEvent.payload.documentClaims.find((claim) => claim.path === plan);
      assert.ok(planClaim, "amend event must claim the retitled plan");
      assert.equal(planClaim.policyId, "markdown-body-replaceable/v1");
    }
    const projected = (await cell.run({ kind: "doc-show", path: plan }, binding)) as { evidence?: string };
    assert.match((projected.evidence ?? "").split("\n")[0] ?? "", /^# amend retitle second title$/u);
    writeFileSync(target, retitled.replace("first round of worker prose", "second round of worker prose"));
    const status = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(status.evidence)[0]?.state, "eligible", JSON.stringify(status));
    const resubmitted = await cell.run({ kind: "doc-submit", paths: [plan] }, binding);
    assert.equal(resubmitted.outcome, "applied", JSON.stringify(resubmitted));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a no-op title amend heals a plan whose canonical base still holds the pre-amend H1", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-amend-noop-"));
  initRepo(rootDir);
  const repoId = workspaceId("amend-noop"),
    taskId = "task_AMENDNOOP000000000AAAAA",
    firstTitle = "no-op amend first title",
    secondTitle = "no-op amend second title";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-noop-daemon",
    });
    const binding = { actor, source: "local" as const };
    const created = (await cell.run({ kind: "task-create", taskId, title: firstTitle }, binding)) as {
        packagePath?: string;
        opId: string;
      },
      packagePath = created.packagePath!,
      plan = `${packagePath}/task_plan.md`,
      target = path.join(rootDir, "harness", plan);
    await waitForFixturePublication(cell, created.opId, binding);
    const initialSync = await cell.run({ kind: "doc-submit", taskId }, binding);
    assert.equal(initialSync.outcome, "no_changes", JSON.stringify(initialSync));
    assert.equal(initialSync.code, "no_changes", JSON.stringify(initialSync));
    // Seed the stock shape directly: a title amend whose ledger was written before the typed
    // retitle existed (claims INDEX + contract only), so canonical keeps the old-H1 plan base
    // while the ledger title — and the worker's local H1 — already moved on.
    await cell.close();
    cell = undefined;
    const store = makeTaskEventStore({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      read = projection.read(taskId),
      opId = "op-amend-noop-seed";
    const seedEvent = {
      schema: "task-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      opId,
      taskId,
      type: "task_amended",
      actor,
      source: "local",
      occurredAt: "2026-08-23T00:00:00.000Z",
      payload: {
        task: { ...read.snapshot.task!, title: secondTitle },
        mutation: {
          command: "amend",
          reason: "declared retitle before the typed plan route existed",
          fields: ["title"],
        },
        documentClaims: [],
      },
    } as unknown as import("../../kernel/src/index.ts").TaskEventV1;
    const compiled = compileTaskLifecycleWrite({
      event: seedEvent,
      snapshot: reduceTaskEvent(read.snapshot, seedEvent),
      packagePath,
      currentDocuments: ["INDEX.md", "task-contract.json"].map((leaf) => {
        const document = projection.readDocument(`${packagePath}/${leaf}`).document!;
        return {
          path: document.path,
          body: document.body,
          blobSha256: document.blobSha256,
        };
      }),
    });
    assert.equal(compiled.changedPaths.includes(plan), false);
    store.append(compiled);
    await store.drain();
    projection.close();
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "amend-noop-replay",
    });
    const workerBody = readFileSync(target, "utf8")
      .replace(`# ${firstTitle}`, `# ${secondTitle}`)
      .concat("\n## Drift\n\nworker prose written under the already-renamed H1\n");
    writeFileSync(target, workerBody);
    const authored = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(authored.evidence)[0]?.state, "eligible", JSON.stringify(authored));
    const noop = (await cell.run(
      {
        kind: "task-amend",
        taskId,
        patches: [{ field: "title", value: secondTitle }],
      },
      binding,
    )) as { outcome?: string; opId: string; changedPaths?: readonly string[] };
    assert.equal(noop.outcome, "applied", JSON.stringify(noop));
    assert.ok(
      noop.changedPaths?.includes(plan),
      `no-op amend must retitle the plan: ${JSON.stringify(noop.changedPaths)}`,
    );
    await waitForFixturePublication(cell, noop.opId, binding);
    // The typed settle preserves the unmerged worker edit as conflict scratch and lays down the
    // retitled base; merging the scratch back by hand restores the worker body on the fresh base.
    const scratches = readdirSync(path.dirname(target)).filter((name) =>
      /^task_plan\.conflict-[0-9a-f]{8}\.md$/u.test(name),
    );
    assert.equal(scratches.length, 1, `expected one conflict scratch, found ${JSON.stringify(scratches)}`);
    writeFileSync(target, workerBody);
    rmSync(path.join(path.dirname(target), scratches[0]!));
    const healed = await cell.run({ kind: "doc-status", paths: [plan] }, binding);
    assert.equal(rows(healed.evidence)[0]?.state, "eligible", JSON.stringify(healed));
    assert.equal((await cell.run({ kind: "doc-submit", paths: [plan] }, binding)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("authored CRLF prose is canonicalized on scanner read and submitted as LF", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-crlf-"));
  initRepo(rootDir);
  const repoId = workspaceId("crlf"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "crlf-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/crlf.md",
    canonical = "# CRLF\n\naccepted\n";
  try {
    write(rootDir, logical, canonical.replace(/\n/gu, "\r\n"));
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    // A default store would schedule its own Git follower and race the cell's writer for the branch ref.
    const event = makeTaskEventStore({ repoId, rootDir, mutable: false }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.equal(event.payload.changes[0]?.candidate.sha256, sha256Text(canonical));
      assert.equal(event.payload.changes[0]?.candidate.size, Buffer.byteLength(canonical));
    }
    await waitForFixturePublication(cell, submitted.opId, binding);
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), canonical);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanner textual artifacts use the canonical classifier", () => {
  const opaque = "tasks/task-one/artifacts/scripts/report.mjs";
  assert.deepEqual(classifyTextualArtifactPath(opaque), {
    kind: "opaque-textual",
    mediaType: "text/javascript",
    policyId: "opaque-textual-whole-file/v1",
  });
});
