// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  canonicalizeContractValue,
  makeTaskEventStore,
  readSettingsFacet,
  sha256Text,
} from "../../kernel/src/index.ts";
import { compileRepoTaskPackage } from "../../preset/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { blob, claim, prepare } from "../src/migration-import-events.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import {
  actor,
  coverageCompleteFixture,
  decisionContentFixture,
  initRepo,
  referencedDocumentFixture,
  sources,
} from "./migration-import.fixtures.ts";
test("a CAS blob referenced by any migrated repo document follows it into the event stream", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-reference-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    referencedBody = "# Referenced body\n";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    referencedDocumentFixture(source, referencedBody);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-repo-reference-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const store = makeTaskEventStore({
        repoId: "migration-repo-reference-target",
        rootDir: destination,
      }),
      hash = sha256Text(referencedBody),
      event = store
        .read()
        .events.find(
          (candidate) =>
            candidate.schema === "migration-import-event/v1" &&
            candidate.payload.migratedFrom === "field-notes/reference.json",
        )!;
    assert.equal(event.payload.entity.kind, "repo-document");
    assert.deepEqual(
      (
        event.payload.entity as {
          readonly referencedContentClaims: readonly unknown[];
        }
      ).referencedContentClaims,
      [
        {
          sha256: hash,
          size: Buffer.byteLength(referencedBody),
          mediaType: "text/markdown; charset=utf-8",
        },
      ],
    );
    assert.equal(Buffer.from(store.readContentBlob(hash) ?? []).toString("utf8"), referencedBody);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration replays archived executions and keeps v0 tasks explicit about contract backfill", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-covered-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    writeLegacyTaskEvent(source, true);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-covered-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.contractRestatements, {
      task: {
        sourceV1: 1,
        targetV2: 1,
        pinnedPreserved: 1,
        pinnedExplicitFalse: 0,
        importedSnapshot: 1,
      },
    });
    assert.match(String(result.summary), /\| Task\/v1 -> Task\/v2 \| 1 \| 1 \| 1 \| 0 \| 1 imported_snapshot \|/u);
    assert.match(String(result.summary), /Authored directory audit \(informational\): complete/u);
    assert.match(String(result.summary), /\| task:executions\/\*\* \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.summary), /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.idMapPath), /^migrations\/import_[0-9a-f_]+\/id-map\.json$/u);
    const tasks = await cell.read("repo.tasks.list"),
      row = tasks.rows.find(({ taskId }) => taskId === "task_coverage")!,
      archived = row.snapshot.executions[0] as unknown as Record<string, unknown>;
    assert.equal(row.generation, "v0");
    assert.equal(row.snapshot.task?.schema, "task/v2");
    assert.equal(row.snapshot.task?.pinned, true);
    assert.equal(row.createdAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(
      {
        schema: archived.schema,
        generation: archived.generation,
        state: archived.state,
        count: row.snapshot.executions.length,
      },
      {
        schema: "archived-execution/v1",
        generation: "v0",
        state: "accepted",
        count: 1,
      },
    );
    assert.deepEqual(
      {
        origin: row.executionEvidence[0]?.origin,
        locator: row.executionEvidence[0]?.outputs[0]?.locator,
      },
      { origin: "archival", locator: "artifacts/evidence.html" },
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/executions/exe_history.md"),
        "utf8",
      ),
      readFileSync(path.join(source, "harness/tasks/task_coverage-old/executions/exe_history.md"), "utf8"),
      "the native archived execution projection must retain its exact legacy source document",
    );
    const plan = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "task_plan.md",
    });
    assert.equal(plan.body, realizedTaskPlan("Coverage fixture"));
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/task_plan.md"), "utf8"),
      plan.body,
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/evidence.html"),
        "utf8",
      ),
      "<p>historical evidence</p>\n",
    );
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/INDEX.md"), "utf8"),
      "# Artifact index\n",
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/probe/executions/exe_nested.md"),
        "utf8",
      ),
      "# Nested fixture\n",
    );
    const index = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "INDEX.md",
    });
    assert.match(index.body, /## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical/u);
    assert.match(index.body, /## Migrated source frontmatter[\s\S]*legacyOpaque: keep-this-source-field/u);
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/INDEX.md"), "utf8"),
      index.body,
    );
    const migrationEvents = makeTaskEventStore({
      repoId: "migration-covered-target",
      rootDir: destination,
    })
      .read()
      .events.filter(
        (event) =>
          event.schema === "migration-import-event/v1" &&
          ["execution", "task-document"].includes(event.payload.entity.kind),
      );
    const taskMigration = makeTaskEventStore({
      repoId: "migration-covered-target",
      rootDir: destination,
    })
      .read()
      .events.find((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task");
    assert.equal(taskMigration?.payload.entity.kind, "task");
    if (taskMigration?.payload.entity.kind === "task") {
      assert.equal(taskMigration.payload.entity.provenance, "imported_snapshot");
      assert.equal(taskMigration.payload.entity.task.schema, "task/v2");
      assert.equal(taskMigration.payload.entity.task.pinned, true);
    }
    assert.equal(migrationEvents.length, 5);
    assert.equal(
      migrationEvents.every((event) => event.source === "migration-import/v1" && event.payload.generation === "v0"),
      true,
    );
    const migratedContract = await cell.run(
      { kind: "task-contract-migrate", mode: "apply", taskId: "task_coverage" },
      { actor, source: "local" },
    );
    assert.equal(migratedContract.outcome, "applied", JSON.stringify(migratedContract));
    assert.match(String(migratedContract.evidence), /"status":"repair"/u);
    assert.match(String(migratedContract.evidence), /"digestSource":"compiled"/u);
    await realizeTaskPlanFixture(
      destination,
      "tasks/task_coverage-coverage-fixture",
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, { actor, source: "local" }),
      "Coverage fixture",
      "## Contract migration\n\nExercise the native transition after importing v0 history.",
    );
    const started = await cell.run(
      {
        kind: "task-start",
        taskId: "task_coverage",
        executionId: "exe_native_after_import",
      },
      { actor, source: "local" },
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const afterStart = (await cell.read("repo.tasks.list")).rows.find(({ taskId }) => taskId === "task_coverage")!;
    assert.deepEqual(
      afterStart.snapshot.executions.map(({ schema }) => schema),
      ["archived-execution/v1", "execution/v1"],
    );
    assert.deepEqual(
      afterStart.executionEvidence.map(({ origin }) => origin),
      ["archival", "native"],
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function writeLegacyTaskEvent(root: string, pinned: boolean): void {
  const eventsRoot = path.join(root, "harness/events/legacy");
  mkdirSync(eventsRoot, { recursive: true });
  const event = {
    schema: "task-event/v1",
    eventId: "event-legacy-task-coverage",
    workspaceRevision: 1,
    opId: "op-legacy-task-coverage",
    taskId: "task_coverage",
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v1",
        taskId: "task_coverage",
        title: "Coverage fixture",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned,
      },
    },
  };
  writeFileSync(path.join(eventsRoot, "task-created.json"), `${JSON.stringify(canonicalizeContractValue(event))}\n`);
}

test("re-importing a source is an incremental no-op instead of a hard rejection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-twice-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-twice-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const first = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    const firstRevision = first.revision;
    const second = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(second.outcome, "applied");
    assert.equal(second.exitCode, 0);
    assert.equal(second.revision, firstRevision);
    assert.match(String(second.summary), /Already imported from this Git lineage: task=1/u);
    assert.equal(cell.status().state, "attached", "a repeated import must not latch the workspace");
    const dry = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0);
    assert.match(String(dry.summary), /Already imported from this Git lineage: task=1/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration adopts the source contract digest and rewrites the contract package path", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-contract-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    digest = `sha256:${"a".repeat(64)}`;
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    writeFileSync(
      path.join(source, "harness/tasks/task_coverage-old/task-contract.json"),
      `${JSON.stringify(
        {
          ...contractMetadata("task_coverage", "tasks/task_coverage-old", "Coverage fixture"),
          presetSnapshotDigest: digest,
        },
        null,
        2,
      )}\n`,
    );
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-contract-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const row = (await cell.read("repo.tasks.list")).rows.find(({ taskId }) => taskId === "task_coverage")!;
    assert.equal(row.snapshot.task?.presetSnapshotDigest, digest);
    assert.equal(row.snapshot.task?.contractVersion, 1);
    const targetPackage = "tasks/task_coverage-coverage-fixture",
      contract = JSON.parse(
        readFileSync(path.join(destination, "harness", targetPackage, "task-contract.json"), "utf8"),
      ) as Record<string, unknown>;
    assert.equal(contract.taskId, "task_coverage");
    assert.equal(contract.packagePath, targetPackage);
    assert.equal(contract.presetSnapshotDigest, digest);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("contract migration repairs old migrated rows through one canonical event and reruns as a no-op", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-migrate-contract-repair-")),
    repoId = workspaceId("migration-contract-repair"),
    taskId = "task_migrated_repair",
    packagePath = `tasks/${taskId}-repair-fixture`,
    stalePackagePath = `tasks/${taskId}-old-name`,
    missingTaskId = "task_migrated_missing_contract",
    missingPackagePath = `tasks/${missingTaskId}-missing-contract`,
    occurredAt = "2026-01-01T00:00:00.000Z";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "migration-repair-bootstrap" });
    const bootstrap = await cell.run({ kind: "projection-rebuild" }, { actor, source: "local" });
    assert.equal(bootstrap.outcome, "applied", JSON.stringify(bootstrap));
    await cell.close();
    cell = undefined;
    const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8")),
      contractBase = contractMetadata(taskId, stalePackagePath),
      digest = compileRepoTaskPackage({
        rootDir,
        settings,
        taskId,
        action: { kind: "task-create", ...contractBase },
      }).snapshot.digest,
      missingDigest = compileRepoTaskPackage({
        rootDir,
        settings,
        taskId: missingTaskId,
        action: { kind: "task-create", ...contractMetadata(missingTaskId, missingPackagePath) },
      }).snapshot.digest,
      indexBody = `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: Migrated repair fixture\nlifecycle:\n  status: planned\n  engine: migration-import/v1\n---\n\n# Migrated repair fixture\n`,
      contractBody = `${JSON.stringify(
        {
          ...contractBase,
          presetSnapshotDigest: digest,
          documents: [{ slot: "task.closeout", path: "closeout.md" }],
        },
        null,
        2,
      )}\n`,
      closeoutBody =
        "# Closeout\n\n## Summary\n\nPending.\n\n## Verification\n\nPending.\n\n## Residual Risk\n\nPending.\n",
      store = makeTaskEventStore({ repoId, rootDir }),
      initialRevision = store.readHead()?.revision ?? 0,
      ledger = () => makeTaskEventStore({ repoId, rootDir }).read(),
      task = {
        schema: "task/v2" as const,
        taskId,
        title: "Migrated repair fixture",
        taskClass: "standard" as const,
        status: "planned" as const,
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        pinned: false,
        packageDisposition: "active" as const,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
      };
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task",
        taskId,
        occurredAt,
        initialRevision + 1,
        {
          kind: "task",
          provenance: "imported_snapshot",
          task,
          originalStatus: "planned",
          packagePath,
          documentClaim: claim(`${packagePath}/INDEX.md`, indexBody, "text/markdown"),
        },
        [blob(indexBody, "text/markdown")],
      ),
    );
    for (const [revision, name, body, mediaType] of [
      [initialRevision + 2, "task-contract.json", contractBody, "application/json"],
      [initialRevision + 3, "closeout.md", closeoutBody, "text/markdown"],
    ] as const)
      store.append(
        prepare(
          "legacy-source",
          actor,
          "task-document",
          `harness/tasks/${taskId}-old-name/${name}`,
          occurredAt,
          revision,
          {
            kind: "task-document",
            taskId,
            documentClaim: claim(`${packagePath}/${name}`, body, mediaType),
          },
          [blob(body, mediaType)],
        ),
      );
    const missingIndexBody = `---\nschema: task-package/v2\ntask_id: ${missingTaskId}\ntitle: Migrated repair fixture\nlifecycle:\n  status: planned\n  engine: migration-import/v1\n---\n\n# Migrated repair fixture\n`,
      missingTask = {
        ...task,
        taskId: missingTaskId,
        metadata: {
          idempotencyKey: null,
          parentTaskId: null,
          workKind: "chore" as const,
          riskTier: "medium" as const,
          urgency: "medium" as const,
          verticalId: "software/coding",
          presetId: "standard-task",
          profileId: "baseline",
          moduleKey: null,
          slug: "missing-contract",
          surfaces: [],
          fromLegacyId: null,
        },
      };
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task",
        missingTaskId,
        occurredAt,
        initialRevision + 4,
        {
          kind: "task",
          provenance: "imported_snapshot",
          task: missingTask,
          originalStatus: "planned",
          packagePath: missingPackagePath,
          documentClaim: claim(`${missingPackagePath}/INDEX.md`, missingIndexBody, "text/markdown"),
        },
        [blob(missingIndexBody, "text/markdown")],
      ),
    );
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task-document",
        `harness/tasks/${missingTaskId}-old-name/closeout.md`,
        occurredAt,
        initialRevision + 5,
        {
          kind: "task-document",
          taskId: missingTaskId,
          documentClaim: claim(`${missingPackagePath}/closeout.md`, closeoutBody, "text/markdown"),
        },
        [blob(closeoutBody, "text/markdown")],
      ),
    );
    await store.drain();
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "migration-repair-daemon" });
    const binding = { actor, source: "local" as const },
      blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding);
    assert.equal(blocked.code, "content_not_ready");
    const revisionBeforeDryRun = ledger().revision,
      dryRun = await cell.run({ kind: "task-contract-migrate", mode: "dry-run", taskId }, binding),
      dryEvidence = JSON.parse(String(dryRun.evidence)) as {
        readonly report: readonly Record<string, unknown>[];
      };
    assert.equal(dryRun.outcome, "pending");
    assert.equal(ledger().revision, revisionBeforeDryRun);
    assert.deepEqual(dryEvidence.report[0], {
      taskId,
      status: "repair",
      presetSnapshotDigestBefore: null,
      presetSnapshotDigestAfter: digest,
      packagePathBefore: stalePackagePath,
      packagePathAfter: packagePath,
      digestSource: "contract",
    });
    const applied = await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(ledger().revision, revisionBeforeDryRun + 1);
    assert.equal(ledger().events.filter((event) => event.type === "task_contract_migrated").length, 1);
    const repaired = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!;
    assert.equal(repaired.snapshot.task?.presetSnapshotDigest, digest);
    assert.equal(repaired.snapshot.task?.contractVersion, 1);
    const repairedContract = JSON.parse(
      readFileSync(path.join(rootDir, "harness", packagePath, "task-contract.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(repairedContract.packagePath, packagePath);
    assert.equal(repairedContract.presetSnapshotDigest, digest);
    const nextGate = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding);
    assert.notEqual(nextGate.code, "content_not_ready", JSON.stringify(nextGate));
    assert.equal(nextGate.code, "not_in_review", JSON.stringify(nextGate));
    const revisionBeforeRerun = ledger().revision,
      rerun = await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId }, binding);
    assert.equal(rerun.outcome, "applied", JSON.stringify(rerun));
    assert.equal(ledger().revision, revisionBeforeRerun);
    assert.equal(ledger().events.filter((event) => event.type === "task_contract_migrated").length, 1);
    const missingDryRun = await cell.run(
        { kind: "task-contract-migrate", mode: "dry-run", taskId: missingTaskId },
        binding,
      ),
      missingEvidence = JSON.parse(String(missingDryRun.evidence)) as {
        readonly report: readonly Record<string, unknown>[];
      };
    assert.deepEqual(missingEvidence.report[0], {
      taskId: missingTaskId,
      status: "repair",
      presetSnapshotDigestBefore: null,
      presetSnapshotDigestAfter: missingDigest,
      packagePathBefore: null,
      packagePathAfter: missingPackagePath,
      digestSource: "compiled",
    });
    assert.equal(
      (await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId: missingTaskId }, binding)).outcome,
      "applied",
    );
    const synthesizedContract = JSON.parse(
      readFileSync(path.join(rootDir, "harness", missingPackagePath, "task-contract.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(synthesizedContract.packagePath, missingPackagePath);
    assert.equal(synthesizedContract.presetSnapshotDigest, missingDigest);
    assert.equal(Array.isArray(synthesizedContract.documents), true);
    const missingNextGate = await cell.run(
      { kind: "task-complete", taskId: missingTaskId, executionId: "execution-missing" },
      binding,
    );
    assert.equal(missingNextGate.code, "not_in_review", JSON.stringify(missingNextGate));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function contractMetadata(taskId: string, packagePath: string, title = "Migrated repair fixture") {
  return {
    schema: "task-contract/v1",
    contractVersion: 1,
    taskId,
    packagePath,
    title,
    taskClass: "standard",
    verticalId: "software/coding",
    presetId: "standard-task",
    profileId: "baseline",
    locale: "en-US",
  } as const;
}

test("decision replay keeps source prose and legacy frontmatter readable beside the native projection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-decision-content-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    decisionContentFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-decision-content-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const body = readFileSync(path.join(destination, "harness/decisions/decision-dec_CONTENT/decision.md"), "utf8");
    assert.match(body, /Preserve this rationale verbatim\./u);
    assert.match(body, /## Migrated source frontmatter[\s\S]*contentPins:[\s\S]*sha256:aaaaaaaa/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
