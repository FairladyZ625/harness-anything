// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventStore, makeTaskProjection, sha256Text, stableStringify } from "../../kernel/src/index.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "migration-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("legacy copy -> initialized repository -> migration import -> reconciliation", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-import-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    legacyFixture(source); initRepo(destination); const sourceBefore = snapshot(source);
    cell = await openRepoCell({ repoId: workspaceId("migration-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const before = makeTaskEventStore({ repoId: "migration-target", rootDir: destination }).readHead()?.revision ?? 0, dryRun = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 1, JSON.stringify(dryRun)); assert.equal(makeTaskEventStore({ repoId: "migration-target", rootDir: destination }).readHead()?.revision ?? 0, before); assert.deepEqual(snapshot(source), sourceBefore); assert.match(String(dryRun.summary), /\| task \| 2 \| 1 \| 1 \| 1 \| PASS \|/u); assert.match(String(dryRun.summary), /\| relation \| 2 \| 0 \| 2 \| 2 \| PASS \|/u); assert.match(String(dryRun.summary), /Format validation: 1 skipped/u); assert.match(String(dryRun.summary), /\| task:INDEX\.md \| required \| 1 \| FAIL \|/u);
    const applied = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(applied.exitCode, 1, JSON.stringify(applied)); assert.equal(applied.idMapPath, null); assert.match(String(applied.summary), /Authored reconciliation: FAIL/u); assert.deepEqual(snapshot(source), sourceBefore); assert.equal(makeTaskEventStore({ repoId: "migration-target", rootDir: destination }).readHead()?.revision ?? 0, before);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("authored coverage migrates ordinary documents but blocks an unwired specialized channel before any write", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-coverage-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageGapFixture(source); initRepo(destination); const sourceBefore = snapshot(source);
    cell = await openRepoCell({ repoId: workspaceId("migration-coverage-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const before = makeTaskEventStore({ repoId: "migration-coverage-target", rootDir: destination }).readHead()?.revision ?? 0, result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 1, JSON.stringify(result)); assert.equal(result.outcome, "op_rejected"); assert.equal(makeTaskEventStore({ repoId: "migration-coverage-target", rootDir: destination }).readHead()?.revision ?? 0, before); assert.deepEqual(snapshot(source), sourceBefore);
    assert.match(String(result.summary), /Authored reconciliation: FAIL/u); assert.match(String(result.summary), /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u); assert.match(String(result.summary), /\| objects\/\*\* \| excluded \| 1 \| PASS \|/u); assert.match(String(result.summary), /\| repo-document \| migrated \| 1 \| PASS \|/u); assert.match(String(result.summary), /REQUIRED presets\/\*\*/u); assert.doesNotMatch(String(result.summary), /UNCOVERED/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("non-UTF-8 attachments stay explicit in authored coverage as owner-excluded content", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-binary-attachments-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    binaryAttachmentFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-binary-attachments-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.outcome, "applied"); assert.match(String(result.summary), /\| binary-attachment \| excluded \| 2 \| PASS \| owner decision: binary attachments do not enter the new ledger; the archived source retains the original bytes \|/u);
    assert.equal(statOrNull(path.join(destination, "harness/field-notes/screenshot.png")), null); assert.equal(statOrNull(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/screenshot.png")), null);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a migrated symbolic link preserves its target text and remains a link without dereferencing", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-symbolic-link-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), linkTarget = "../missing.md"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    symbolicLinkFixture(source, linkTarget); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-symbolic-link-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>, target = path.join(destination, "harness/field-notes/latest.md");
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.outcome, "applied"); assert.equal(lstatSync(target).isSymbolicLink(), true); assert.equal(readlinkSync(target), linkTarget); assert.match(git(destination, "ls-tree", "HEAD", "--", "harness/field-notes/latest.md"), /^120000 blob /u);
    const store = makeTaskEventStore({ repoId: "migration-symbolic-link-target", rootDir: destination }), event = store.read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.migratedFrom === "field-notes/latest.md")!; assert.equal(event.payload.entity.kind, "repo-document"); assert.equal((event.payload.entity as { readonly nodeKind?: string }).nodeKind, "symbolic-link"); assert.equal((event.payload.entity as { readonly documentClaim: { readonly sha256: string } }).documentClaim.sha256, sha256Text(linkTarget));
    rmSync(target); store.materialize(); assert.equal(lstatSync(target).isSymbolicLink(), true); assert.equal(readlinkSync(target), linkTarget);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("an authored document in an unfamiliar directory migrates as a repo document", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-document-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-repo-document-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.outcome, "applied"); assert.match(String(result.summary), /\| repo-document \| migrated \| 1 \| PASS \|/u);
    assert.equal(readFileSync(path.join(destination, "harness/field-notes/2024/xyz.md"), "utf8"), "# Field observation\n\nUnknown directories are ordinary authored content.\n");
    const event = makeTaskEventStore({ repoId: "migration-repo-document-target", rootDir: destination }).read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.entity.kind === "repo-document");
    assert.equal(event?.payload.migratedFrom, "field-notes/2024/xyz.md"); assert.equal(event?.payload.entity.kind, "repo-document");
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a different destination document at the same path requires a decision and reports both sides", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-conflict-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), sourceBody = "# Field observation\n\nUnknown directories are ordinary authored content.\n", destinationBody = "# Existing target\n\nKeep this version.\n"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source); initRepo(destination); const target = path.join(destination, "harness/field-notes/2024/xyz.md"); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, destinationBody); git(destination, "add", "."); git(destination, "commit", "-qm", "existing target document");
    cell = await openRepoCell({ repoId: workspaceId("migration-repo-conflict-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 1, JSON.stringify(result)); assert.equal(result.outcome, "op_rejected"); assert.equal(readFileSync(target, "utf8"), destinationBody);
    assert.match(String(result.summary), /REQUIRED field-notes\/2024\/xyz\.md/u); assert.match(String(result.summary), new RegExp(`source sha256=${sha256Text(sourceBody)}.*destination sha256=${sha256Text(destinationBody)}`, "u"));
    const resolution = ["harness/field-notes/2024/xyz.md=source"], preview = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: resolution, dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(preview.exitCode, 0, JSON.stringify(preview)); assert.match(String(preview.summary), /resolved: source/u); assert.equal(readFileSync(target, "utf8"), destinationBody);
    const applied = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: resolution }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(applied.exitCode, 0, JSON.stringify(applied)); assert.equal(readFileSync(target, "utf8"), sourceBody); assert.equal(readdirSync(path.dirname(target)).some((name) => name.includes(".conflict-")), false);
    const event = makeTaskEventStore({ repoId: "migration-repo-conflict-target", rootDir: destination }).read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.migratedFrom === "field-notes/2024/xyz.md")!; assert.equal(event.payload.entity.kind, "repo-document"); assert.deepEqual((event.payload.entity as { readonly destinationPreimage?: unknown }).destinationPreimage, { nodeKind: "file", sha256: sha256Text(destinationBody), size: Buffer.byteLength(destinationBody) });
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("destination resolution keeps the visible target and explicitly accounts for the discarded source", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-destination-resolution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), sourceBody = "# Legacy\n", destinationBody = "# Initialized\n"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { unfamiliarDocumentFixture(source); initRepo(destination); const target = path.join(destination, "harness/field-notes/2024/xyz.md"); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(path.join(source, "harness/field-notes/2024/xyz.md"), sourceBody); writeFileSync(target, destinationBody); git(destination, "add", "."); git(destination, "commit", "-qm", "initialized target"); cell = await openRepoCell({ repoId: workspaceId("migration-destination-resolution"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/field-notes/2024/xyz.md=destination"] }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(readFileSync(target, "utf8"), destinationBody); assert.match(String(result.summary), /\| field-notes\/2024\/xyz\.md \| excluded \| 1 \| PASS \| resolved: destination; discarded source kind=file, source sha256=[0-9a-f]{64}, source bytes=9; kept destination kind=file, destination sha256=[0-9a-f]{64}, destination bytes=14 \|/u);
    assert.equal(makeTaskEventStore({ repoId: "migration-destination-resolution", rootDir: destination }).read().events.some((event) => event.schema === "migration-import-event/v1" && event.payload.migratedFrom === "field-notes/2024/xyz.md"), false);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("source resolution replaces a committed symbolic link without dereferencing or hiding its preimage", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-link-resolution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), sourceTarget = "../legacy.md", destinationTarget = "../initialized.md"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { symbolicLinkFixture(source, sourceTarget); initRepo(destination); const directory = path.join(destination, "harness/field-notes"), target = path.join(directory, "latest.md"); mkdirSync(directory, { recursive: true }); symlinkSync(destinationTarget, target); git(destination, "add", "."); git(destination, "commit", "-qm", "initialized link"); cell = await openRepoCell({ repoId: workspaceId("migration-link-resolution"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/field-notes/latest.md=source"] }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(readlinkSync(target), sourceTarget); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false); assert.match(String(result.summary), /resolved: source; kept source kind=symbolic-link[\s\S]*source link target="\.\.\/legacy\.md"[\s\S]*destination link target="\.\.\/initialized\.md"/u);
    const event = makeTaskEventStore({ repoId: "migration-link-resolution", rootDir: destination }).read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.migratedFrom === "field-notes/latest.md")!; assert.deepEqual((event.payload.entity as { readonly destinationPreimage?: unknown }).destinationPreimage, { nodeKind: "symbolic-link", sha256: sha256Text(destinationTarget), size: Buffer.byteLength(destinationTarget) });
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("source resolution can replace a committed destination link with a regular file", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-file-over-link-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), destinationTarget = "../initialized.md"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { unfamiliarDocumentFixture(source); initRepo(destination); const directory = path.join(destination, "harness/field-notes/2024"), target = path.join(directory, "xyz.md"); mkdirSync(directory, { recursive: true }); symlinkSync(destinationTarget, target); git(destination, "add", "."); git(destination, "commit", "-qm", "initialized link"); cell = await openRepoCell({ repoId: workspaceId("migration-file-over-link"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/field-notes/2024/xyz.md=source"] }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(lstatSync(target).isFile(), true); assert.equal(readFileSync(target, "utf8"), "# Field observation\n\nUnknown directories are ordinary authored content.\n"); assert.equal(readdirSync(directory).some((name) => name.includes(".conflict-")), false);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a destination directory can be kept but cannot be replaced by =source", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-directory-resolution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { unfamiliarDocumentFixture(source); initRepo(destination); const target = path.join(destination, "harness/field-notes/2024/xyz.md"); mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, "kept.md"), "# Kept directory entry\n"); git(destination, "add", "."); git(destination, "commit", "-qm", "directory conflict"); cell = await openRepoCell({ repoId: workspaceId("migration-directory-resolution"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const unsupported = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/field-notes/2024/xyz.md=source"], dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(unsupported.outcome, "op_rejected"); assert.match(String(unsupported.nextAction), /is a directory; =source cannot replace a directory node.*manually.*dry-run/iu); const kept = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/field-notes/2024/xyz.md=destination"], dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(kept.exitCode, 0, JSON.stringify(kept)); assert.match(String(kept.summary), /resolved: destination[\s\S]*destination kind=directory/u); assert.equal(statSync(target).isDirectory(), true);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("resolution declarations reject traversal, duplicates, and paths that are not current conflicts", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-invalid-resolution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { unfamiliarDocumentFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-invalid-resolution"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" }); const run = (resolutions: readonly string[]) => cell!.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions, dryRun: true }, { actor, source: "local" });
    for (const [values, pattern] of [[ ["../outside.md=source"], /normalized repository-relative path/u ], [ ["harness/field-notes/2024/xyz.md=source", "harness/field-notes/2024/xyz.md=destination"], /Duplicate --resolve path/u ], [ ["harness/field-notes/2024/xyz.md=source"], /is not currently a destination conflict/u ]] as const) { const result = await run(values) as Record<string, unknown>; assert.equal(result.outcome, "op_rejected"); assert.match(String(result.nextAction), pattern); }
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("resolution cannot bypass a repository document that is semantically uncarryable", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-invalid-content-resolution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), relative = "field-notes/2024/xyz.md", hash = "a".repeat(64); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { unfamiliarDocumentFixture(source); writeFileSync(path.join(source, "harness", relative), `${JSON.stringify({ attachment: { store: "authored-cas/v1", ref: `harness/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2)}`, sha256: hash, size: 1, mediaType: "text/plain" } })}\n`); initRepo(destination); mkdirSync(path.dirname(path.join(destination, "harness", relative)), { recursive: true }); writeFileSync(path.join(destination, "harness", relative), "different\n"); git(destination, "add", "."); git(destination, "commit", "-qm", "conflicting target"); cell = await openRepoCell({ repoId: workspaceId("migration-invalid-content-resolution"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const required = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.match(String(required.summary), /referenced CAS blob.*missing/u); const rejected = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: [`harness/${relative}=source`], dryRun: true }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(rejected.outcome, "op_rejected"); assert.match(String(rejected.nextAction), /not currently a destination conflict/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a CAS blob referenced by any migrated repo document follows it into the event stream", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-reference-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"), referencedBody = "# Referenced body\n"; let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    referencedDocumentFixture(source, referencedBody); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-repo-reference-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); const store = makeTaskEventStore({ repoId: "migration-repo-reference-target", rootDir: destination }), hash = sha256Text(referencedBody), event = store.read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.migratedFrom === "field-notes/reference.json")!;
    assert.equal(event.payload.entity.kind, "repo-document"); assert.deepEqual((event.payload.entity as { readonly referencedContentClaims: readonly unknown[] }).referencedContentClaims, [{ sha256: hash, size: Buffer.byteLength(referencedBody), mediaType: "text/markdown; charset=utf-8" }]); assert.equal(Buffer.from(store.readContentBlob(hash) ?? []).toString("utf8"), referencedBody);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("migration replays archived executions and UTF-8 task package documents through native projections", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-covered-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-covered-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.outcome, "applied"); assert.match(String(result.summary), /Authored reconciliation: PASS/u); assert.match(String(result.summary), /\| task:executions\/\*\* \| migrated \| 1 \| PASS \|/u); assert.match(String(result.summary), /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u); assert.match(String(result.idMapPath), /^migrations\/import_[0-9a-f_]+\/id-map\.json$/u);
    const tasks = await cell.read("repo.tasks.list"), row = tasks.rows.find(({ taskId }) => taskId === "task_coverage")!, archived = row.snapshot.executions[0] as unknown as Record<string, unknown>; assert.equal(row.generation, "v0"); assert.deepEqual({ schema: archived.schema, generation: archived.generation, state: archived.state, count: row.snapshot.executions.length }, { schema: "archived-execution/v1", generation: "v0", state: "accepted", count: 1 }); assert.deepEqual({ origin: row.executionEvidence[0]?.origin, locator: row.executionEvidence[0]?.outputs[0]?.locator }, { origin: "archival", locator: "artifacts/evidence.html" });
    assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/executions/exe_history.md"), "utf8"), readFileSync(path.join(source, "harness/tasks/task_coverage-old/executions/exe_history.md"), "utf8"), "the native archived execution projection must retain its exact legacy source document");
    const plan = await cell.read("repo.tasks.document.read", { taskId: "task_coverage", path: "task_plan.md" }); assert.equal(plan.body, "# Authored plan\n"); assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/task_plan.md"), "utf8"), plan.body); assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/evidence.html"), "utf8"), "<p>historical evidence</p>\n"); assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/INDEX.md"), "utf8"), "# Artifact index\n"); assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/probe/executions/exe_nested.md"), "utf8"), "# Nested fixture\n");
    const index = await cell.read("repo.tasks.document.read", { taskId: "task_coverage", path: "INDEX.md" }); assert.match(index.body, /## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical/u); assert.match(index.body, /## Migrated source frontmatter[\s\S]*legacyOpaque: keep-this-source-field/u); assert.equal(readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/INDEX.md"), "utf8"), index.body);
    const migrationEvents = makeTaskEventStore({ repoId: "migration-covered-target", rootDir: destination }).read().events.filter((event) => event.schema === "migration-import-event/v1" && ["execution", "task-document"].includes(event.payload.entity.kind)); assert.equal(migrationEvents.length, 5); assert.equal(migrationEvents.every((event) => event.source === "migration-import/v1" && event.payload.generation === "v0"), true);
    const started = await cell.run({ kind: "task-start", taskId: "task_coverage", executionId: "exe_native_after_import" }, { actor, source: "local" }); assert.equal(started.outcome, "applied"); const afterStart = (await cell.read("repo.tasks.list")).rows.find(({ taskId }) => taskId === "task_coverage")!; assert.deepEqual(afterStart.snapshot.executions.map(({ schema }) => schema), ["archived-execution/v1", "execution/v1"]); assert.deepEqual(afterStart.executionEvidence.map(({ origin }) => origin), ["archival", "native"]);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("re-importing a source is an incremental no-op instead of a hard rejection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-twice-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-twice-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const first = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(first.exitCode, 0, JSON.stringify(first)); const firstRevision = first.revision;
    const second = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(second.outcome, "applied"); assert.equal(second.exitCode, 0); assert.equal(second.revision, firstRevision); assert.match(String(second.summary), /Already imported from this Git lineage: task=1/u);
    assert.equal(cell.status().state, "attached", "a repeated import must not latch the workspace");
    const dry = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0); assert.match(String(dry.summary), /Already imported from this Git lineage: task=1/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("decision replay keeps source prose and legacy frontmatter readable beside the native projection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-decision-content-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    decisionContentFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-decision-content-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(result.exitCode, 0, JSON.stringify(result));
    const body = readFileSync(path.join(destination, "harness/decisions/decision-dec_CONTENT/decision.md"), "utf8"); assert.match(body, /Preserve this rationale verbatim\./u); assert.match(body, /## Migrated source frontmatter[\s\S]*contentPins:[\s\S]*sha256:aaaaaaaa/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function legacyFixture(root: string): void { const taskRoot = path.join(root, "harness/tasks/task_legacy-old"), badRoot = path.join(root, "harness/tasks/task_bad"), decisionRoot = path.join(root, "harness/decisions/decision-dec_LEGACY"); mkdirSync(taskRoot, { recursive: true }); mkdirSync(badRoot, { recursive: true }); mkdirSync(decisionRoot, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  writeFileSync(path.join(taskRoot, "INDEX.md"), "---\nschema: task-package/v2\ntask_id: task_legacy\ntitle: Legacy done task\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Legacy done task\n"); writeFileSync(path.join(badRoot, "INDEX.md"), "# missing frontmatter\n");
  writeFileSync(path.join(taskRoot, "facts.md"), "# Facts\n\n- {fact_id: F-ABCDEFGH, statement: Observed migration, source: legacy-test, observedAt: 2026-01-02T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T00:00:00.000Z}]}\n- {fact_id: F-MGRATEDX, statement: Archived execution evidence, source: legacy-test, observedAt: 2026-01-02T12:00:00.000Z, confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T12:00:00.000Z}], migration: {schema: fact-migration/v1, state: migrated, plan_id: fxm_test, execution_ref: execution/task_legacy/exe_test, evidence_id: fact-migration:fxm_test:F-MGRATEDX, migrated_at: 2026-01-04T00:00:00.000Z}}\n");
  const relation = { relation_id: deriveRelationId({ source: "decision/dec_LEGACY/C1", target: "fact/task_legacy/F-ABCDEFGH", type: "evidenced-by", direction: "directed" }), source: "decision/dec_LEGACY/C1", target: "fact/task_legacy/F-ABCDEFGH", type: "evidenced-by", strength: "strong", direction: "directed", origin: "declared", rationale: "Legacy observation supports the claim.", state: "active" };
  const migratedFactRelation = { relation_id: deriveRelationId({ source: "decision/dec_LEGACY/C1", target: "fact/task_legacy/F-MGRATEDX", type: "evidenced-by", direction: "directed" }), source: "decision/dec_LEGACY/C1", target: "fact/task_legacy/F-MGRATEDX", type: "evidenced-by", strength: "strong", direction: "directed", origin: "declared", rationale: "The historical relation keeps its migrated fact endpoint resolvable.", state: "retired" };
  writeFileSync(path.join(decisionRoot, "decision.md"), `---\nschema: decision-package/v1\ndecision_id: dec_LEGACY\nworkspaceRevision: 7\ntitle: "Legacy decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":["harness"]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\nquestion: "Should the history migrate?"\nchosen: [{"id":"CH1","text":"Migrate it"}]\nrejected: [{"id":"RJ1","text":"Drop it","whyNot":"History is required"}]\nclaims: [{"id":"C1","text":"History remains auditable","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify([relation, migratedFactRelation])}\n---\n\n# Legacy decision\n\nPreserved prose.\n`); }
function coverageGapFixture(root: string): void { coverageCompleteFixture(root); const taskRoot = path.join(root, "harness/tasks/task_coverage-old"), mysteryRoot = path.join(root, "harness/mystery"), objectsRoot = path.join(root, "harness/objects/sha256/aa"), presetRoot = path.join(root, "harness/presets/example"); mkdirSync(mysteryRoot, { recursive: true }); mkdirSync(objectsRoot, { recursive: true }); mkdirSync(presetRoot, { recursive: true }); writeFileSync(path.join(taskRoot, "task_plan.md"), "# Authored plan\n"); writeFileSync(path.join(mysteryRoot, "orphan.md"), "# This path has no migration rule\n"); writeFileSync(path.join(objectsRoot, "blob"), "rebuildable CAS\n"); writeFileSync(path.join(presetRoot, "preset.json"), '{"schema":"harness-preset/v1"}\n'); }
function unfamiliarDocumentFixture(root: string): void { const notes = path.join(root, "harness/field-notes/2024"); mkdirSync(notes, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(notes, "xyz.md"), "# Field observation\n\nUnknown directories are ordinary authored content.\n"); }
function referencedDocumentFixture(root: string, referencedBody: string): void { const hash = sha256Text(referencedBody), notes = path.join(root, "harness/field-notes"), objects = path.join(root, `harness/objects/sha256/${hash.slice(0, 2)}`); mkdirSync(notes, { recursive: true }); mkdirSync(objects, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(notes, "reference.json"), `${JSON.stringify({ schema: "unfamiliar-record/v1", nested: { attachment: { store: "authored-cas/v1", ref: `harness/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2)}`, sha256: hash, size: Buffer.byteLength(referencedBody), mediaType: "text/markdown; charset=utf-8" } } }, null, 2)}\n`); writeFileSync(path.join(objects, hash.slice(2)), referencedBody); }
function binaryAttachmentFixture(root: string): void { coverageCompleteFixture(root); const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]), notes = path.join(root, "harness/field-notes"), artifacts = path.join(root, "harness/tasks/task_coverage-old/artifacts"); mkdirSync(notes, { recursive: true }); writeFileSync(path.join(notes, "screenshot.png"), bytes); writeFileSync(path.join(artifacts, "screenshot.png"), bytes); }
function symbolicLinkFixture(root: string, linkTarget: string): void { const notes = path.join(root, "harness/field-notes"); mkdirSync(notes, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); symlinkSync(linkTarget, path.join(notes, "latest.md")); }
function coverageCompleteFixture(root: string): void { const taskRoot = path.join(root, "harness/tasks/task_coverage-old"), artifactRoot = path.join(taskRoot, "artifacts"), executionRoot = path.join(taskRoot, "executions"), nestedExecutionRoot = path.join(artifactRoot, "probe/executions"); mkdirSync(artifactRoot, { recursive: true }); mkdirSync(executionRoot, { recursive: true }); mkdirSync(nestedExecutionRoot, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(taskRoot, "INDEX.md"), "---\nschema: task-package/v2\ntask_id: task_coverage\ntitle: Coverage fixture\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nlegacyOpaque: keep-this-source-field\n---\n\n# Coverage fixture\n\n## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical\n"); writeFileSync(path.join(taskRoot, "task_plan.md"), "# Authored plan\n"); writeFileSync(path.join(artifactRoot, "evidence.html"), "<p>historical evidence</p>\n"); writeFileSync(path.join(artifactRoot, "INDEX.md"), "# Artifact index\n"); writeFileSync(path.join(nestedExecutionRoot, "exe_nested.md"), "# Nested fixture\n"); writeFileSync(path.join(executionRoot, "exe_history.md"), `${JSON.stringify({ schema: "execution/v2", execution_id: "exe_history", task_ref: "task/task_coverage", state: "accepted", primary_actor: { principal: { personId: "person_historical" }, executor: { kind: "agent", id: "legacy-agent" }, responsibleHuman: "person:historical" }, claimed_at: "2026-01-02T00:00:00.000Z", submitted_at: "2026-01-03T00:00:00.000Z", closed_at: "2026-01-04T00:00:00.000Z", session_bindings: [], outputs: [{ evidence_id: "legacy-output", execution_ref: "execution/task_coverage/exe_history", locator: { substrate: "file", path: "artifacts/evidence.html" } }], submission: { completion_claim: "Historical work completed.", deliverables: ["evidence"], evidence_refs: ["legacy-output"], verification_notes: ["legacy verification"], known_gaps: [], residual_risks: [] } }, null, 2)}\n`); }
function decisionContentFixture(root: string): void { const decisionRoot = path.join(root, "harness/decisions/decision-dec_CONTENT"); mkdirSync(decisionRoot, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(decisionRoot, "decision.md"), `---\nschema: decision-package/v1\ndecision_id: dec_CONTENT\nworkspaceRevision: 3\ntitle: "Content decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\napplies_to: {"modules":[],"productLines":[]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\ncontentPins:\n  - { action: "accept", digest: "sha256:aaaaaaaa" }\nprovenance:\n  - { runtime: "codex", sessionId: "legacy-session", boundAt: "2026-01-01T12:00:00.000Z" }\nquestion: "Will every source field remain readable?"\nchosen: [{"id":"CH1","text":"Preserve it"}]\nrejected: [{"id":"RJ1","text":"Drop it","whyNot":"Information matters"}]\nclaims: [{"id":"C1","text":"The source survives","loadBearing":false}]\nrelations:\n---\n\n# Content decision\n\nPreserve this rationale verbatim.\n`); }
// `ha init` always writes both harness.yaml and people.yaml, so a destination fixture without a roster
// cannot reproduce what a real migration lands on.
const bootstrapPerson = { personId: "person_zeyu", displayName: "Zeyu Li", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:MacBook-Pro.local", subject: "501" }] } as const;
function bootstrapRoster(people: readonly Readonly<Record<string, unknown>>[] = [bootstrapPerson]): string { return `${JSON.stringify({ schema: "harness-people/v1", people, roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`; }
const legacyRoster = `schema: harness-people/v1
people:
  - personId: person_zeyu
    displayName: "Zeyu Li"
    primaryEmail: "lizeyu990625@gmail.com"
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:MacBook-Pro.local
        subject: 501
  - personId: person_dingwen
    displayName: "Dingwen"
    roles: [owner]
    credentials:
      - kind: email-address
        issuer: example.invalid
        subject: dingwen@example.invalid
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`;

test("a destination roster and a source roster both survive the migration without an operator decision", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-union-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source); writeFileSync(path.join(source, "harness/people.yaml"), legacyRoster); initRepo(destination);
    cell = await openRepoCell({ repoId: workspaceId("migration-people-union"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.outcome, "applied");
    assert.match(String(result.summary), /\| people-registry \| migrated \| 1 \| PASS \| unioned both rosters into the destination: 2 people \(1 carried from the source: person_dingwen, 1 enriched in place: person_zeyu\), 1 roles \(0 carried from the source\) \|/u);
    const roster = peopleRosterFromDocument(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"));
    assert.deepEqual(roster.people.map(({ personId }) => personId), ["person_zeyu", "person_dingwen"]);
    assert.equal(roster.people[0]!.primaryEmail, "lizeyu990625@gmail.com");
    assert.deepEqual([...roster.people[0]!.credentials], [...bootstrapPerson.credentials]);
    assert.equal(git(destination, "status", "--porcelain", "--", "harness"), "");
    const event = makeTaskEventStore({ repoId: "migration-people-union", rootDir: destination }).read().events.find((candidate) => candidate.schema === "migration-import-event/v1" && candidate.payload.migratedFrom === "people.yaml")!;
    assert.deepEqual((event.payload.entity as { readonly destinationPreimage?: unknown }).destinationPreimage, { nodeKind: "file", sha256: sha256Text(bootstrapRoster()), size: Buffer.byteLength(bootstrapRoster()) });
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a roster the destination already covers is reported as covered rather than rewritten", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-covered-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source); writeFileSync(path.join(source, "harness/people.yaml"), legacyRoster.replace(/^ +primaryEmail:.*\n/mu, "")); initRepo(destination, bootstrapRoster([bootstrapPerson, { personId: "person_dingwen", displayName: "Dingwen", roles: ["owner"], credentials: [{ kind: "email-address", issuer: "example.invalid", subject: "dingwen@example.invalid" }] }]));
    const before = readFileSync(path.join(destination, "harness/people.yaml"), "utf8");
    cell = await openRepoCell({ repoId: workspaceId("migration-people-covered"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.match(String(result.summary), /\| people-registry \| excluded \| 1 \| PASS \| the destination roster already contains every source entry/u);
    assert.equal(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"), before);
    assert.equal(makeTaskEventStore({ repoId: "migration-people-covered", rootDir: destination }).read().events.some((event) => event.schema === "migration-import-event/v1" && event.payload.migratedFrom === "people.yaml"), false);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("rosters that genuinely contradict still stop, name the contradiction, and keep the explicit resolution", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-people-contradiction-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    unfamiliarDocumentFixture(source); writeFileSync(path.join(source, "harness/people.yaml"), legacyRoster.replace('displayName: "Zeyu Li"\n    primaryEmail', 'displayName: "Li Zeyu"\n    primaryEmail')); initRepo(destination);
    cell = await openRepoCell({ repoId: workspaceId("migration-people-contradiction"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const blocked = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(blocked.exitCode, 1, JSON.stringify(blocked)); assert.match(String(blocked.summary), /REQUIRED people\.yaml/u);
    assert.match(String(blocked.summary), /the two rosters cannot be unioned: person person_zeyu declares a different displayName on each side.*resolve with --resolve harness\/people\.yaml=destination\|source/u);
    const resolved = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), resolutions: ["harness/people.yaml=destination"] }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(resolved.exitCode, 0, JSON.stringify(resolved)); assert.equal(readFileSync(path.join(destination, "harness/people.yaml"), "utf8"), bootstrapRoster());
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("two independent Git sources merge incrementally with explicit id remaps and deterministic cold rebuilds", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-multi-source-")), firstSource = path.join(scratch, "first"), secondSource = path.join(scratch, "second"), destination = path.join(scratch, "center"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    multiSourceFixture(firstSource, "alpha", "person_alpha"); multiSourceFixture(secondSource, "beta", "person_beta"); initRepo(destination);
    cell = await openRepoCell({ repoId: workspaceId("migration-multi-source-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-08-19T00:00:00.000Z" });
    const result = await cell.run({ kind: "migrate-import", sourceRoots: [...sources(firstSource), ...sources(secondSource)] }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.match(String(result.summary), /Migration import batch \(2\/2 sources processed\)/u); assert.match(String(result.summary), /REMAP task task_shared -> task_shared__[0-9a-f]{10}/u); assert.match(String(result.summary), /REMAP decision dec_SHARED -> dec_SHARED__[0-9a-f]{10}/u);
    const events = makeTaskEventStore({ repoId: "migration-multi-source-target", rootDir: destination }).read().events.filter((event) => event.schema === "migration-import-event/v1"), tasks = events.filter((event) => event.payload.entity.kind === "task" && event.payload.migratedFrom === "task_shared"), decisions = events.filter((event) => event.payload.entity.kind === "decision" && event.payload.migratedFrom === "dec_SHARED");
    assert.equal(tasks.length, 2); assert.equal(new Set(tasks.map(({ opId }) => opId)).size, 2); assert.deepEqual(tasks.map((event) => event.payload.entity.kind === "task" ? event.payload.entity.task.taskId : "").sort(), ["task_shared", tasks.map((event) => event.payload.entity.kind === "task" ? event.payload.entity.task.taskId : "").find((taskId) => taskId.startsWith("task_shared__"))!].sort());
    assert.equal(decisions.length, 2); assert.equal(new Set(decisions.map(({ opId }) => opId)).size, 2);
    const maps = readdirSync(path.join(destination, "harness/migrations"), { recursive: true }).filter((entry) => String(entry).endsWith("id-map.json")).map((entry) => JSON.parse(readFileSync(path.join(destination, "harness/migrations", String(entry)), "utf8")) as { readonly sourceGit: { readonly rootCommit: string }; readonly remappings: readonly { readonly entityType: string; readonly sourceId: string; readonly targetId: string }[] });
    assert.equal(maps.length, 2); assert.equal(new Set(maps.map(({ sourceGit }) => sourceGit.rootCommit)).size, 2); assert.equal(maps.flatMap(({ remappings }) => remappings).some(({ entityType, sourceId, targetId }) => entityType === "task" && sourceId === "task_shared" && targetId.startsWith("task_shared__")), true);
    const roster = peopleRosterFromDocument(readFileSync(path.join(destination, "harness/people.yaml"), "utf8")); assert.deepEqual(roster.people.map(({ personId }) => personId), ["person_zeyu", "person_alpha", "person_beta"]);
    const revision = result.revision, repeated = await cell.run({ kind: "migrate-import", sourceRoots: [firstSource, secondSource] }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(repeated.exitCode, 0, JSON.stringify(repeated)); assert.equal(repeated.revision, revision); assert.match(String(repeated.summary), /Already imported from this Git lineage: task=1, decision=1, fact=1, relation=1/u);
    await cell.close(); cell = undefined;
    const store = makeTaskEventStore({ repoId: "migration-multi-source-target", rootDir: destination }), digest = (projectionPath: string): string => { const projection = makeTaskProjection({ rootDir: destination, eventStore: store, projectionPath, now: () => "2026-08-19T00:00:00.000Z" }); try { projection.rebuild(); return sha256Text(stableStringify({ tasks: projection.list(), decisions: projection.listDecisions({}), decisionGraph: projection.readDecisionGraph(), facts: projection.readFactGraph() })); } finally { projection.close(); } };
    assert.equal(digest(path.join(scratch, "cold-one.sqlite")), digest(path.join(scratch, "cold-two.sqlite")));
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("migration rejects dirty, shallow, and multi-root Git sources before any event write", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-git-validation-")), source = path.join(scratch, "source"), shallow = path.join(scratch, "shallow"), destination = path.join(scratch, "center"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    multiSourceFixture(source, "alpha", "person_alpha"); sources(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-git-validation"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-08-19T00:00:00.000Z" });
    writeFileSync(path.join(source, "uncommitted.txt"), "not part of the source cut\n"); const dirty = await cell.run({ kind: "migrate-import", sourceRoots: [source] }, { actor, source: "local" }); assert.equal(dirty.outcome, "op_rejected"); assert.equal(dirty.code, "invalid_migration_source_git"); assert.match(String(dirty.nextAction), /not the committed authored Git snapshot.*Commit or discard every tracked and untracked authored change/u); assert.equal(makeTaskEventStore({ repoId: "migration-git-validation", rootDir: destination }).readHead()?.revision ?? 0, 0);
    rmSync(path.join(source, "uncommitted.txt")); execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source}`, shallow]); const rejected = await cell.run({ kind: "migrate-import", sourceRoots: [shallow] }, { actor, source: "local" }); assert.equal(rejected.outcome, "op_rejected"); assert.equal(rejected.code, "invalid_migration_source_git"); assert.match(String(rejected.nextAction), /shallow authored Git repository.*Fetch complete history/u);
    const unrelatedRoot = git(source, "commit-tree", git(source, "rev-parse", "HEAD^{tree}"), "-m", "unrelated root"); git(source, "merge", "-q", "--allow-unrelated-histories", unrelatedRoot, "-m", "merge unrelated root"); const split = await cell.run({ kind: "migrate-import", sourceRoots: [source] }, { actor, source: "local" }); assert.equal(split.outcome, "op_rejected"); assert.equal(split.code, "invalid_migration_source_git"); assert.match(String(split.nextAction), /2 authored Git root commits.*split unrelated histories/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("multi-source dry-run fails closed instead of hiding later-source conflicts", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-multi-dry-run-")), first = path.join(scratch, "first"), second = path.join(scratch, "second"), destination = path.join(scratch, "center"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try { multiSourceFixture(first, "alpha", "person_alpha"); multiSourceFixture(second, "beta", "person_beta"); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-multi-dry-run"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-08-19T00:00:00.000Z" }); const result = await cell.run({ kind: "migrate-import", sourceRoots: [...sources(first), ...sources(second)], dryRun: true }, { actor, source: "local" }); assert.equal(result.outcome, "op_rejected"); assert.equal(result.code, "multi_source_dry_run_requires_staging"); assert.match(String(result.nextAction), /cannot truthfully predict later-source document and id conflicts.*disposable initialized center/u); }
  finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function initRepo(root: string, roster: string = bootstrapRoster()): void { mkdirSync(root, { recursive: true }); git(root, "init", "-q"); git(root, "config", "user.name", "Migration Test"); git(root, "config", "user.email", "migration@example.invalid"); mkdirSync(path.join(root, "harness"), { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(root, "harness/people.yaml"), roster); git(root, "add", "."); git(root, "commit", "-qm", "initialized"); }
function multiSourceFixture(root: string, label: string, personId: string): void { const taskRoot = path.join(root, `harness/tasks/task_shared-${label}`), decisionRoot = path.join(root, "harness/decisions/decision-dec_SHARED"); mkdirSync(taskRoot, { recursive: true }); mkdirSync(decisionRoot, { recursive: true }); writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n"); writeFileSync(path.join(root, "harness/people.yaml"), bootstrapRoster([bootstrapPerson, { personId, displayName: label, roles: ["owner"], credentials: [{ kind: "email-address", issuer: "example.invalid", subject: `${label}@example.invalid` }] }])); writeFileSync(path.join(taskRoot, "INDEX.md"), `---\nschema: task-package/v2\ntask_id: task_shared\ntitle: Shared ${label}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-08-19T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# Shared ${label}\n`); writeFileSync(path.join(taskRoot, "facts.md"), `# Facts\n\n- {fact_id: F-ABCDEFGH, statement: ${label} observation, source: ${label}-source, observedAt: 2026-08-19T00:00:01.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: ${label}-session, boundAt: 2026-08-19T00:00:01.000Z}]}\n`); const relation = { relation_id: deriveRelationId({ source: "decision/dec_SHARED/C1", target: "fact/task_shared/F-ABCDEFGH", type: "evidenced-by", direction: "directed" }), source: "decision/dec_SHARED/C1", target: "fact/task_shared/F-ABCDEFGH", type: "evidenced-by", strength: "strong", direction: "directed", origin: "declared", rationale: `${label} evidence`, state: "active" }; writeFileSync(path.join(decisionRoot, "decision.md"), `---\nschema: decision-package/v1\ndecision_id: dec_SHARED\nworkspaceRevision: 1\ntitle: "Shared ${label} decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["daemon"],"productLines":["harness"]}\nproposedAt: "2026-08-19T00:00:00.000Z"\ndecidedAt: "2026-08-19T00:00:02.000Z"\nquestion: "Keep ${label}?"\nchosen: [{"id":"CH1","text":"Keep ${label}"}]\nrejected: [{"id":"RJ1","text":"Drop ${label}","whyNot":"History matters"}]\nclaims: [{"id":"C1","text":"${label} survives","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify([relation])}\n---\n\n# Shared ${label} decision\n`); }
function sources(root: string): readonly string[] { if (!statOrNull(path.join(root, ".git"))) { git(root, "init", "-q"); git(root, "config", "user.name", "Migration Source"); git(root, "config", "user.email", "migration-source@example.invalid"); } git(root, "add", "."); if (git(root, "diff", "--cached", "--name-only") !== "") git(root, "commit", "-qm", "source snapshot"); return [root]; }
function snapshot(root: string): readonly string[] { const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { if (entry.name === ".git") return []; const target = path.join(dir, entry.name); return entry.isDirectory() ? walk(target) : [`${path.relative(root, target)}:${statSync(target).size}:${readFileSync(target, "utf8")}`]; }); return walk(root).sort(); }
function statOrNull(target: string): ReturnType<typeof statSync> | null { try { return statSync(target); } catch { return null; } }
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }

test("task hierarchy and task-side relations replay into the event stream", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-hierarchy-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    hierarchyFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-hierarchy-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const dryRun = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun));
    assert.match(String(dryRun.summary), /\| task \| 2 \| 0 \| 2 \| 2 \| PASS \|/u);
    assert.match(String(dryRun.summary), /\| relation \| 1 \| 0 \| 1 \| 1 \| PASS \|/u);

    const applied = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>; assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    const events = makeTaskEventStore({ repoId: "migration-hierarchy-target", rootDir: destination }).read().events.filter((event) => event.schema === "migration-import-event/v1");
    const child = events.find((event) => event.payload.entity.kind === "task" && event.payload.entity.task.taskId === "task_child")!;
    assert.equal((child.payload.entity as { readonly task: { readonly metadata?: { readonly parentTaskId?: string | null } } }).task.metadata?.parentTaskId, "task_parent", "child task must carry its parent binding in the event payload");
    const relations = events.filter((event) => event.payload.entity.kind === "relation").map((event) => (event.payload.entity as { readonly relation: { readonly source: string; readonly target: string; readonly type: string } }).relation);
    assert.deepEqual(relations.map(({ source: from, target, type }) => `${from} ${type} ${target}`), ["task/task_child depends-on task/task_parent"]);

    const rows = (await cell.read("repo.tasks.list")).rows; assert.equal(rows.find(({ taskId }) => taskId === "task_child")!.placement.parentTaskId, "task_parent");
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function hierarchyFixture(root: string): void {
  const parentRoot = path.join(root, "harness/tasks/task_parent-root"), childRoot = path.join(root, "harness/tasks/task_child-leaf");
  mkdirSync(parentRoot, { recursive: true }); mkdirSync(childRoot, { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const frontmatter = (taskId: string, title: string, extra: string): string => `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${title}\n${extra}lifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`;
  writeFileSync(path.join(parentRoot, "INDEX.md"), frontmatter("task_parent", "Parent milestone", ""));
  const relation = { relation_id: deriveRelationId({ source: "task/task_child", target: "task/task_parent", type: "depends-on", direction: "directed" }), source: "task/task_child", target: "task/task_parent", type: "depends-on", strength: "strong", direction: "directed", origin: "declared", rationale: "The child cannot start before the parent lands.", state: "active" };
  writeFileSync(path.join(childRoot, "INDEX.md"), frontmatter("task_child", "Child work", `parent: task_parent\nrelations: ${JSON.stringify([relation])}\n`));
}

test("relations the current matrix rejects are skipped with a reason instead of migrating", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-illegal-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    illegalRelationFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-illegal-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const dryRun = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 3, JSON.stringify(dryRun));
    assert.match(String(dryRun.summary), /\| relation \| 2 \| 1 \| 1 \| 1 \| PASS \|/u);
    assert.match(String(dryRun.summary), /Format validation: 1 skipped/u);
    assert.match(String(dryRun.summary), /type supports is not allowed for decision->fact/u);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function illegalRelationFixture(root: string): void {
  const taskRoot = path.join(root, "harness/tasks/task_evidence-holder"), decisionRoot = path.join(root, "harness/decisions/decision-dec_MATRIX");
  mkdirSync(taskRoot, { recursive: true }); mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  writeFileSync(path.join(taskRoot, "INDEX.md"), "---\nschema: task-package/v2\ntask_id: task_evidence\ntitle: Evidence holder\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Evidence holder\n");
  writeFileSync(path.join(taskRoot, "facts.md"), "# Facts\n\n- {fact_id: F-ABCDEFGH, statement: Observed migration, source: legacy-test, observedAt: 2026-01-02T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-01-02T00:00:00.000Z}]}\n");
  const edge = (type: string, rationale: string) => ({ relation_id: deriveRelationId({ source: "decision/dec_MATRIX/C1", target: "fact/task_evidence/F-ABCDEFGH", type, direction: "directed" }), source: "decision/dec_MATRIX/C1", target: "fact/task_evidence/F-ABCDEFGH", type, strength: "strong", direction: "directed", origin: "declared", rationale, state: "active" });
  // `supports` was the pre-2026-07-05 spelling of this edge; the current matrix only accepts evidenced-by.
  const relations = [edge("evidenced-by", "The observation evidences the claim."), edge("supports", "Legacy spelling of the same evidence edge.")];
  writeFileSync(path.join(decisionRoot, "decision.md"), `---\nschema: decision-package/v1\ndecision_id: dec_MATRIX\nworkspaceRevision: 3\ntitle: "Matrix decision"\nstate: active\nriskTier: medium\nurgency: medium\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":["harness"]}\nproposedAt: "2026-01-01T12:00:00.000Z"\ndecidedAt: "2026-01-03T00:00:00.000Z"\nquestion: "Does the matrix hold?"\nchosen: [{"id":"CH1","text":"Hold it"}]\nrejected: [{"id":"RJ1","text":"Widen it","whyNot":"Historical dirt must not become product logic"}]\nclaims: [{"id":"C1","text":"Only allowed triples migrate","loadBearing":true,"fulfillment":"evidenced"}]\nrelations: ${JSON.stringify(relations)}\n---\n\n# Matrix decision\n\nPreserved prose.\n`);
}

test("a relation whose endpoint entity never migrates is reported, not dropped in silence", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-orphan-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    orphanEndpointFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-orphan-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const dryRun = await cell.run({ kind: "migrate-import", sourceRoots: sources(source), dryRun: true }, { actor, source: "local" }) as Record<string, unknown>;
    // old counts the edge, and it cannot be produced because its endpoint task is skipped.
    // Either it is accounted for as a skip, or the reconciliation must fail — never a silent drop.
    assert.match(String(dryRun.summary), /\| relation \| 1 \| 1 \| 0 \| 0 \| PASS \|/u, String(dryRun.summary));
    assert.match(String(dryRun.summary), /SKIP relation/u, String(dryRun.summary));
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function orphanEndpointFixture(root: string): void {
  const goodRoot = path.join(root, "harness/tasks/task_good"), orphanRoot = path.join(root, "harness/tasks/task_orphan");
  mkdirSync(goodRoot, { recursive: true }); mkdirSync(orphanRoot, { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const relation = { relation_id: deriveRelationId({ source: "task/task_good", target: "task/task_orphan", type: "depends-on", direction: "directed" }), source: "task/task_good", target: "task/task_orphan", type: "depends-on", strength: "strong", direction: "directed", origin: "declared", rationale: "The good task depends on a package that cannot migrate.", state: "active" };
  writeFileSync(path.join(goodRoot, "INDEX.md"), `---\nschema: task-package/v2\ntask_id: task_good\ntitle: Good task\nrelations: ${JSON.stringify([relation])}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# Good task\n`);
  writeFileSync(path.join(orphanRoot, "INDEX.md"), "# missing frontmatter so this package cannot migrate\n");
}

test("migrated entities keep the actor recorded in the source repository, not the importer", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-attribution-")), source = path.join(scratch, "legacy"), destination = path.join(scratch, "new"); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    attributionFixture(source); initRepo(destination); cell = await openRepoCell({ repoId: workspaceId("migration-attribution-target"), rootDir: canonicalRoot(destination), ownerId: "migration-daemon", now: () => "2026-06-01T00:00:00.000Z" });
    const applied = await cell.run({ kind: "migrate-import", sourceRoots: sources(source) }, { actor, source: "local" }) as Record<string, unknown>;
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    // task_owned has an attribution record; task_unowned has none and falls back to the importer.
    // Both must be non-zero, otherwise the index is either ignored or applied blindly.
    assert.match(String(applied.summary), /Attribution: principal restored from source records for [1-9]\d* entities, [1-9]\d* fell back/u, String(applied.summary)); assert.match(String(applied.summary), /\| source-authority-attribution \| excluded \| 1 \| PASS \|/u);
    const events = makeTaskEventStore({ repoId: "migration-attribution-target", rootDir: destination }).read().events.filter((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task");
    const seen = Object.fromEntries(events.map((event) => [(event.payload.entity as { readonly task: { readonly taskId: string } }).task.taskId, event.actor]));
    // The person is the one the source recorded; the executor is whoever ran this import.
    assert.deepEqual(seen.task_owned, { principal: { personId: "person_original" }, executor: { kind: "agent", id: "codex" } });
    assert.deepEqual(seen.task_unowned, actor);
  } finally { await cell?.close(); rmSync(scratch, { recursive: true, force: true }); }
});

function attributionFixture(root: string): void {
  const owned = path.join(root, "harness/tasks/task_owned"), unowned = path.join(root, "harness/tasks/task_unowned"), attribution = path.join(root, "harness/attribution-events"), authorityWitnesses = path.join(root, "harness/audit-witnesses");
  mkdirSync(owned, { recursive: true }); mkdirSync(unowned, { recursive: true }); mkdirSync(attribution, { recursive: true }); mkdirSync(authorityWitnesses, { recursive: true });
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  const pkg = (taskId: string, title: string): string => `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${title}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-01-01T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`;
  writeFileSync(path.join(owned, "INDEX.md"), pkg("task_owned", "Task with recorded attribution"));
  writeFileSync(path.join(unowned, "INDEX.md"), pkg("task_unowned", "Task with no attribution record"));
  // The earliest record for an entity is its creation attribution. `principal.kind` exists in the
  // legacy shape and must be dropped: the current identity contract accepts personId only.
  const line = (at: string, executorId: string): string => JSON.stringify({ schema: "attribution-event/v1", entityId: "task/task_owned", kind: "package_create", actor: { principal: { kind: "person", personId: "person_original" }, executor: { kind: "agent", id: executorId } }, at });
  writeFileSync(path.join(attribution, "aa.jsonl"), `${line("2026-01-05T00:00:00.000Z", "later-agent")}\n${line("2026-01-01T00:00:00.000Z", "codex")}\n`);
  writeFileSync(path.join(authorityWitnesses, "authority.jsonl"), `${JSON.stringify({ schema: "attribution-event/v2", mutationSet: { mutations: [] }, actorAxesBinding: { principalPersonId: "person_original" } })}\n`);
}
