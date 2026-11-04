// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareLegacyAudit } from "./fixtures/g38-read-legacy.mjs";
import { runLedgerReconcileAction } from "../src/repo-cell-migration-actions.ts";

test("ledger-reconcile audits generation 1 even when the canonical generation has advanced", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-reconcile-gen1-")),
    context = { rootDir };
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  prepareLegacyAudit(context, "source-events", 2);
  const report = await runLedgerReconcileAction(
    {
      rootDir: context.legacyRootDir,
      input: { repoId: "g38-read" },
      store: { readHead: () => null },
      operationId: () => "reconcile-regression",
      readResult: (_opId, value) => value,
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
    },
    { kind: "ledger-reconcile", generation: 1 },
    {},
  );
  assert.equal(report.generation, 1);
  assert.equal(report.matches, true, JSON.stringify(report.differences));
  assert.equal(report.actual.events, 2);
});
