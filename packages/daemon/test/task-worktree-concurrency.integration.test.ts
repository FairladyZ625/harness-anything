// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const holder = withPolicyGroup(
  { actor: { principal: { personId: "owner" }, executor: { kind: "agent", id: "worker" } }, source: "local" },
  "admin",
);
const center = withPolicyGroup(
  { actor: { principal: { personId: "owner" }, executor: null }, source: "local" },
  "admin",
);
const original = "# Ruling\n\nInitial evidence.\n",
  supplemented = `${original}\n## Additional negative control\n\nCenter evidence added after projection.\n`,
  workerEdit = `${original}\nWorker evidence.\n`;

// Reconstructs the 1772f79 lost-update ordering without touching the incident's task package.
for (const shape of ["current", "legacy-copy", "legacy-hardlink"] as const) {
  for (const kind of ["task-submit", "doc-submit"] as const) {
    for (const workerChanged of [false, true]) {
      test(`${shape} ${kind}: center update ${workerChanged ? "conflicts with a worker edit" : "survives an untouched worker copy"}`, async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-doc-concurrency-")),
          ledger = path.join(rootDir, "harness"),
          taskId = "task-doc-concurrency",
          executionId = "execution-doc-concurrency";
        initRepo(rootDir);
        git(rootDir, "branch", "-M", "main");
        writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
        git(rootDir, "add", ".gitignore");
        git(rootDir, "commit", "-qm", "test: fixture exclusions");
        mkdirSync(ledger);
        initRepo(ledger);
        const cell = await openBootstrappedRepoCell({
          repoId: workspaceId("task-doc-concurrency"),
          rootDir: canonicalRoot(rootDir),
          ownerId: "task-doc-concurrency",
        });
        try {
          const created = await cell.run({ kind: "task-create", taskId, title: "Concurrent task documents" }, holder);
          assert.equal(created.outcome, "applied", JSON.stringify(created));
          await waitForFixturePublication(cell, created.opId, holder);
          const packagePath = String((created as { packagePath?: string }).packagePath),
            rulingPath = `${packagePath}/artifacts/ruling.md`,
            reportPath = `${packagePath}/artifacts/report.md`,
            canonicalRuling = path.join(ledger, rulingPath);
          const sync = async (paths: string[], actor = holder) => {
            const receipt = await cell.run({ kind: "doc-submit", paths }, actor);
            assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
            await waitForFixturePublication(cell, receipt.opId, holder);
            return receipt;
          };
          await realizeTaskPlanFixture(rootDir, packagePath, (p) => sync([p]), "Concurrent task documents");
          mkdirSync(path.dirname(canonicalRuling), { recursive: true });
          writeFileSync(canonicalRuling, original);
          writeFileSync(path.join(ledger, reportPath), "# Original worker report\n");
          writeFileSync(
            path.join(ledger, packagePath, "closeout.md"),
            "## Summary\nConcurrent documents preserved.\n## Verification\nIntegration assertions.\n" +
              "## Residual Risk\nNone in fixture.\n## Same Mechanism Elsewhere\nVersioned writes.\n",
          );
          await sync([rulingPath, reportPath, `${packagePath}/closeout.md`]);
          const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
          assert.equal(started.outcome, "applied", JSON.stringify(started));
          await waitForFixturePublication(cell, started.opId, holder);
          const workerRoot = path.join(rootDir, ".worktrees", taskId),
            workerRuling = path.join(workerRoot, "harness", rulingPath),
            newPath = `${packagePath}/artifacts/worker-created.md`;
          const workerReport = path.join(workerRoot, "harness", reportPath);
          if (shape !== "current") {
            // The pre-fix materializer recorded only the v1 mirror marker; no ledger-base or SHA.
            if (shape === "legacy-hardlink") {
              for (const logical of [rulingPath, reportPath]) {
                const worker = path.join(workerRoot, "harness", logical);
                unlinkSync(worker);
                linkSync(path.join(ledger, logical), worker);
              }
            }
          }
          // Center editors replace atomically, breaking the original hard link on the buggy version.
          writeFileSync(`${canonicalRuling}.tmp`, supplemented);
          renameSync(`${canonicalRuling}.tmp`, canonicalRuling);
          await sync([rulingPath], center);
          if (shape !== "current") {
            rmSync(path.join(workerRoot, ".harness", "ledger-base"), { recursive: true, force: true });
            writeFileSync(workerReport, "# Updated worker report\n");
          }
          assert.equal(readFileSync(workerRuling, "utf8"), original);
          if (workerChanged) {
            writeFileSync(`${workerRuling}.tmp`, workerEdit);
            renameSync(`${workerRuling}.tmp`, workerRuling);
            // Deliberately older than the center: version checks cannot depend on wall-clock ordering.
            utimesSync(workerRuling, 1, 1);
          }
          writeFileSync(path.join(workerRoot, "harness", newPath), "# Worker output\n");
          const receipt = await cell.run(
            kind === "task-submit" ? { kind, taskId, executionId } : { kind, taskId },
            holder,
          );
          if (workerChanged) {
            assert.equal(receipt.code, "base_blob_changed", JSON.stringify(receipt));
            assert.equal(existsSync(path.join(ledger, newPath)), false, "the conflicted batch writes nothing");
            assert.equal(
              readFileSync(workerRuling, "utf8"),
              workerEdit,
              "worker bytes remain available for resolution",
            );
          } else {
            assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
            await waitForFixturePublication(cell, receipt.opId, holder);
            assert.equal(existsSync(path.join(ledger, newPath)), true);
            if (shape !== "current")
              assert.equal(readFileSync(path.join(ledger, reportPath), "utf8"), "# Updated worker report\n");
          }
          assert.equal(readFileSync(canonicalRuling, "utf8"), supplemented);
        } finally {
          await cell.close();
          rmSync(rootDir, { recursive: true, force: true });
        }
      });
    }
  }
}
