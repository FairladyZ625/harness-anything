// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonRegistry, updateDaemonRepo } from "@harness-anything/kernel/daemon-registry";
import { registerDaemonRepo } from "@harness-anything/storage";
import type { DaemonHostRegistryContext } from "../src/daemon-host-context.ts";
import type { RepoCell, RepoCellStatus } from "../src/repo-cell-types.ts";
import { refreshRegistry } from "../src/daemon-host-registry.ts";

test("registry refresh reopens a migrated edge repo at its new workspace root", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "ha-edge-root-migration-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const userRoot = path.join(temp, "user-harness"),
    oldRoot = createHarnessRepo(path.join(temp, "old-workspace")),
    newRoot = createHarnessRepo(path.join(temp, "new-workspace"));
  registerDaemonRepo({
    userRoot,
    canonicalRoot: oldRoot,
    repoId: "edge",
    mode: "remote-edge",
    createConvenienceLinks: false,
  });
  updateDaemonRepo({ userRoot, repoId: "edge", canonicalRoot: newRoot, createConvenienceLinks: false });
  assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.canonicalRoot, newRoot);

  const cells = new Map<string, RepoCell>(),
    staleCell = fakeCell(oldRoot);
  cells.set("edge", staleCell);
  let closedOldCell = false,
    openedRoot: string | undefined;
  const context = {
    input: { userRoot },
    cells,
    warming: new Map(),
    unavailable: new Map(),
    unavailableProbes: new Map(),
    openings: new Map(),
    closeCell: async (repoId: string) => {
      closedOldCell = repoId === "edge" && cells.get(repoId) === staleCell;
      cells.delete(repoId);
    },
    settleWarming: () => undefined,
    invalidRepoId: () => "invalid",
    latchUnavailable: () => undefined,
    invalidRegistryStatus: () => ({}),
    pruneMissingRoot: () => false,
    markWarming: () => undefined,
    warmingStatus: () => ({}),
    openRegistered: async (repo: { readonly repoId: string; readonly canonicalRoot: string }) => {
      openedRoot = repo.canonicalRoot;
      cells.set(repo.repoId, fakeCell(repo.canonicalRoot));
    },
  } as unknown as DaemonHostRegistryContext;

  await refreshRegistry(context);
  assert.equal(closedOldCell, true, "the old workspace cell is retired after registry migration");
  assert.equal(openedRoot, newRoot, "the same repo id is reopened from its new registered root");
});

function fakeCell(rootDir: string): RepoCell {
  const status: RepoCellStatus = {
    repoId: "edge",
    rootDir,
    mode: "remote-edge",
    state: "attached",
    generation: null,
    queueDepth: null,
    lastError: null,
    causeClass: null,
    recoveryMs: null,
    materialization: null,
  };
  return { status: () => status } as RepoCell;
}

function createHarnessRepo(rootDir: string): string {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
  execFileSync("git", ["-C", rootDir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Registry Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "registry@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "add", "harness/harness.yaml"]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "init"]);
  return realpathSync.native(path.resolve(rootDir));
}
