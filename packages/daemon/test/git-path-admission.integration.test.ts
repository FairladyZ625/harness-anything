// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { sha256Text } from "@harness-anything/kernel";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

for (const route of ["doc-submit", "task-submit", "task-artifact-add"] as const) {
  test(`${route} rejects Git metadata paths before accepting any package bytes`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-git-path-admission-")),
      ledger = path.join(rootDir, "harness"),
      taskId = "task-git-path",
      executionId = "execution-git-path",
      repoId = workspaceId("git-path-admission"),
      holder = withPolicyGroup(
        {
          actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
          source: "local" as const,
        },
        "admin",
      );
    initRepo(rootDir);
    git(rootDir, "branch", "-M", "main");
    writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
    git(rootDir, "add", ".gitignore");
    git(rootDir, "commit", "-qm", "test: fixture exclusions");
    mkdirSync(ledger);
    initRepo(ledger);
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "git-path-fixture",
    });
    const reader = makeTaskEventReader({ repoId, rootDir });
    try {
      const created = await cell.run({ kind: "task-create", taskId, title: "Git path admission" }, holder);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, holder);
      const packagePath = String((created as { packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        async (documentPath) => {
          const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, holder);
          await waitForFixturePublication(cell, receipt.opId, holder);
          return receipt;
        },
        "Git path admission",
      );
      writeFileSync(
        path.join(ledger, packagePath, "closeout.md"),
        "## Summary\nDelivered path admission evidence.\n## Verification\nChecked accepted bytes.\n## Residual Risk\nNo production delivery.\n## Same Mechanism Elsewhere\nAll package paths share admission.\n",
      );
      const closeout = await cell.run({ kind: "doc-submit", taskId }, holder);
      assert.equal(closeout.outcome, "applied", JSON.stringify(closeout));
      await waitForFixturePublication(cell, closeout.opId, holder);
      const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      await waitForFixturePublication(cell, started.opId, holder);
      const workerLedger = path.join(rootDir, ".worktrees", taskId, "harness"),
        body = `unaccepted ${route} metadata bytes\n`,
        safePath = `${packagePath}/artifacts/.github/foo.git`;
      const write = (logical: string, content: string) => {
        mkdirSync(path.dirname(path.join(workerLedger, logical)), { recursive: true });
        writeFileSync(path.join(workerLedger, logical), content);
      };
      if (route !== "task-artifact-add") write(safePath, "safe sibling\n");
      for (const segment of [
        ".git",
        ".GiT",
        "git~1",
        ".g\u200cit",
        ...(route === "task-artifact-add" ? ["CONIN$", "LPT0", "CON .txt", "log\t.txt"] : []),
      ]) {
        const relative = `nested/${segment}/HEAD`,
          badPath = `${packagePath}/artifacts/${relative}`;
        if (route !== "task-artifact-add") write(badPath, body);
        const before = reader.readHead();
        const rejected = await cell.run(
          route === "task-artifact-add"
            ? { kind: route, taskId, destination: relative, content: body }
            : route === "doc-submit"
              ? { kind: route, taskId }
              : { kind: route, taskId, executionId },
          holder,
        );
        assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
        assert.equal(rejected.code, "invalid_write_plan", JSON.stringify(rejected));
        assert.ok(String(rejected.rejectionExplanation).includes(JSON.stringify(badPath)), JSON.stringify(rejected));
        assert.match(JSON.stringify(rejected), /Git.*(?:outside the task package|rename)/u);
        assert.deepEqual(reader.readHead(), before, "rejection must not append a partial event");
        assert.equal(reader.readContentBlob(sha256Text(body)), null, "rejection must not persist content");
        if (route !== "task-artifact-add")
          rmSync(path.join(workerLedger, packagePath, "artifacts/nested"), { recursive: true });
      }
      const accepted = await cell.run(
        route === "task-artifact-add"
          ? { kind: route, taskId, destination: ".github/foo.git", content: "safe sibling\n" }
          : route === "doc-submit"
            ? { kind: route, taskId }
            : { kind: route, taskId, executionId },
        holder,
      );
      assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
      await waitForFixturePublication(cell, accepted.opId, holder);
      assert.deepEqual(reader.readContentBlob(sha256Text("safe sibling\n")), Buffer.from("safe sibling\n"));
    } finally {
      await reader.drain();
      await cell.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
