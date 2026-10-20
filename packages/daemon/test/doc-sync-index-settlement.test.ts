// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLedgerGitLayout } from "@harness-anything/kernel";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, initNestedLedgerRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

const binding = () => withPolicyGroup({ actor, source: "local" as const }, "admin");

// F-B9DAA193: a plain `git status` opportunistically writes the refreshed
// index, so a scanner read overlapping the writer's update-index can overwrite the freshly settled
// index with the older snapshot it read, keeping the stale-index window open until the next ledger
// write. Enumeration is a read and must never rewrite the index.
test("doc status enumeration reads the ledger without rewriting the Git index", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-index-readonly-"));
  initNestedLedgerRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("index-readonly"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "index-readonly-daemon",
  });
  try {
    write(rootDir, "context/notes.md", "# Notes\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding());
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, binding());
    const ledgerRoot = resolveLedgerGitLayout(canonicalRoot(rootDir)).rootDir,
      // Stat-stale a tracked file so an index-writing status has a refresh worth persisting.
      stale = new Date(Date.now() - 60_000);
    utimesSync(path.join(ledgerRoot, "context", "notes.md"), stale, stale);
    const index = path.join(ledgerRoot, ".git", "index"),
      before = statSync(index),
      status = await cell.run({ kind: "doc-status", paths: [] }, binding()),
      after = statSync(index);
    assert.deepEqual(rows(status.evidence), []);
    assert.equal(
      `${after.ino}:${after.mtimeMs}`,
      `${before.ino}:${before.mtimeMs}`,
      "the enumeration read must leave the Git index file untouched",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
