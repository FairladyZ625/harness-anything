// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSettingsFacet, type TaskV2 } from "@harness-anything/kernel";
import { compileRepoTaskPackage } from "@harness-anything/preset";
import { backfillRestatedContractDocuments } from "../src/migration-import-task-restatement.ts";
import { withBackfilledContractDocuments } from "../src/repo-cell-task-maintenance.ts";
import { taskMutation } from "../src/repo-cell-task-mutation.ts";
import type { RepoCellActionContext, RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";

function compileCurrentContract(rootDir: string): { readonly body: string; readonly digest: `sha256:${string}` } {
  const compiled = compileRepoTaskPackage({
    rootDir,
    settings: readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8")),
    action: { kind: "task-create", title: "Legacy slots" },
    taskId: "task_legacy_slots",
  });
  const contract = compiled.documents.find(({ slot }) => slot === "task.contract")!;
  return { body: contract.body, digest: compiled.snapshot.digest };
}

function slotFixture(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-slot-backfill-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  return rootDir;
}

function legacyContractBody(currentBody: string): string {
  const contract = JSON.parse(currentBody) as { readonly documents: readonly unknown[] };
  return `${JSON.stringify(
    {
      ...contract,
      documents: contract.documents.filter(
        (document) => (document as { readonly slot?: unknown }).slot !== "task.explainer",
      ),
    },
    null,
    2,
  )}\n`;
}

function cellHolding(rootDir: string, task: TaskV2, contractBody: string): RepoCellOperationalContext {
  return {
    rootDir,
    projectionReady: (read: { readonly watermark: number; readonly sourceRevision: number }) =>
      read.watermark >= read.sourceRevision,
    projection: {
      read: () => ({
        snapshot: { task },
        packagePath: "tasks/task_legacy_slots-legacy-slots",
        watermark: 7,
        sourceRevision: 7,
      }),
      readDocument: (documentPath: string) => ({
        watermark: 7,
        sourceRevision: 7,
        document: { path: documentPath, body: contractBody, blobSha256: "accepted", workspaceRevision: 7 },
      }),
    },
  } as unknown as RepoCellOperationalContext;
}

function legacyTask(digest: `sha256:${string}`): TaskV2 {
  return {
    taskId: "task_legacy_slots",
    title: "Legacy slots",
    taskClass: "standard",
    status: "planned",
    contractVersion: 1,
    presetSnapshotDigest: digest,
    metadata: { presetId: "standard-task", profileId: "baseline", verticalId: "software/coding", slug: "legacy-slots" },
  } as unknown as TaskV2;
}

const codedCell = {
  cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
} as unknown as RepoCellActionContext;

test("backfill appends only the descriptors the contract predates and keeps declared ones untouched", () => {
  const current = {
      documents: [
        { slot: "task.index", path: "INDEX.md" },
        { slot: "task.plan", path: "task_plan.md" },
      ],
    },
    compiled = {
      documents: [
        { slot: "task.index", path: "INDEX.md" },
        { slot: "task.plan", path: "task_plan.md" },
        { slot: "task.explainer", path: "artifacts/explainer.html" },
      ],
    },
    backfill = backfillRestatedContractDocuments(`${JSON.stringify(current)}\n`, `${JSON.stringify(compiled)}\n`)!;
  assert.deepEqual(backfill.addedSlots, ["task.explainer"]);
  const restated = JSON.parse(backfill.body) as { readonly documents: readonly { readonly slot: string }[] };
  assert.deepEqual(
    restated.documents.map(({ slot }) => slot),
    ["task.index", "task.plan", "task.explainer"],
  );
  assert.deepEqual(
    restated.documents.slice(0, 2),
    current.documents as unknown as readonly { readonly slot: string }[],
    "declared descriptors stay untouched",
  );
  assert.equal(
    backfillRestatedContractDocuments(`${JSON.stringify(compiled)}\n`, `${JSON.stringify(compiled)}\n`),
    null,
  );
});

test("contract migrate upgrades a current verdict to a repair that backfills missing compiler slots", () => {
  const rootDir = slotFixture();
  try {
    const current = compileCurrentContract(rootDir),
      task = legacyTask(current.digest),
      legacyBody = legacyContractBody(current.body),
      row = withBackfilledContractDocuments(
        cellHolding(rootDir, task, legacyBody),
        task.taskId,
        { taskId: task.taskId, status: "current" },
        new Map(),
      );
    assert.equal(row.status, "repair");
    assert.equal(row.disposition, "document-slots-backfilled");
    assert.deepEqual(row.addedSlots, ["task.explainer"]);
    const upToDate = withBackfilledContractDocuments(
      cellHolding(rootDir, task, current.body),
      task.taskId,
      { taskId: task.taskId, status: "current" },
      new Map(),
    );
    assert.equal(upToDate.status, "current", "a contract that declares every compiled slot stays current");
    const drifted = withBackfilledContractDocuments(
      cellHolding(rootDir, legacyTask(`sha256:${"0".repeat(64)}`), legacyBody),
      task.taskId,
      { taskId: task.taskId, status: "current" },
      new Map(),
    );
    assert.equal(drifted.status, "current", "a preset digest that no longer compiles is the preset-upgrade route");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("contract migrate mutation accepts a repair body on a current contract and audits the backfill", () => {
  const rootDir = slotFixture();
  try {
    const current = compileCurrentContract(rootDir),
      snapshot = { lease: null } as unknown as Parameters<typeof taskMutation>[3];
    const restated = taskMutation(
      codedCell,
      {
        kind: "task-contract-migrate",
        taskId: "task_legacy_slots",
        repairTaskContractBody: legacyContractBody(current.body),
      },
      legacyTask(current.digest),
      snapshot,
      { actor: "operator", source: "local" } as const,
    );
    assert.equal(restated.type, "task_contract_migrated");
    assert.match(restated.audit.reason, /Backfilled document slots/u);
    assert.throws(
      () =>
        taskMutation(
          codedCell,
          { kind: "task-contract-migrate", taskId: "task_legacy_slots" },
          legacyTask(current.digest),
          snapshot,
          { actor: "operator", source: "local" } as const,
        ),
      (error: unknown) => (error as { readonly code?: string }).code === "contract_current",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
