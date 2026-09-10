// harness-test-tier: integration
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection, sha256Text } from "../../kernel/src/index.ts";
import { runDocAction } from "../src/doc-sync-command-actions.ts";
import { scanAuthoredCandidateInventory, scanDocCandidates } from "../src/doc-sync-candidate-scanner.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

test("doc status reuses unchanged file inputs and observes accepted updates, drafts, conflicts and deletion", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-cache-")),
    repoId = workspaceId("doc-cache"),
    binding = { actor, source: "local" as const },
    paths = Array.from({ length: 24 }, (_, i) => `context/cache/document-${String(i).padStart(2, "0")}.md`),
    corpus = new Set(paths.map((logical) => path.join(rootDir, "harness", logical)));
  initRepo(rootDir);
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "doc-cache" });
  let store = makeTaskEventReader({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    reads = 0,
    historyReads = 0;
  const readHistory = store.read;
  t.mock.method(store, "read", () => {
    historyReads++;
    return readHistory();
  });
  const original = fs.readFileSync,
    spy = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (corpus.has(String(args[0]))) reads++;
      return original(...args);
    });
  syncBuiltinESMExports();
  const status = () =>
    runDocAction({
      action: { kind: "doc-status", paths },
      binding,
      rootDir,
      workspaceId: repoId,
      store,
      projection,
      now: () => "2026-09-09T00:00:00.000Z",
    });
  try {
    for (const [i, logical] of paths.entries()) write(rootDir, logical, `# Document ${i}\n\n${"body ".repeat(1024)}\n`);
    const cold = await status();
    assert.equal(reads, paths.length, "cold status must load every actual candidate");
    reads = 0;
    const warm = await status();
    assert.deepEqual(warm, cold, "same-cut receipts, owners and candidates must match");
    assert.equal(reads, 0, "warm status must not reload candidate bodies");
    assert.equal(historyReads, 0, "status must query the projection without loading event history");
    t.diagnostic(`cold file loads=${paths.length}; warm file loads=${reads}; full-history loads=${historyReads}`);
    assert.deepEqual(
      rows((await cell.run({ kind: "doc-status", paths }, binding)).evidence),
      rows(warm.evidence),
      "RepoCell ingress must produce the same candidates",
    );

    const accepted = await cell.run({ kind: "doc-submit", paths }, binding);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.ok(accepted.acceptance, "count a real accepted receipt, not a loop iteration");
    await waitForFixturePublication(cell, accepted.opId, binding);
    reads = 0;
    const clean = await status();
    assert.equal(reads, paths.length, "an accepted cut invalidates the previous file inputs");
    assert.ok(rows(clean.evidence).every((row) => row.state === "clean"));
    reads = 0;
    assert.deepEqual(await status(), clean);
    assert.equal(reads, 0);

    const logical = paths[0]!,
      target = path.join(rootDir, "harness", logical),
      before = statSync(target);
    const updated = `# Document 0\n\n${"edit ".repeat(1024)}\n`;
    write(rootDir, logical, updated);
    utimesSync(target, before.atime, before.mtime);
    reads = 0;
    const draft = await status();
    assert.equal(reads, 1, "same-size draft with restored mtime must reload via ctime");
    assert.equal(rows(draft.evidence)[0]?.state, "eligible");
    const update = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(update.outcome, "applied", JSON.stringify(update));
    assert.ok(update.acceptance);
    assert.ok(update.revision > accepted.revision);
    await waitForFixturePublication(cell, update.opId, binding);
    const afterUpdate = await status();
    assert.equal(rows(afterUpdate.evidence)[0]?.state, "clean");
    const cut = JSON.parse(afterUpdate.evidence!.slice("doc-scan:".length));
    assert.equal(cut.rows[0].baseBlobSha256, sha256Text(updated));
    assert.equal(cut.baseLedgerSha.revision, update.revision);

    write(rootDir, logical.replace(/\.md$/u, ".conflict-deadbeef.md"), "# Local conflict\n");
    reads = 0;
    const conflict = await status();
    assert.equal(reads, 0, "conflict discovery must stay live without reloading unchanged bodies");
    assert.equal(rows(conflict.evidence)[0]?.state, "conflict");
    assert.equal(conflict.detail?.unresolvedTouches[0]?.requiredRoute, "local-conflict-resolution");
    rmSync(target);
    const deleted = await status();
    assert.equal(rows(deleted.evidence)[0]?.state, "deletion");
    write(rootDir, logical, updated);
    rmSync(target.replace(/\.md$/u, ".conflict-deadbeef.md"));
    assert.equal(rows((await status()).evidence)[0]?.state, "clean");

    projection.close();
    await store.drain();
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "doc-cache-reopen" });
    store = makeTaskEventReader({ repoId, rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    reads = 0;
    const reopened = await status();
    assert.equal(reads, paths.length, "a reopened store must rebuild its disposable file inputs");
    assert.deepEqual(reopened, afterUpdate, "restarted reads must match the accepted cut");
    t.diagnostic(`accepted receipts=2; latest revision=${update.revision}; restart file loads=${reads}`);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    projection.close();
    await store.drain();
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("discovery preserves unknown files and owners and isolates repositories and cut identities", async (t) => {
  const roots = [0, 1].map(() => mkdtempSync(path.join(tmpdir(), "ha-doc-cache-repo-"))),
    stores: ReturnType<typeof makeTaskEventReader>[] = [],
    projections: ReturnType<typeof makeTaskProjection>[] = [],
    cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [];
  try {
    for (const [i, rootDir] of roots.entries()) {
      initRepo(rootDir);
      const repoId = workspaceId(`cache-repo-${i}`),
        cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: `cache-${i}` });
      cells.push(cell);
      const store = makeTaskEventReader({ repoId, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: store });
      stores.push(store);
      projections.push(projection);
      write(rootDir, "context/common.md", `# Repository ${i}\n`);
      for (const logical of [
        "context/unknown.json",
        "context/unknown.pdf",
        "context/unknown.sh",
        "agents/unknown.json",
      ])
        write(rootDir, logical, "unknown bytes\n");
      const result = await cell.run({ kind: "doc-status", paths: [] }, { actor, source: "local" });
      for (const logical of [
        "context/unknown.json",
        "context/unknown.pdf",
        "context/unknown.sh",
        "agents/unknown.json",
      ]) {
        assert.equal(rows(result.evidence).find((row) => row.path === logical)?.state, "blocked", logical);
        assert.ok(
          result.detail?.unresolvedTouches.some((touch) => touch.path === logical && touch.requiredRoute),
          logical,
        );
      }
    }
    let fileLoads = 0;
    const original = fs.readFileSync,
      spy = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]).endsWith("/context/common.md")) fileLoads++;
        return original(...args);
      });
    syncBuiltinESMExports();
    t.after(() => {
      spy.mock.restore();
      syncBuiltinESMExports();
    });
    const rootDir = roots[0]!,
      store = stores[0]!,
      projection = projections[0]!,
      originalCut = store.currentCut();
    let cut = originalCut,
      generation = store.ledgerMetadata().generation;
    const measured = {
        ...store,
        currentCut: () => cut,
        ledgerMetadata: () => ({ ...store.ledgerMetadata(), generation }),
      },
      input = {
        rootDir,
        workspaceId: originalCut.repoId,
        store: measured,
        projection,
        actor,
        source: "local" as const,
        now: "2026-09-09T00:00:00.000Z",
        selection: ["context/common.md"],
      };
    const first = scanDocCandidates(input);
    assert.equal(fileLoads, 1);
    assert.deepEqual(scanDocCandidates(input), first);
    assert.equal(fileLoads, 1);
    generation++;
    assert.deepEqual(scanDocCandidates(input), first);
    assert.equal(fileLoads, 2, "generation change invalidates the cached input");
    cut = { ...originalCut, headDigest: `sha256:${"f".repeat(64)}` };
    scanDocCandidates(input);
    assert.equal(fileLoads, 3, "same-revision replacement head invalidates the cached input");
    cut = originalCut;
    // A cold reader at the same cut is the oracle; no canonical event or schema is modified.
    assert.deepEqual(scanDocCandidates({ ...input, store: { ...measured } }), first);
    const second = scanDocCandidates({
      ...input,
      rootDir: roots[1]!,
      workspaceId: stores[1]!.currentCut().repoId,
      store: stores[1]!,
      projection: projections[1]!,
    });
    assert.notEqual(first.rows[0]?.candidateBlobSha256, second.rows[0]?.candidateBlobSha256);
    assert.equal(second.rows[0]?.candidateBlobSha256, sha256Text("# Repository 1\n"));
    assert.equal(fileLoads, 5);
    const inventoried = scanAuthoredCandidateInventory({ rootDir: roots[1]!, store: stores[1]! });
    assert.equal(fileLoads, 5, "inventory shares the preceding scanner inputs at the same cut");
    assert.deepEqual(scanAuthoredCandidateInventory({ rootDir: roots[1]!, store: stores[1]! }), inventoried);
    assert.equal(fileLoads, 5, "warm inventory does not reload unchanged file inputs");
    t.diagnostic("generation and same-revision head replacement each force a reload; warm inventory adds zero loads");
  } finally {
    for (const projection of projections) projection.close();
    for (const store of stores) await store.drain();
    for (const cell of cells) await cell.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
