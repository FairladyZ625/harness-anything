// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  readSettingsFacet,
  sha256Text,
  taskBootstrapWritePlan,
} from "@harness-anything/kernel";
import { compileRepoTaskBootstrap } from "@harness-anything/preset";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { locateTaskTransitionDocument } from "../src/transition-document-access.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  seedSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";

/** Compiles today's bootstrap for the task, then freezes it into the shape an early-October
 * contract had: the compiler-added explainer document never materialized. */
function seedLegacySlotTask(rootDir: string, repoId: string, taskId: string): string {
  const opId = "op-legacy-slot-bootstrap",
    compiled = compileRepoTaskBootstrap({
      rootDir,
      settings: readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8")),
      action: { kind: "task-create", title: "Legacy slots" },
      taskId,
      actor,
      source: "local",
      workspaceRevision: makeTaskEventReader({ repoId, rootDir }).read().revision + 1,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      opId,
      occurredAt: "2026-10-01T00:00:00.000Z",
    }),
    claimByPath = new Map(compiled.event.payload.initialDocumentClaims.map((claim) => [claim.path, claim])),
    contractClaim = claimByPath.get(`${compiled.packagePath}/task-contract.json`)!,
    contractBlob = compiled.blobs.find((blob) => blob.sha256 === contractClaim.sha256)!,
    contractValue = JSON.parse(contractBlob.body) as { readonly documents: readonly unknown[] },
    legacyDocuments = contractValue.documents.filter(
      (document) => (document as { readonly slot?: unknown })?.slot !== "task.explainer",
    ),
    contractBody = `${JSON.stringify({ ...contractValue, documents: legacyDocuments }, null, 2)}\n`,
    strippedSuffixes = ["/artifacts/explainer.html"],
    keepClaim = (claim: { readonly path: string }) => !strippedSuffixes.some((suffix) => claim.path.endsWith(suffix)),
    removedShas = new Set(
      compiled.event.payload.initialDocumentClaims.filter((claim) => !keepClaim(claim)).map(({ sha256 }) => sha256),
    ),
    initialDocumentClaims = compiled.event.payload.initialDocumentClaims
      .filter(keepClaim)
      .map((claim) =>
        claim === contractClaim
          ? { ...claim, sha256: sha256Text(contractBody), size: Buffer.byteLength(contractBody) }
          : claim,
      ),
    event = {
      ...compiled.event,
      payload: { ...compiled.event.payload, initialDocumentClaims },
    };
  assert.equal(
    legacyDocuments.length,
    contractValue.documents.length - 1,
    "fixture strips the compiler explainer slot",
  );
  const store = makeTaskEventStore({ repoId, rootDir });
  store.append({
    event,
    plan: taskBootstrapWritePlan(event),
    blobs: [
      ...compiled.blobs.filter((blob) => blob.sha256 !== contractClaim.sha256 && !removedShas.has(blob.sha256)),
      { ...contractBlob, sha256: sha256Text(contractBody), size: Buffer.byteLength(contractBody), body: contractBody },
    ],
  });
  void store.drain();
  return compiled.packagePath;
}

test("contract migrate backfills the compiler explainer slot a legacy contract predates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-legacy-slot-migrate-")),
    repoId = workspaceId("legacy-slot-migrate"),
    taskId = "task_legacy_slots",
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    seedSettingsEvent({ repoId: "legacy-slot-migrate", rootDir });
    const packagePath = seedLegacySlotTask(rootDir, repoId, taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy-slot-migrate" });
    const reader = makeTaskEventReader({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: reader }),
      revisionBefore = reader.read().revision;
    assert.equal(
      locateTaskTransitionDocument({ projection, taskId, slot: "task.plan" }).path,
      `${packagePath}/task_plan.md`,
      "the base scaffold slot the legacy contract does declare stays locatable",
    );
    const dryRun = await cell.run({ kind: "task-contract-migrate", taskId, mode: "dry-run" }, binding);
    assert.equal(dryRun.outcome, "pending", JSON.stringify(dryRun));
    const dryRunReport = JSON.parse(String(dryRun.evidence!)) as {
      readonly report: readonly {
        readonly status: string;
        readonly disposition?: string;
        readonly addedSlots?: readonly string[];
      }[];
    };
    assert.deepEqual(
      dryRunReport.report.map(({ status, disposition, addedSlots }) => ({ status, disposition, addedSlots })),
      [{ status: "repair", disposition: "document-slots-backfilled", addedSlots: ["task.explainer"] }],
    );
    assert.equal(reader.read().revision, revisionBefore, "dry-run must not append an event");
    const applied = await cell.run({ kind: "task-contract-migrate", taskId, mode: "apply" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    await waitForFixturePublication(cell, applied.opId, binding);
    const contract = JSON.parse(projection.readDocument(`${packagePath}/task-contract.json`).document!.body) as {
      readonly documents: readonly { readonly slot: string; readonly path: string }[];
    };
    assert.deepEqual(
      contract.documents.filter(({ slot }) => slot === "task.explainer").map(({ slot }) => slot),
      ["task.explainer"],
      "the applied repair registers the compiler slot on the contract",
    );
    const migrated = await cell.run({ kind: "task-contract-migrate", taskId, mode: "dry-run" }, binding);
    const migratedReport = JSON.parse(String(migrated.evidence!)) as {
      readonly report: readonly { readonly status: string }[];
    };
    assert.equal(migratedReport.report[0]!.status, "current", "a second run finds nothing left to backfill");
    await reader.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("contract migrate removes a retired fact override before projection reads validate stored tasks", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-retired-fact-override-migrate-")),
    repoId = workspaceId("retired-fact-override-migrate"),
    taskId = "task_retired_fact_override",
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    seedSettingsEvent({ repoId: "retired-fact-override-migrate", rootDir });
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "retired-fact-override-migrate" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Retired fact override" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const reader = makeTaskEventReader({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: reader }),
      current = projection.read(taskId),
      oldTask = {
        ...current.snapshot.task!,
        closeoutOverrides: { ...current.snapshot.task!.closeoutOverrides, fact: false },
      },
      oldSnapshot = { ...current.snapshot, task: oldTask },
      db = new DatabaseSync(projection.path);
    try {
      db.prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?").run(
        JSON.stringify(oldSnapshot),
        taskId,
      );
    } finally {
      db.close();
    }

    assert.throws(() => projection.read(taskId), /projection snapshot mismatch/u);
    const dryRun = await cell.run({ kind: "task-contract-migrate", taskId, mode: "dry-run" }, binding);
    assert.equal(dryRun.outcome, "pending", JSON.stringify(dryRun));
    const dryRunReport = JSON.parse(String(dryRun.evidence!)) as {
      readonly report: readonly { readonly taskId: string; readonly status: string; readonly disposition?: string }[];
    };
    assert.deepEqual(dryRunReport.report, [
      { taskId, status: "repair", disposition: "retired-fact-closeout-override" },
    ]);

    const applied = await cell.run({ kind: "task-contract-migrate", taskId, mode: "apply" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    await waitForFixturePublication(cell, applied.opId, binding);
    assert.equal(Object.hasOwn(projection.read(taskId).snapshot.task!, "closeoutOverrides"), false);
    const migration = reader
      .read()
      .events.findLast((event) => event.type === "task_contract_migrated" && event.taskId === taskId);
    assert.ok(migration, "cleanup is recorded as a task lifecycle event");
    assert.ok(migration.payload.mutation.fields.includes("closeoutOverrides.fact"));

    projection.rebuild();
    assert.doesNotThrow(() => projection.read(taskId));
    await reader.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
