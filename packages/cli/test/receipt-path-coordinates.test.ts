// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { translateReceiptPathCoordinates } from "../src/cli-receipt-path-coordinates.ts";

const canonical = "tasks/task_a";
const workspace = "harness/tasks/task_a";

test("a receipt whose evidence carries the workspace spelling is translated", () => {
  const receipt = {
    ok: true,
    evidence: JSON.stringify({ packagePath: canonical, workspacePackagePath: workspace }),
  };
  const translated = translateReceiptPathCoordinates(receipt);
  const payload = JSON.parse(String(translated.evidence));
  assert.equal(payload.packagePath, workspace);
  assert.equal(payload.ledgerPackagePath, canonical);
  assert.equal(Object.hasOwn(payload, "workspacePackagePath"), false);
});

test("task-list translates every row and the human summary, and leaves the rest alone", () => {
  const receipt = {
    ok: true,
    revision: 7,
    evidence: JSON.stringify({
      packagePath: canonical,
      rows: [
        { taskId: "task_a", packagePath: canonical, workspacePackagePath: workspace },
        { taskId: "task_b", packagePath: null },
      ],
    }),
    summary: `task_b  task_a  packagePath=${canonical}`,
  };
  const translated = translateReceiptPathCoordinates(receipt);
  assert.equal(translated.revision, 7);
  const payload = JSON.parse(String(translated.evidence));
  assert.equal(payload.rows[0].packagePath, workspace);
  assert.equal(payload.rows[0].ledgerPackagePath, canonical);
  assert.equal(payload.rows[1].packagePath, null);
  assert.match(String(translated.summary), new RegExp(`packagePath=${workspace}`, "u"));
  assert.doesNotMatch(String(translated.summary), new RegExp(`packagePath=${canonical}`, "u"));
});

test("task show nests the same package under task, progress and artifacts; all are translated", () => {
  const translated = translateReceiptPathCoordinates({
    ok: true,
    packagePath: canonical,
    workspacePackagePath: workspace,
    evidence: JSON.stringify({
      task: { taskId: "task_a", packagePath: canonical },
      packagePath: canonical,
      workspacePackagePath: workspace,
      progress: [{ payload: { resultDocumentClaim: { path: `${canonical}/progress.md` } } }],
      executions: [{ submission: { artifacts: [{ path: `${canonical}/artifacts/report.md` }] } }],
    }),
    summary: `task: taskId=task_a  packagePath=${canonical}\npackagePath=${canonical}  workspacePackagePath=${workspace}`,
  });
  const payload = JSON.parse(String(translated.evidence));
  assert.equal(payload.task.packagePath, workspace);
  assert.equal(payload.packagePath, workspace);
  assert.equal(payload.ledgerPackagePath, canonical);
  assert.equal(payload.progress[0].payload.resultDocumentClaim.path, `${workspace}/progress.md`);
  assert.equal(payload.executions[0].submission.artifacts[0].path, `${workspace}/artifacts/report.md`);
  assert.match(String(translated.summary), new RegExp(`taskId=task_a  packagePath=${workspace}`, "u"));
  assert.doesNotMatch(String(translated.summary), new RegExp(`packagePath=${canonical}`, "u"));
});

test("task-create translates the receipt field, not an evidence payload", () => {
  const translated = translateReceiptPathCoordinates({
    ok: true,
    packagePath: canonical,
    workspacePackagePath: workspace,
    taskId: "task_a",
  });
  assert.equal(translated.packagePath, workspace);
  assert.equal(translated.ledgerPackagePath, canonical);
  assert.equal(Object.hasOwn(translated, "workspacePackagePath"), false);
});

test("task-create dry-run translates the JSON evidence payload as well as the receipt field", () => {
  const translated = translateReceiptPathCoordinates({
    ok: true,
    packagePath: canonical,
    workspacePackagePath: workspace,
    evidence: JSON.stringify({ packagePath: canonical, workspacePackagePath: workspace, dryRun: true }),
  });
  assert.equal(translated.packagePath, workspace);
  const payload = JSON.parse(String(translated.evidence));
  assert.equal(payload.packagePath, workspace);
  assert.equal(payload.ledgerPackagePath, canonical);
  assert.equal(payload.dryRun, true);
});

test("a receipt without the workspace spelling is unchanged", () => {
  const receipt = { ok: true, evidence: JSON.stringify({ packagePath: canonical }) };
  assert.deepEqual(translateReceiptPathCoordinates(receipt), receipt);
});

test("malformed evidence fails closed instead of printing a half-translated receipt", () => {
  assert.throws(
    () => translateReceiptPathCoordinates({ ok: true, evidence: '{"workspacePackagePath":' }),
    /CLI receipt evidence is not valid JSON/u,
  );
});
