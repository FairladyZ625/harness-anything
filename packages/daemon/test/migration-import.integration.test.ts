import type { FactEventDraftV1 } from "../../kernel/src/domain/fact-event.ts";
// harness-test-tier: integration
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileFactWrite,
  makeTaskEventStore,
  serializeCanonicalEvent,
  sha256Text,
  type } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  binaryAttachmentFixture,
  coverageGapFixture,
  git,
  initRepo,
  legacyFixture,
  snapshot,
  sources,
  statOrNull,
  symbolicLinkFixture,
  unfamiliarDocumentFixture,
} from "./migration-import.fixtures.ts";
test("legacy copy -> initialized repository -> migration import -> reconciliation", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-import-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    legacyFixture(source);
    initRepo(destination);
    const sourceBefore = snapshot(source);
    cell = await openRepoCell({
      repoId: workspaceId("migration-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const before =
        makeTaskEventStore({
          repoId: "migration-target",
          rootDir: destination,
        }).readHead()?.revision ?? 0,
      dryRun = (await cell.run(
        { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
        { actor, source: "local" },
      )) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 1, JSON.stringify(dryRun));
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-target",
        rootDir: destination,
      }).readHead()?.revision ?? 0,
      before,
    );
    assert.deepEqual(snapshot(source), sourceBefore);
    assert.match(String(dryRun.summary), /\| task \| 2 \| 1 \| 1 \| 1 \| PASS \|/u);
    assert.match(String(dryRun.summary), /\| relation \| 3 \| 0 \| 3 \| 3 \| PASS \|/u);
    assert.match(String(dryRun.summary), /Format validation: 1 skipped/u);
    assert.match(String(dryRun.summary), /\| task:INDEX\.md \| required \| 1 \| FAIL \|/u);
    const applied = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(applied.exitCode, 1, JSON.stringify(applied));
    assert.equal(applied.idMapPath, null);
    assert.match(String(applied.summary), /Authored reconciliation: FAIL/u);
    assert.deepEqual(snapshot(source), sourceBefore);
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-target",
        rootDir: destination,
      }).readHead()?.revision ?? 0,
      before,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("authored coverage migrates ordinary documents but blocks an unwired specialized channel before any write", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-coverage-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageGapFixture(source);
    initRepo(destination);
    const sourceBefore = snapshot(source);
    cell = await openRepoCell({
      repoId: workspaceId("migration-coverage-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const before =
        makeTaskEventStore({
          repoId: "migration-coverage-target",
          rootDir: destination,
        }).readHead()?.revision ?? 0,
      result = (await cell.run(
        { kind: "migrate-import", sourceRoots: sources(source) },
        { actor, source: "local" },
      )) as Record<string, unknown>;
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(result.outcome, "op_rejected");
    assert.equal(
      makeTaskEventStore({
        repoId: "migration-coverage-target",
        rootDir: destination,
      }).readHead()?.revision ?? 0,
      before,
    );
    assert.deepEqual(snapshot(source), sourceBefore);
    assert.match(String(result.summary), /Authored reconciliation: FAIL/u);
    assert.match(String(result.summary), /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.summary), /\| objects\/\*\* \| excluded \| 1 \| PASS \|/u);
    assert.match(String(result.summary), /\| repo-document \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.summary), /REQUIRED presets\/\*\*/u);
    assert.doesNotMatch(String(result.summary), /UNCOVERED/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("non-UTF-8 attachments stay explicit in authored coverage as owner-excluded content", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-binary-attachments-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    binaryAttachmentFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-binary-attachments-target"),
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
    assert.match(
      String(result.summary),
      /\| binary-attachment \| excluded \| 2 \| PASS \| owner decision: binary attachments do not enter the new ledger; the archived source retains the original bytes \|/u,
    );
    assert.equal(statOrNull(path.join(destination, "harness/field-notes/screenshot.png")), null);
    assert.equal(
      statOrNull(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/screenshot.png")),
      null,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test(
  "a migrated symbolic link preserves its target text and remains a link without dereferencing",
  {
    skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false,
  },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-symbolic-link-")),
      source = path.join(scratch, "legacy"),
      destination = path.join(scratch, "new"),
      linkTarget = "../missing.md";
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      symbolicLinkFixture(source, linkTarget);
      initRepo(destination);
      cell = await openRepoCell({
        repoId: workspaceId("migration-symbolic-link-target"),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-daemon",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      const result = (await cell.run(
          { kind: "migrate-import", sourceRoots: sources(source) },
          { actor, source: "local" },
        )) as Record<string, unknown>,
        target = path.join(destination, "harness/field-notes/latest.md");
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.outcome, "applied");
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.equal(readlinkSync(target), linkTarget);
      assert.equal(result.commitSha, undefined);
      await cell.close();
      cell = undefined;
      assert.match(git(destination, "ls-tree", "HEAD", "--", "harness/field-notes/latest.md"), /^120000 blob /u);
      const store = makeTaskEventStore({
          repoId: "migration-symbolic-link-target",
          rootDir: destination,
        }),
        event = store
          .read()
          .events.find(
            (candidate) =>
              candidate.schema === "migration-import-event/v1" &&
              candidate.payload.migratedFrom === "field-notes/latest.md",
          )!;
      assert.equal(event.payload.entity.kind, "repo-document");
      assert.equal((event.payload.entity as { readonly nodeKind?: string }).nodeKind, "symbolic-link");
      assert.equal(
        (
          event.payload.entity as {
            readonly documentClaim: { readonly sha256: string };
          }
        ).documentClaim.sha256,
        sha256Text(linkTarget),
      );
      rmSync(target);
      store.materialize();
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.equal(readlinkSync(target), linkTarget);
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("an authored document in an unfamiliar directory migrates as a repo document", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-document-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-repo-document-target"),
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
    assert.match(String(result.summary), /\| repo-document \| migrated \| 1 \| PASS \|/u);
    assert.equal(
      readFileSync(path.join(destination, "harness/field-notes/2024/xyz.md"), "utf8"),
      "# Field observation\n\nUnknown directories are ordinary authored content.\n",
    );
    const event = makeTaskEventStore({
      repoId: "migration-repo-document-target",
      rootDir: destination,
    })
      .read()
      .events.find(
        (candidate) =>
          candidate.schema === "migration-import-event/v1" && candidate.payload.entity.kind === "repo-document",
      );
    assert.equal(event?.payload.migratedFrom, "field-notes/2024/xyz.md");
    assert.equal(event?.payload.entity.kind, "repo-document");
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration imports a taskless Fact without inventing an owner relation", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-taskless-fact-")),
    source = path.join(scratch, "source"),
    destination = path.join(scratch, "destination"),
    event: FactEventDraftV1 = {
      schema: "fact-event/v1",
      eventId: "event-taskless-fact",
      workspaceRevision: 1,
      opId: "op-taskless-fact",
      factId: "F-FACEB00C",
      type: "fact_recorded",
      actor,
      source: "local",
      occurredAt: "2026-08-27T00:00:00.000Z",
      payload: {
        statement: "A source observation has no task owner.",
        evidenceSource: "migration fixture",
        observedAt: "2026-08-27T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "taskless-migration",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-27T00:00:00.000Z",
          },
        ],
      },
    },
    compiled = compileFactWrite({ event });
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const eventsRoot = path.join(source, "harness/events/native"),
      factsRoot = path.join(source, "harness/facts");
    mkdirSync(eventsRoot, { recursive: true });
    mkdirSync(factsRoot, { recursive: true });
    writeFileSync(
      path.join(source, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    writeFileSync(path.join(eventsRoot, `${event.opId}.json`), serializeCanonicalEvent(compiled.event));
    writeFileSync(path.join(factsRoot, `${event.factId}.md`), compiled.body);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-taskless-fact-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-28T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const events = makeTaskEventStore({ repoId: "migration-taskless-fact-target", rootDir: destination })
        .read()
        .events.filter((candidate) => candidate.schema === "migration-import-event/v1"),
      migratedFact = events.find((candidate) => candidate.payload.entity.kind === "fact");
    assert.equal(migratedFact?.payload.entity.kind, "fact");
    if (migratedFact?.payload.entity.kind === "fact") assert.equal(migratedFact.payload.entity.fact.taskId, undefined);
    assert.equal(
      events.some(
        (candidate) =>
          candidate.payload.entity.kind === "relation" && candidate.payload.entity.relation.type === "produces",
      ),
      false,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("same-id legacy Facts under different tasks are deterministically re-keyed instead of merged", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-same-id-facts-")),
    source = path.join(scratch, "source"),
    destination = path.join(scratch, "destination");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    mkdirSync(path.join(source, "harness"), { recursive: true });
    writeFileSync(
      path.join(source, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    for (const taskId of ["task-alpha", "task-beta"]) {
      const taskRoot = path.join(source, "harness/tasks", taskId);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(
        path.join(taskRoot, "INDEX.md"),
        [
          "---",
          "schema: task-package/v2",
          `task_id: ${taskId}`,
          `title: ${taskId}`,
          "lifecycle:",
          "  status: planned",
          "  engine: local",
          "  bindingCreatedAt: 2026-08-27T00:00:00.000Z",
          "vertical: software/coding",
          "preset: standard-task",
          "---",
          "",
          `# ${taskId}`,
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(taskRoot, "facts.md"),
        [
          "# Facts",
          "",
          `- {fact_id: F-DEADBEEF, statement: ${taskId} observation, source: migration fixture, observedAt: 2026-08-27T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [], provenance: [{runtime: codex, sessionId: ${taskId}, boundAt: 2026-08-27T00:00:00.000Z}]}`,
          "",
        ].join("\n"),
      );
    }
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-same-id-facts-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-28T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(String(result.summary), /REMAP fact fact\/task-beta\/F-DEADBEEF -> fact\/F-[0-9A-HJKMNP-TV-Z]{8}/u);
    const factEvents = makeTaskEventStore({ repoId: "migration-same-id-facts-target", rootDir: destination })
      .read()
      .events.filter(
        (candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.entity.kind === "fact",
      );
    assert.equal(factEvents.length, 2);
    assert.equal(
      new Set(
        factEvents.map((candidate) =>
          candidate.payload.entity.kind === "fact" ? candidate.payload.entity.fact.factId : "",
        ),
      ).size,
      2,
    );
    assert.deepEqual(factEvents.map(({ payload }) => payload.migratedFrom).sort(), [
      "fact/task-alpha/F-DEADBEEF",
      "fact/task-beta/F-DEADBEEF",
    ]);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
