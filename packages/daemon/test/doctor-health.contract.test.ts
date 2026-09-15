// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } },
  binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");

function initRepo(rootDir: string): void {
  const git = (...args: readonly string[]) =>
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.name", "Doctor Health Test");
  git("config", "user.email", "doctor@example.invalid");
  git("config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "fixture base");
}

test("doctor health reports the six checks and degrades to indeterminate without origin/main", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doctor-health-")),
    repoId = workspaceId("doctor-health");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "doctor-health" });
    const receipt = (await cell.run({ kind: "doctor-health" }, binding)) as Record<string, unknown>;
    assert.equal(receipt.schema, "doctor-health/v1", JSON.stringify(receipt));
    const checks = receipt.checks as readonly { id: string; status: string; count: number }[];
    assert.deepEqual(
      checks.map((check) => check.id),
      ["stale-delivered", "executor-undeclared", "orphan-lease", "wip-pressure", "doc-debt", "build-drift"],
    );
    const byId = new Map(checks.map((check) => [check.id, check]));
    // A fixture repository has no origin remote: freshness and the daemon-side build verdict
    // cannot be judged, so both checks report indeterminate rather than guessing.
    assert.equal(byId.get("stale-delivered")?.status, "indeterminate");
    assert.equal(byId.get("build-drift")?.status, "indeterminate");
    for (const id of ["executor-undeclared", "orphan-lease", "wip-pressure"])
      assert.equal(byId.get(id)?.status, "ok", id);
    assert.ok(["ok", "warn"].includes(String(byId.get("doc-debt")?.status)));
    for (const check of checks) assert.ok(["ok", "warn", "fail", "indeterminate"].includes(check.status), check.id);
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});
