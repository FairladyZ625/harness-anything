// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyDocSyncCandidatePath, documentPath } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

test("the authored walls manifest can be created and edited through doc sync", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-governance-doc-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("governance-doc"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "governance-doc-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = documentPath("governance/walls/walls.json");
  try {
    for (const walls of [[], [{ id: "retired-preset", expect: "exit==0" }]]) {
      const body = `${JSON.stringify({ schema: "walls/v1", walls }, null, 2)}\n`;
      write(rootDir, logical, body);
      const status = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      assert.equal(rows(status.evidence)[0]?.state, "eligible", JSON.stringify(status));
      const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await waitForFixturePublication(cell, submitted.opId, binding);
      const read = await cell.run({ kind: "doc-show", path: logical }, binding);
      assert.equal(read.evidence, body);
      const clean = await cell.run({ kind: "doc-status", paths: [logical] }, binding);
      assert.equal(rows(clean.evidence)[0]?.state, "clean", JSON.stringify(clean));
    }
    assert.equal(classifyDocSyncCandidatePath("governance/arbitrary.json"), null);
    assert.equal(classifyDocSyncCandidatePath("tasks/task-owner/task-contract.json"), null);
    assert.equal(classifyDocSyncCandidatePath("tasks/task-owner/artifacts/dispatch.json"), null);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
