// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RepoCell } from "../src/repo-cell.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo, writeCloseout, writeSettingsFixture } from "./review-independence.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const migrationFile = "packages/storage/src/store/schema.ts",
  receiptTarget = (packagePath: string) =>
    `${packagePath}/artifacts/old-data-copy-evidence/old-data-copy-evidence-receipt.json`,
  commandFor = (packagePath: string) =>
    `node tools/old-data-copy-evidence.mjs --build . --out harness/${packagePath}/artifacts/old-data-copy-evidence`;

/** One real cell, one real task package: the receipt is written into the bound package and
 *  accepted by the same `ha task submit` doc sync the reviewer later reads. */
async function fixture(t: TestContext, options: { readonly pathReviewers: boolean; readonly changedPath: string }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-old-data-copy-submit-")),
    repoId = "old-data-copy-gate",
    taskId = "task-old-data-copy-gate",
    executionId = "exec-old-data-copy-gate";
  const opened: { cell?: RepoCell } = {};
  t.after(async () => {
    await opened.cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  });
  initRepo(rootDir);
  writeSettingsFixture(rootDir, "strict");
  if (options.pathReviewers) {
    const settingsPath = path.join(rootDir, "harness", "harness.yaml");
    writeFileSync(
      settingsPath,
      readFileSync(settingsPath, "utf8").replace(
        "  scaffolds:",
        "  review:\n    pathReviewers:\n      - data-migration packages/storage/src/store/\n  scaffolds:",
      ),
    );
    git(rootDir, "add", "harness/harness.yaml");
    git(rootDir, "commit", "--quiet", "-m", "settings fixture path reviewer");
  }
  const cell = (opened.cell = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "daemon-test",
  }));
  const owner = withPolicyGroup(
      withPolicyGroup(
        { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
        "maintainer",
      ),
      "contributor",
    ),
    created = await cell.run(
      { kind: "task-create", taskId, title: "Old-data copy gate", presetId: "standard-task" },
      owner,
    );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, owner);
  const packagePath = String((created as { readonly packagePath?: unknown }).packagePath);
  await realizeTaskPlanFixture(rootDir, packagePath, async (planPath) => {
    const receipt = await cell.run({ kind: "doc-submit", paths: [planPath] }, owner);
    await waitForFixturePublication(cell, receipt.opId, owner);
    return receipt;
  });
  const started = await cell.run({ kind: "task-start", taskId, executionId }, owner);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForFixturePublication(cell, started.opId, owner);
  // The delivery belongs to the task's bound worktree, exactly where a worker commits it.
  const deliveryRoot = path.join(rootDir, ".worktrees", taskId),
    workRoot = existsSync(deliveryRoot) ? deliveryRoot : rootDir,
    baseline = git(workRoot, "rev-parse", "HEAD");
  await cell.settlePendingMaterialization("delivery after execution start");
  mkdirSync(path.dirname(path.join(workRoot, options.changedPath)), { recursive: true });
  writeFileSync(path.join(workRoot, options.changedPath), "export const delivered = 1;\n");
  git(workRoot, "add", options.changedPath);
  git(workRoot, "commit", "--quiet", "-m", "delivery");
  const cut = git(workRoot, "rev-parse", "HEAD");
  writeCloseout(rootDir, packagePath);
  const submit = () => cell.run({ kind: "task-submit", taskId, executionId, commitSha: cut }, owner);
  const writeReceipt = (headCommit: string, overrides: Record<string, unknown> = {}) => {
    const target = path.join(rootDir, "harness", receiptTarget(packagePath));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({
        schema: "old-data-copy-evidence/v1",
        at: "2026-11-08T00:00:00.000Z",
        ok: true,
        build: { headCommit },
        attach: { outcome: "terminal-record", record: { event: "repo_attach_completed" } },
        failures: [],
        ...overrides,
      }),
    );
  };
  return { cell, owner, packagePath, baseline, cut, submit, writeReceipt, taskId, executionId };
}

function refusal(receipt: Record<string, unknown>) {
  assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
  assert.equal(receipt.code, "document_invalid", JSON.stringify(receipt));
  return String(receipt.rejectionExplanation);
}

test("a migration-surface cut submits only with an old-data-copy receipt bound to that cut", async (t) => {
  const { cell, owner, packagePath, baseline, cut, submit, writeReceipt, taskId, executionId } = await fixture(t, {
    pathReviewers: true,
    changedPath: migrationFile,
  });
  const missing = refusal(await submit());
  assert.match(missing, /touches the data-migration review surface/u);
  assert.ok(missing.includes(`harness/${receiptTarget(packagePath)}`), missing);
  assert.ok(missing.includes(commandFor(packagePath)), "the refusal carries the exact command to run");

  writeReceipt(baseline);
  const stale = refusal(await submit());
  assert.match(stale, new RegExp(`is bound to cut ${baseline}, not the submitted cut ${cut}`, "u"));

  writeReceipt(cut);
  const applied = await submit();
  assert.equal(applied.outcome, "applied", JSON.stringify(applied));
  const shown = await cell.run({ kind: "task-show", taskId }, owner),
    evidence = JSON.parse(String(shown.evidence)) as {
      readonly executions: readonly {
        readonly executionId: string;
        readonly submission: { readonly commitSha: string; readonly artifacts?: readonly { path: string }[] } | null;
      }[];
    },
    submission = evidence.executions.find((execution) => execution.executionId === executionId)?.submission;
  assert.equal(submission?.commitSha, cut);
  assert.ok(
    submission?.artifacts?.some(({ path }) => path === receiptTarget(packagePath)),
    "the accepted receipt is part of the frozen cut, so later reads bind the same bytes",
  );
});

test("a cut that misses the data-migration lane submits without a receipt", async (t) => {
  const { cell, owner, submit, cut, taskId, executionId } = await fixture(t, {
    pathReviewers: true,
    changedPath: "src/plain.ts",
  });
  const applied = await submit();
  assert.equal(applied.outcome, "applied", JSON.stringify(applied));
  const shown = await cell.run({ kind: "task-show", taskId }, owner),
    evidence = JSON.parse(String(shown.evidence)) as {
      readonly executions: readonly {
        readonly executionId: string;
        readonly submission: { readonly commitSha: string } | null;
      }[];
    };
  assert.equal(
    evidence.executions.find((execution) => execution.executionId === executionId)?.submission?.commitSha,
    cut,
  );
});
