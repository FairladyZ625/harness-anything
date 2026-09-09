// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DOC_SYNC_INLINE_MAX_BYTES,
  DOC_POLICY_ID,
  makeTaskEventReader,
  makeTaskProjection,
  parseDocWriteIntent,
  sha256Text,
} from "../../kernel/src/index.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { detail, touch } from "../src/doc-sync-details.ts";
import { scanAuthoredCandidateInventory, scanDocCandidates } from "../src/doc-sync-candidate-scanner.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, git, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

test("HTML research documents are eligible, submit as opaque text, and become clean", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-html-research-"));
  initRepo(rootDir);
  const logical = "context/research/2026-09-05-foundation-audit/index.html",
    body = "<!doctype html>\n<title>Foundation audit</title>\n<p>canonical HTML</p>\n",
    repoId = workspaceId("html-research"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "html-research-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, logical, body);
    const dryRun = await cell.run({ kind: "doc-dry-run", paths: [logical] }, binding);
    assert.equal(dryRun.outcome, "pending", JSON.stringify(dryRun));
    assert.deepEqual(
      rows(dryRun.evidence).map((row) => [row.path, row.state, row.mediaType]),
      [[logical, "eligible", "text/html"]],
    );
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForWorktree(cell, submitted);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      const change = event.payload.changes[0]!;
      assert.equal(change.policyId, OPAQUE_TEXTUAL_POLICY_ID);
      assert.deepEqual(change.candidate, {
        sha256: sha256Text(body),
        size: Buffer.byteLength(body),
        mediaType: "text/html",
      });
    }
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), body);
    const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [[logical, "clean"]],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("status, dry-run, and submit share the repeatable-path scanner and automatic base", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-scanner-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("scanner"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "scanner-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/a.md", "# A\n\nfirst\n");
    write(rootDir, "context/b.md", "# B\n\nsecond\n");
    write(rootDir, "tasks/task-one/progress.md", "# Progress\n");
    write(rootDir, "tasks/task-one/artifacts/data.json", "{}\n");
    write(rootDir, "context/ignored.json", "{}\n");
    const before = git(rootDir, "rev-parse", "HEAD"),
      status = await cell.run({ kind: "doc-status", paths: [] }, binding),
      statusRows = rows(status.evidence);
    assert.deepEqual(
      statusRows.map((row) => [row.path, row.state]),
      [
        ["context/a.md", "eligible"],
        ["context/b.md", "eligible"],
        ["context/ignored.json", "blocked"],
        ["tasks/task-one/artifacts/data.json", "blocked"],
        ["tasks/task-one/progress.md", "blocked"],
      ],
    );
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const dry = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md", "context/b.md"] }, binding);
    assert.equal(dry.outcome, "pending");
    assert.equal(dry.acceptance, undefined);
    assert.equal(dry.proof?.durable, false);
    assert.equal(dry.proof?.canonicalVisible, false);
    assert.deepEqual(rows(dry.evidence), statusRows.slice(0, 2));
    assert.equal(git(rootDir, "rev-parse", "HEAD"), before);
    const submitted = await cell.run({ kind: "doc-submit", paths: ["context/a.md", "context/b.md"] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.match(String((submitted as Record<string, unknown>).summary), /applied count: 2/u);
    assert.equal(submitted.commitSha, null);
    await waitForWorktree(cell, submitted);
    const event = makeTaskEventReader({ repoId: "scanner", rootDir }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.deepEqual(
        event.payload.baseLedgerSha,
        (
          JSON.parse(status.evidence!.slice("doc-scan:".length)) as {
            baseLedgerSha: unknown;
          }
        ).baseLedgerSha,
      );
      assert.equal(event.payload.executionId, null);
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        ["context/a.md", "context/b.md"],
      );
    }
    assert.equal(git(rootDir, "show", "HEAD:harness/context/a.md"), "# A\n\nfirst");
    assert.equal(readFileSync(path.join(rootDir, "harness/context/a.md"), "utf8"), "# A\n\nfirst\n");
    assert.equal(git(rootDir, "ls-files", "harness/context/a.md"), "harness/context/a.md");
    const untracked = git(rootDir, "ls-files", "--others", "--exclude-standard", "harness").split("\n");
    for (const expected of [
      "harness/context/ignored.json",
      "harness/tasks/task-one/artifacts/data.json",
      "harness/tasks/task-one/progress.md",
    ])
      assert.equal(untracked.includes(expected), true, `${expected} must remain outside the submitted cut`);
    write(rootDir, "context/a.md", "# Renamed\n\nfirst\n");
    const renamed = await cell.run({ kind: "doc-dry-run", paths: ["context/a.md"] }, binding);
    assert.equal(rows(renamed.evidence)[0]?.state, "eligible");
    const accepted = await cell.run({ kind: "doc-submit", paths: ["context/a.md"] }, binding);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("large projections do not expand dirty or missing-path candidate scans", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-bounded-scan-"));
  initRepo(rootDir);
  const repoId = workspaceId("bounded-scan"),
    taskId = "task-bounded-scan",
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "bounded-scan-daemon" }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId, title: "Bounded scan" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForWorktree(cell, created);
    const packagePath = String(created.packagePath),
      selectedPath = "context/selected.md",
      taskPath = `${packagePath}/notes.md`;
    write(rootDir, selectedPath, "# Selected\n");
    write(rootDir, taskPath, "# Task notes\n");
    const store = makeTaskEventReader({ repoId, rootDir }),
      projection = makeTaskProjection({
        rootDir,
        eventStore: store,
        projectionPath: path.join(rootDir, ".harness/bounded-scan.sqlite"),
      });
    projection.rebuild();
    let historyReads = 0,
      publicationReads = 0,
      replicaBasisReads = 0,
      ownershipReads = 0;
    const measuredStore = {
      ...store,
      read: () => {
        historyReads += 1;
        return store.read();
      },
      publication: (event: Parameters<typeof store.publication>[0]) => {
        publicationReads += 1;
        return store.publication(event);
      },
    };
    const measuredProjection = {
      ...projection,
      readReplicaBasis: (taskIds: readonly string[] | null) => {
        replicaBasisReads += 1;
        const basis = projection.readReplicaBasis(taskIds);
        return {
          ...basis,
          documents: [
            ...basis.documents,
            ...Array.from({ length: 20_000 }, (_, index) => ({
              path: `context/history-${index}.md`,
              blobSha256: "0".repeat(64),
              size: 1,
              mediaType: "text/markdown" as const,
            })),
          ],
        };
      },
      taskIdForDocumentPath: (candidate: Parameters<typeof projection.taskIdForDocumentPath>[0]) => {
        ownershipReads += 1;
        return projection.taskIdForDocumentPath(candidate);
      },
    };
    const common = {
      rootDir,
      workspaceId: repoId,
      store: measuredStore,
      projection: measuredProjection,
      actor,
      source: "local" as const,
      now: "2026-09-08T00:00:00.000Z",
    };
    try {
      assert.deepEqual(
        scanDocCandidates({ ...common, selection: [selectedPath] }).rows.map((row) => row.path),
        [selectedPath],
      );
      const taskRows = scanDocCandidates({ ...common, taskId }).rows.map((row) => row.path);
      assert.equal(taskRows.includes(taskPath), true);
      assert.equal(
        taskRows.every((row) => row.startsWith(`${packagePath}/`)),
        true,
      );
      assert.equal(
        scanDocCandidates(common).rows.some((row) => row.path === selectedPath),
        true,
      );
      assert.deepEqual(
        scanDocCandidates({
          ...common,
          selection: ["context/missing-a.md", "context/missing-b.md", "context/missing-c.md"],
        }).rows.map((row) => [row.path, row.state]),
        [
          ["context/missing-a.md", "clean"],
          ["context/missing-b.md", "clean"],
          ["context/missing-c.md", "clean"],
        ],
      );
      assert.equal(historyReads, 0);
      assert.equal(publicationReads, 0);
      assert.equal(replicaBasisReads, 0);
      assert.ok(ownershipReads < 50, `candidate ownership reads must stay bounded, observed ${ownershipReads}`);
    } finally {
      projection.close();
      await store.drain();
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scanner refuses multi-megabyte JSONL without reading it and names oversized prose", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-size-type-"));
  initRepo(rootDir);
  const repoId = workspaceId("size-type"),
    line = '{"event":"load"}\n',
    jsonl = line.repeat(Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(line))),
    prose = "context/notes.md",
    oversized = "context/oversized.md";
  const seed = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "size-type-seed" });
  const packagePath = await (async () => {
    try {
      const created = await seed.run(
        { kind: "task-create", taskId: "task-size-type", title: "Size Type" },
        {
          actor,
          source: "local",
        },
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      return String((created as Record<string, unknown>).packagePath);
    } finally {
      await seed.close();
    }
  })();
  const firstLog = `${packagePath}/artifacts/evidence/controller.jsonl`,
    secondLog = `${packagePath}/artifacts/evidence/commands-client-1.jsonl`;
  write(rootDir, firstLog, jsonl);
  write(rootDir, secondLog, jsonl);
  write(rootDir, prose, "# Notes\n");
  write(rootDir, oversized, `# Oversized\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES)}`);
  const store = makeTaskEventReader({ repoId, rootDir }),
    inventory = scanAuthoredCandidateInventory({ rootDir, store }),
    inventoryByPath = new Map(inventory.rows.map((row) => [row.path, row]));
  await store.drain();
  for (const logical of [firstLog, secondLog]) {
    assert.equal(inventoryByPath.get(logical)?.size, Buffer.byteLength(jsonl));
    assert.equal(inventoryByPath.get(logical)?.bytes, null, `${logical} must not enter inventory bytes`);
  }
  assert.equal(inventoryByPath.get(oversized)?.bytes, null, "oversized prose must not enter inventory bytes");
  assert.equal(inventoryByPath.get(prose)?.bytes?.byteLength, Buffer.byteLength("# Notes\n"));
  rmSync(path.join(rootDir, "harness", oversized));

  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "size-type-daemon" }),
    binding = { actor, source: "local" as const };
  try {
    const status = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.deepEqual(
      rows(status.evidence)
        .filter((row) => row.state !== "clean")
        .map((row) => row.path),
      [prose, secondLog, firstLog],
      "unsupported JSONL remains visible with a reason without loading its bytes",
    );
    write(rootDir, "events/segments/manifest.json", "{}\n");
    const unconfirmed = await cell.run({ kind: "doc-submit", paths: [] }, binding);
    assert.equal(unconfirmed.outcome, "op_rejected", JSON.stringify(unconfirmed));
    assert.equal(unconfirmed.code, "preview_blocked");
    assert.deepEqual(
      unconfirmed.detail?.unresolvedTouches.map((touch) => [touch.path, touch.requiredRoute]),
      [
        ["events/segments/manifest.json", "canonical-event"],
        [secondLog, "doc-sync"],
        [firstLog, "doc-sync"],
      ],
      "the canonical manifest and unsupported JSONL are explained before full-submit confirmation",
    );

    const confirmed = await cell.run({ kind: "doc-submit", paths: [], all: true }, binding);
    assert.equal(confirmed.outcome, "applied", JSON.stringify(confirmed));
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(confirmed.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        [prose],
      );

    for (const logical of [firstLog, secondLog]) {
      const selected = await cell.run({ kind: "doc-status", paths: [logical] }, binding),
        row = rows(selected.evidence)[0];
      assert.deepEqual([row?.path, row?.state, row?.size], [logical, "blocked", Buffer.byteLength(jsonl)]);
      assert.match(row?.reason ?? "", /not a supported textual document/u);
    }
    write(rootDir, oversized, `# Oversized\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES)}`);
    const rejected = await cell.run({ kind: "doc-submit", paths: [oversized] }, binding);
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "doc_candidate_too_large");
    const oversizedRow = rows((await cell.run({ kind: "doc-status", paths: [oversized] }, binding)).evidence)[0];
    assert.equal(oversizedRow?.size, Buffer.byteLength(`# Oversized\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES)}`));
    assert.match(oversizedRow?.reason ?? "", new RegExp(`${oversized}.*${DOC_SYNC_INLINE_MAX_BYTES}.*blob`, "u"));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("blocked-only submit names the scanner-first machine-region recovery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-blocked-closeout-"));
  initRepo(rootDir);
  const repoId = workspaceId("blocked-closeout"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "blocked-closeout-daemon",
    }),
    binding = { actor, source: "local" as const },
    laterBlocked = "tmp/z-blocked.md";
  try {
    write(rootDir, laterBlocked, "---\nowner: stable\n---\n# Stable\n\nbase\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: [laterBlocked] }, binding);
    assert.equal(submitted.outcome, "applied");
    await waitForWorktree(cell, submitted);
    write(rootDir, laterBlocked, "---\nowner: changed\n---\n# Removed\n\nbase\n");
    const rejected = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as Record<string, unknown>;
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "preview_blocked");
    const detail = rejected.detail as {
      readonly unresolvedTouches: readonly { readonly path: string; readonly requiredRoute: string }[];
    };
    assert.deepEqual(
      detail.unresolvedTouches.map(({ path, requiredRoute }) => [path, requiredRoute]),
      [[laterBlocked, "typed-machine-writer"]],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("selected doc-sync paths are authored-relative candidates and zero-write submit succeeds", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-selection-"));
  initRepo(rootDir);
  const repoId = workspaceId("selection"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "selection-daemon" }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/selected.md", "# Selected\n");
    const authored = await cell.run({ kind: "doc-submit", paths: ["context/selected.md"] }, binding);
    assert.equal(authored.outcome, "applied", JSON.stringify(authored));
    await waitForWorktree(cell, authored);
    assert.match(String((authored as Record<string, unknown>).summary), /applied count: 1/u);

    const repoRelative = await cell.run({ kind: "doc-submit", paths: ["harness/context/selected.md"] }, binding);
    assert.equal(repoRelative.outcome, "no_changes", JSON.stringify(repoRelative));
    assert.equal(repoRelative.acceptance, null);
    assert.equal(repoRelative.proof, undefined);

    const missing = await cell.run({ kind: "doc-submit", paths: ["context/missing.md"] }, binding);
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "document_not_found");
    assert.deepEqual(missing.diagnostic, { kind: "failure", code: "document_not_found" });

    const clean = await cell.run({ kind: "doc-submit", paths: ["context/selected.md"] }, binding);
    assert.equal(clean.outcome, "no_changes", JSON.stringify(clean));
    assert.equal(clean.acceptance, null);
    assert.equal(clean.proof, undefined);
    assert.equal(clean.code, "no_changes");
    assert.match(String((clean as Record<string, unknown>).summary), /applied count: 0/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc-sync details retain ordered unresolved touches", () => {
  const first = touch("context/first.md", "refresh-region-policy", 'base region is missing: "# First"'),
    second = touch("context/second.md", "workspace-config", "path is owned by workspace-config"),
    blocked = unresolvedDetail(first, second),
    withoutRows = unresolvedDetail();
  assert.deepEqual(blocked.unresolvedTouches, [first, second]);
  assert.deepEqual(withoutRows.unresolvedTouches, []);
});

test("task-scoped doc sync derives every dirty candidate from the task id", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-task-scope-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("task-scope"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-scope-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-scope", title: "Scoped task" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForWorktree(cell, created);
    const packagePath = String(created.packagePath);
    write(rootDir, `${packagePath}/notes.md`, "# Task note\n");
    write(rootDir, "context/unrelated.md", "# Unrelated\n");
    const status = await cell.run({ kind: "doc-status", taskId: "task-scope" }, binding);
    assert.equal(status.outcome, "applied", JSON.stringify(status));
    const scanned = rows(status.evidence);
    assert.equal(scanned.length > 0, true);
    assert.equal(
      scanned.every((row) => row.path.startsWith(`${packagePath}/`)),
      true,
    );
    assert.equal(
      scanned.some((row) => row.path === `${packagePath}/notes.md`),
      true,
    );
    const submitted = await cell.run({ kind: "doc-submit", taskId: "task-scope" }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForWorktree(cell, submitted);
    assert.match(submitted.summary ?? "", new RegExp(`${packagePath}/notes\\.md`, "u"));
    const clean = await cell.run({ kind: "doc-submit", taskId: "task-scope" }, binding);
    assert.equal(clean.outcome, "no_changes", JSON.stringify(clean));
    assert.equal(clean.acceptance, null);
    assert.equal(clean.proof, undefined);
    assert.equal(clean.code, "no_changes");
    assert.match(clean.summary ?? "", /applied count: 0/u);
    const mixed = await cell.run({ kind: "doc-submit", taskId: "task-scope", paths: [] }, binding);
    assert.equal(mixed.outcome, "op_rejected");
    assert.equal(mixed.code, "invalid_command");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc retire deletes one projected document and returns an auditable retirement receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("retire"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "retire-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/temporary.md",
    reason = "superseded temporary evidence";
  try {
    write(rootDir, logical, "# Temporary\n\nRetire me.\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForWorktree(cell, submitted);
    rmSync(path.join(rootDir, "harness", logical));
    const mutation = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
    assert.equal(rows(mutation.evidence)[0]?.state, "deletion");
    assert.deepEqual(mutation.detail?.deletions, [
      { path: logical, baseBlobSha256: sha256Text("# Temporary\n\nRetire me.\n"), source: "intent" },
    ]);
    const retired = await cell.run({ kind: "doc-retire", path: logical, reason }, binding);
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const settled = await waitForWorktree(cell, retired);
    assert.equal(settled.proof?.durable, true);
    assert.equal(settled.proof?.canonicalVisible, true);
    assert.equal(settled.proof?.worktreeVisible, true);
    assert.match(retired.evidence ?? "", /^doc-retirement:/u);
    const receipt = JSON.parse((retired.evidence ?? "").slice("doc-retirement:".length)) as {
      readonly schema: string;
      readonly path: string;
      readonly reason: string;
    };
    assert.deepEqual(receipt, {
      schema: "doc-retirement-receipt/v1",
      path: logical,
      baseBlobSha256: sha256Text("# Temporary\n\nRetire me.\n"),
      reason,
    });
    const event = makeTaskEventReader({ repoId: "retire", rootDir }).readEvent(retired.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1") {
      assert.equal(event.payload.retirementReason, reason);
      assert.equal(event.payload.changes[0]?.candidate, null);
    }
    const shown = await cell.run({ kind: "doc-show", path: logical }, binding);
    assert.equal(shown.code, "document_not_found");
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), "");
    assert.equal(
      rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some(
        (row) => row.state === "deletion",
      ),
      false,
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function unresolvedDetail(...unresolvedTouches: ReturnType<typeof touch>[]) {
  const current = {
      repoId: "next-action-detail",
      revision: 0,
      headDigest: `sha256:${"0".repeat(64)}`,
    },
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: null,
        baseLedgerSha: current,
        changes: [
          {
            path: "context/first.md",
            baseBlobSha256: null,
            policyId: DOC_POLICY_ID,
            candidate: null,
          },
        ],
      },
      current.repoId,
    );
  return detail(intent, current, "unresolved_touch", null, unresolvedTouches);
}

test("full scans do not infer legacy retirement while explicit retire remains available", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-retire-tracked-"));
  initRepo(rootDir);
  const logical = "tmp/legacy-tracked.md",
    body = "# Legacy tracked document\n",
    reason = "retire pre-doc-sync ledger debt";
  write(rootDir, logical, body);
  git(rootDir, "add", `harness/${logical}`);
  git(rootDir, "commit", "-qm", "track legacy document");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined = await openRepoCell({
    repoId: workspaceId("retire-tracked"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "retire-tracked-daemon",
  });
  const binding = { actor, source: "local" as const };
  try {
    rmSync(path.join(rootDir, "harness", logical));
    const status = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [[logical, "clean"]],
    );
    assert.deepEqual(status.detail?.deletions, []);

    const retired = await cell.run({ kind: "doc-retire", path: logical, reason }, binding);
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    await waitForWorktree(cell, retired);
    assert.match(retired.evidence ?? "", /^doc-retirement:/u);
    assert.equal(
      makeTaskEventReader({ repoId: "retire-tracked", rootDir }).readEvent(retired.opId)?.schema,
      "doc-event/v1",
    );
    assert.equal(
      rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some(
        (row) => row.state === "deletion",
      ),
      false,
    );
    await cell.close();
    cell = undefined;
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), "");
    assert.equal(git(rootDir, "ls-files", `harness/${logical}`), "");
    assert.equal(existsSync(path.join(rootDir, "harness", logical)), false);
    const reopened = await openRepoCell({
      repoId: workspaceId("retire-tracked"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "retire-tracked-reopened",
    });
    try {
      assert.deepEqual(
        rows((await reopened.run({ kind: "doc-status", paths: [] }, binding)).evidence).map((row) => [
          row.path,
          row.state,
        ]),
        [],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("new non-textual artifacts are inapplicable while binary replacement of canonical text remains blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-non-textual-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("non-textual"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "non-textual-daemon",
    }),
    binding = { actor, source: "local" as const };
  const proofTask = (await cell.run({ kind: "task-create", taskId: "task-proof", title: "Proof" }, binding)) as {
    readonly outcome: string;
    readonly opId: string;
    readonly packagePath: string;
  };
  assert.equal(proofTask.outcome, "applied", JSON.stringify(proofTask));
  await waitForWorktree(cell, proofTask);
  const fresh = `${proofTask.packagePath}/artifacts/screenshots/evidence.png`,
    tracked = `${proofTask.packagePath}/artifacts/report.bin`;
  try {
    const freshTarget = path.join(rootDir, "harness", fresh);
    mkdirSync(path.dirname(freshTarget), { recursive: true });
    writeFileSync(freshTarget, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    const status = await cell.run({ kind: "doc-status", paths: [fresh] }, binding),
      row = rows(status.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual(
      [row?.state, row?.reason],
      ["inapplicable", "non-textual artifact is outside doc sync; publish it with ha task artifact add"],
    );
    assert.deepEqual(status.detail?.unresolvedTouches, []);
    const noOp = (await cell.run({ kind: "doc-submit", paths: [fresh] }, binding)) as Record<string, unknown>;
    assert.equal(noOp.outcome, "no_changes");
    assert.equal(noOp.acceptance, null);
    assert.equal(noOp.proof, undefined);
    assert.equal(noOp.code, "no_changes");
    assert.match(String(noOp.summary), /applied count: 0/u);
    assert.match(String(noOp.opId), /^noop:/u);

    write(rootDir, tracked, "textual baseline\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: [tracked] }, binding);
    assert.equal(submitted.outcome, "applied");
    await waitForWorktree(cell, submitted);
    writeFileSync(path.join(rootDir, "harness", tracked), Buffer.from([0xff, 0x00]));
    const blocked = await cell.run({ kind: "doc-status", paths: [tracked] }, binding);
    assert.equal(rows(blocked.evidence)[0]?.state, "blocked");
    assert.equal(blocked.detail?.unresolvedTouches[0]?.requiredRoute, "typed-binary-content");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("people-registry ownership is inapplicable while typed writable routes remain blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-owned-route-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("owned-route"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "owned-route-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "people.yaml", "schema: harness-people/v1\npeople: []\nroles: []\n");
    write(rootDir, "harness.yaml", "schema: harness-anything/v1\nname: hand-edited\n");
    const people = await cell.run({ kind: "doc-status", paths: ["people.yaml"] }, binding),
      peopleRow = rows(people.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual(
      [peopleRow?.state, peopleRow?.reason],
      ["inapplicable", "path is owned by people-registry and is outside doc sync"],
    );
    assert.deepEqual(people.detail?.unresolvedTouches, []);
    const noOp = await cell.run({ kind: "doc-submit", paths: ["people.yaml"] }, binding);
    assert.equal(noOp.outcome, "no_changes");
    assert.equal(noOp.acceptance, null);
    assert.equal(noOp.proof, undefined);
    assert.equal(noOp.code, "no_changes");
    assert.match(String(noOp.summary), /applied count: 0/u);
    assert.match(noOp.opId, /^noop:/u);

    const workspace = await cell.run({ kind: "doc-status", paths: ["harness.yaml"] }, binding),
      workspaceRow = rows(workspace.evidence)[0] as { readonly state: string; readonly reason?: string } | undefined;
    assert.deepEqual([workspaceRow?.state, workspaceRow?.reason], ["blocked", "path is owned by workspace-config"]);
    assert.equal(workspace.detail?.unresolvedTouches[0]?.requiredRoute, "workspace-config");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function waitForWorktree(cell: Awaited<ReturnType<typeof openRepoCell>>, receipt: { readonly opId: string }) {
  const shown = await cell.run(
    {
      kind: "receipt-show",
      opId: receipt.opId,
      waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
      timeoutMs: 5_000,
    },
    { actor, source: "local" },
  );
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
  return shown;
}
