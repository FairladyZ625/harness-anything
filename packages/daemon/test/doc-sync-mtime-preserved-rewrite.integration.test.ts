// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, git, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

// A host Git configured with core.checkStat=minimal plus core.trustctime=false compares only the
// whole-second mtime and the file size. `rsync -a` restores mtime and an equal-length edit keeps
// size, so the rewrite looks untouched to `git status` — the only change detector the candidate
// scanner has. This is the deli-ai-lab closeout incident (2026-11-05): the ledger never received
// the change and the owner believed the package was synced.
test("doc status sees a same-size rewrite with the original mtime restored under a weakened Git stat model", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-stat-model-")),
    configRoot = mkdtempSync(path.join(tmpdir(), "ha-doc-stat-model-config-")),
    globalConfig = path.join(configRoot, "gitconfig"),
    repoId = workspaceId("doc-stat-model"),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    logical = "context/stat-model.md",
    first = "# Stat model\n\nAAAA\n",
    second = "# Stat model\n\nBBBB\n",
    original = new Date("2020-01-01T00:00:00.000Z"),
    previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second), "the rewrite must keep the tracked size");
  writeFileSync(globalConfig, "[core]\n\tcheckStat = minimal\n\ttrustctime = false\n", "utf8");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });
  initRepo(rootDir);
  write(rootDir, logical, first);
  const target = path.join(rootDir, "harness", logical);
  utimesSync(target, original, original);
  git(rootDir, "add", `harness/${logical}`);
  git(rootDir, "commit", "-qm", "doc: seed stat-model report");
  assert.equal(git(rootDir, "status", "--porcelain=v1"), "", "the seed must start stat-clean");
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "doc-stat-model",
  });
  try {
    const staging = `${target}.rsync`;
    writeFileSync(staging, second, "utf8");
    utimesSync(staging, original, original);
    renameSync(staging, target);
    // Control: the weakened comparison cannot see the rewrite at all — mtime and size match.
    assert.equal(
      git(
        rootDir,
        "-c",
        "core.checkStat=minimal",
        "-c",
        "core.trustctime=false",
        "status",
        "--porcelain=v1",
        "--",
        `harness/${logical}`,
      ),
      "",
      "control: the weakened stat model hides the rewrite",
    );
    const status = await cell.run({ kind: "doc-status", paths: [] }, binding);
    assert.deepEqual(
      rows(status.evidence)
        .filter((row) => row.path === logical)
        .map((row) => [row.path, row.state]),
      [[logical, "eligible"]],
      "doc status must enumerate the change that only ctime and the inode reveal",
    );
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(readFileSync(target, "utf8"), second);
    assert.deepEqual(
      rows((await cell.run({ kind: "doc-status", paths: [logical] }, binding)).evidence).map((row) => [
        row.path,
        row.state,
      ]),
      [[logical, "clean"]],
      "the published bytes must settle back to clean",
    );
  } finally {
    await cell.close();
  }
});
