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

test("task-list translates every row and leaves the rest of the receipt alone", () => {
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
  };
  const translated = translateReceiptPathCoordinates(receipt);
  assert.equal(translated.revision, 7);
  const payload = JSON.parse(String(translated.evidence));
  assert.equal(payload.rows[0].packagePath, workspace);
  assert.equal(payload.rows[0].ledgerPackagePath, canonical);
  assert.equal(payload.rows[1].packagePath, null);
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

test("a receipt without the workspace spelling is untouched", () => {
  const receipt = { ok: true, evidence: JSON.stringify({ packagePath: canonical }) };
  assert.equal(translateReceiptPathCoordinates(receipt), receipt);
});

test("malformed evidence fails closed instead of printing a half-translated receipt", () => {
  assert.throws(
    () => translateReceiptPathCoordinates({ ok: true, evidence: '{"workspacePackagePath":' }),
    /CLI receipt evidence is not valid JSON/u,
  );
});
