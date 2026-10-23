// harness-test-tier: integration
// Attaching a repository whose layout.localRoot is not `.harness` must keep every local ledger
// artifact under that root: no code may recreate the default `.harness` directory.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const actor = { principal: { personId: "person-local-root" }, executor: null } as const;

function entries(directory: string): readonly string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

test("attach and write a task under a renamed local root without creating .harness", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-root-attach-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness.nosync\n",
  );
  const layout = resolveHarnessLayout(rootDir);
  assert.equal(layout.localRoot, path.join(rootDir, ".harness.nosync"));

  const cell = await openRepoCell({
    repoId: workspaceId("local-root"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "local-root-test",
  });
  t.after(() => cell.close());
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  const created = await cell.run(
    {
      kind: "task-create",
      taskId: "task_local_root",
      title: "Renamed local root",
      presetId: "standard-task",
      taskClass: "standard",
    },
    binding,
  );
  assert.equal(created.status, "accepted_durable", JSON.stringify(created));
  await waitForFixturePublication(cell, String(created.opId), binding);

  assert.deepEqual(entries(path.join(rootDir, ".harness")), []);
  assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  assert.equal(existsSync(layout.taskProjectionPath), true);
  assert.equal(existsSync(path.join(layout.localRoot, "store")), true);
  assert.equal(existsSync(path.join(rootDir, ".harness", "cache", "task.sqlite")), false);
});
