// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonReconcileState,
  reconcileDaemonRepoRegistry,
  type DaemonRepoReconcileAdapter
} from "../src/daemon/registry-reconciler.ts";

test("registry reconciler isolates attach, bind, detach, and retry failures by repo", async () => {
  const desiredRepos = ["attach-bad", "retry-bad", "bind-bad", "healthy"].map((repoId) => ({
    repoId,
    canonicalRoot: `/repos/${repoId}`,
    displayName: repoId,
    state: "enabled" as const,
    registeredAt: "2026-07-16T08:00:00.000Z"
  }));
  const known = new Set(["retry-bad", "bind-bad", "healthy", "detach-bad", "detach-good"]);
  const statuses = new Map<string, { state: string; lastError?: string }>([
    ["retry-bad", { state: "unavailable", lastError: "retry unavailable" }],
    ["bind-bad", { state: "attached" }],
    ["healthy", { state: "attached" }],
    ["detach-bad", { state: "attached" }],
    ["detach-good", { state: "attached" }]
  ]);
  const bound: string[] = [];
  const removed: string[] = [];
  let injectFailures = true;
  const adapter: DaemonRepoReconcileAdapter = {
    loadDesiredRepos: () => desiredRepos,
    knownRepoIds: () => [...known],
    repoStatus: (repoId: string) => statuses.get(repoId),
    attachRepo: async (repo) => {
      known.add(repo.repoId);
      if (injectFailures && (repo.repoId === "attach-bad" || repo.repoId === "retry-bad")) {
        throw new Error(`${repo.repoId} attach failure`);
      }
      const status = { state: "attached" };
      statuses.set(repo.repoId, status);
      return status;
    },
    bindRepo: (repo) => {
      if (injectFailures && repo.repoId === "bind-bad") throw new Error("bind failure");
      bound.push(repo.repoId);
    },
    detachRepo: async (repoId: string) => {
      if (injectFailures && repoId === "detach-bad") throw new Error("detach failure");
      statuses.set(repoId, { state: "detached" });
    },
    removeRepo: (repoId: string) => {
      known.delete(repoId);
      removed.push(repoId);
    },
    now: () => new Date("2026-07-16T08:30:00.000Z")
  };
  const state = createDaemonReconcileState();

  await reconcileDaemonRepoRegistry(adapter, state);

  assert.deepEqual([...state.repoErrors.keys()].sort(), ["attach-bad", "bind-bad", "detach-bad", "retry-bad"]);
  assert.deepEqual(bound, ["healthy"]);
  assert.deepEqual(removed, ["detach-good"]);
  assert.equal(known.has("detach-bad"), true);
  assert.equal(state.lastReconcileError?.repoId, "detach-bad");
  assert.match(state.repoErrors.get("retry-bad")?.message ?? "", /^retry failed:/u);

  injectFailures = false;
  await reconcileDaemonRepoRegistry(adapter, state);

  assert.equal(state.repoErrors.size, 0);
  assert.equal(state.lastReconcileError, null);
  assert.deepEqual(removed, ["detach-good", "detach-bad"]);
  assert.equal(bound.includes("healthy"), true);
  assert.equal(bound.includes("attach-bad"), true);
  assert.equal(bound.includes("retry-bad"), true);
  assert.equal(bound.includes("bind-bad"), true);
});
