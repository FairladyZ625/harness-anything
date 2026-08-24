// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveRelationId,
  makeTaskEventStore,
  makeTaskProjection,
  sha256Text,
  stableStringify,
} from "../../kernel/src/index.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  attributionFixture,
  binaryAttachmentFixture,
  bootstrapPerson,
  bootstrapRoster,
  coverageCompleteFixture,
  coverageGapFixture,
  decisionContentFixture,
  git,
  hierarchyFixture,
  illegalRelationFixture,
  initRepo,
  legacyFixture,
  legacyRoster,
  multiSourceFixture,
  orphanEndpointFixture,
  referencedDocumentFixture,
  snapshot,
  sources,
  statOrNull,
  symbolicLinkFixture,
  unfamiliarDocumentFixture,
} from "./migration-import.fixtures.ts";
test("a CAS blob referenced by any migrated repo document follows it into the event stream", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-repo-reference-"),
    ),
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
    assert.equal(
      Buffer.from(store.readContentBlob(hash) ?? []).toString("utf8"),
      referencedBody,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration replays archived executions and UTF-8 task package documents through native projections", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-covered-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
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
    assert.match(String(result.summary), /Authored reconciliation: PASS/u);
    assert.match(
      String(result.summary),
      /\| task:executions\/\*\* \| migrated \| 1 \| PASS \|/u,
    );
    assert.match(
      String(result.summary),
      /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u,
    );
    assert.match(
      String(result.idMapPath),
      /^migrations\/import_[0-9a-f_]+\/id-map\.json$/u,
    );
    const tasks = await cell.read("repo.tasks.list"),
      row = tasks.rows.find(({ taskId }) => taskId === "task_coverage")!,
      archived = row.snapshot.executions[0] as unknown as Record<
        string,
        unknown
      >;
    assert.equal(row.generation, "v0");
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
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/executions/exe_history.md",
        ),
        "utf8",
      ),
      readFileSync(
        path.join(
          source,
          "harness/tasks/task_coverage-old/executions/exe_history.md",
        ),
        "utf8",
      ),
      "the native archived execution projection must retain its exact legacy source document",
    );
    const plan = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "task_plan.md",
    });
    assert.equal(plan.body, "# Authored plan\n");
    assert.equal(
      readFileSync(
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/task_plan.md",
        ),
        "utf8",
      ),
      plan.body,
    );
    assert.equal(
      readFileSync(
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/artifacts/evidence.html",
        ),
        "utf8",
      ),
      "<p>historical evidence</p>\n",
    );
    assert.equal(
      readFileSync(
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/artifacts/INDEX.md",
        ),
        "utf8",
      ),
      "# Artifact index\n",
    );
    assert.equal(
      readFileSync(
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/artifacts/probe/executions/exe_nested.md",
        ),
        "utf8",
      ),
      "# Nested fixture\n",
    );
    const index = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "INDEX.md",
    });
    assert.match(
      index.body,
      /## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical/u,
    );
    assert.match(
      index.body,
      /## Migrated source frontmatter[\s\S]*legacyOpaque: keep-this-source-field/u,
    );
    assert.equal(
      readFileSync(
        path.join(
          destination,
          "harness/tasks/task_coverage-coverage-fixture/INDEX.md",
        ),
        "utf8",
      ),
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
    assert.equal(migrationEvents.length, 5);
    assert.equal(
      migrationEvents.every(
        (event) =>
          event.source === "migration-import/v1" &&
          event.payload.generation === "v0",
      ),
      true,
    );
    const started = await cell.run(
      {
        kind: "task-start",
        taskId: "task_coverage",
        executionId: "exe_native_after_import",
      },
      { actor, source: "local" },
    );
    assert.equal(started.outcome, "applied");
    const afterStart = (await cell.read("repo.tasks.list")).rows.find(
      ({ taskId }) => taskId === "task_coverage",
    )!;
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
    assert.match(
      String(second.summary),
      /Already imported from this Git lineage: task=1/u,
    );
    assert.equal(
      cell.status().state,
      "attached",
      "a repeated import must not latch the workspace",
    );
    const dry = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0);
    assert.match(
      String(dry.summary),
      /Already imported from this Git lineage: task=1/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("decision replay keeps source prose and legacy frontmatter readable beside the native projection", async () => {
  const scratch = mkdtempSync(
      path.join(tmpdir(), "ha-migrate-decision-content-"),
    ),
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
    const body = readFileSync(
      path.join(
        destination,
        "harness/decisions/decision-dec_CONTENT/decision.md",
      ),
      "utf8",
    );
    assert.match(body, /Preserve this rationale verbatim\./u);
    assert.match(
      body,
      /## Migrated source frontmatter[\s\S]*contentPins:[\s\S]*sha256:aaaaaaaa/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
