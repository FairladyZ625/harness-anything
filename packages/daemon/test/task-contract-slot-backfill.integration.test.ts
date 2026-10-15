// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { locateTaskTransitionDocument, readTaskTransitionDocument } from "../src/transition-document-access.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  seedSettingsEvent,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { checkPrBodyBilingual } from "../../../tools/check-pr-body-bilingual.mjs";

const PR_TEMPLATE =
  "# English\n\n## Summary\n\n-\n\n## What Changed\n\n-\n\n---\n\n# 中文\n\n## 概要\n\n-\n\n## 改动内容\n\n-\n";

const PR_BODY = PR_TEMPLATE.replace(
  "## Summary\n\n-",
  "## Summary\n\nThe backfilled contract lets the worker's PR body reach the pull request through the task route alone.",
)
  .replace(
    "## What Changed\n\n-",
    "## What Changed\n\nContract migration appends the document descriptors the package compiler adds, so no hand edit of the contract is needed.",
  )
  .replace("## 概要\n\n-", "## 概要\n\n补齐后的合同让工作者的拉取请求正文沿任务路径直达开拉取请求这一步。")
  .replace("## 改动内容\n\n-", "## 改动内容\n\n合同迁移追加编译器新增的文档描述符，无需手改合同文件。");

/** Compiles today's bootstrap for the task, then freezes it into the shape an early-October
 * contract had: the compiler-added explainer and pr-body documents never materialized. */
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
      (document) =>
        !(
          typeof (document as { readonly slot?: unknown })?.slot === "string" &&
          ["task.explainer", "task.pr-body"].includes((document as { readonly slot: string }).slot)
        ),
    ),
    contractBody = `${JSON.stringify({ ...contractValue, documents: legacyDocuments }, null, 2)}\n`,
    strippedSuffixes = ["/artifacts/explainer.html", "/artifacts/pr-body.md"],
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
  assert.equal(legacyDocuments.length, contractValue.documents.length - 2, "fixture strips both compiler slots");
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

test("contract migrate backfills compiler document slots a legacy contract predates and unblocks the task PR route", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-legacy-slot-migrate-")),
    repoId = workspaceId("legacy-slot-migrate"),
    taskId = "task_legacy_slots",
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, ".github"), { recursive: true });
    writeFileSync(path.join(rootDir, ".github", "pull_request_template.md"), PR_TEMPLATE);
    seedSettingsEvent({ repoId: "legacy-slot-migrate", rootDir });
    const packagePath = seedLegacySlotTask(rootDir, repoId, taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy-slot-migrate" });
    const reader = makeTaskEventReader({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: reader }),
      revisionBefore = reader.read().revision;
    // The pre-fix dead end: the contract declares no task.pr-body document, so the task PR
    // precondition has no slot to read, while contract migrate reports the task as current.
    assert.equal(
      locateTaskTransitionDocument({ projection, taskId, slot: "task.pr-body" }).path,
      null,
      "the legacy contract declares no pr-body slot",
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
      [{ status: "repair", disposition: "document-slots-backfilled", addedSlots: ["task.explainer", "task.pr-body"] }],
    );
    assert.equal(reader.read().revision, revisionBefore, "dry-run must not append an event");
    const applied = await cell.run({ kind: "task-contract-migrate", taskId, mode: "apply" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    await waitForFixturePublication(cell, applied.opId, binding);
    const contract = JSON.parse(projection.readDocument(`${packagePath}/task-contract.json`).document!.body) as {
      readonly documents: readonly { readonly slot: string; readonly path: string }[];
    };
    assert.deepEqual(
      contract.documents
        .filter(({ slot }) => ["task.explainer", "task.pr-body"].includes(slot))
        .map(({ slot }) => slot),
      ["task.explainer", "task.pr-body"],
      "the applied repair registers both compiler slots on the contract",
    );
    const migrated = await cell.run({ kind: "task-contract-migrate", taskId, mode: "dry-run" }, binding);
    const migratedReport = JSON.parse(String(migrated.evidence!)) as {
      readonly report: readonly { readonly status: string }[];
    };
    assert.equal(migratedReport.report[0]!.status, "current", "a second run finds nothing left to backfill");
    writeFileSync(path.join(rootDir, "harness", packagePath, "artifacts", "pr-body.md"), PR_BODY);
    const submitted = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/artifacts/pr-body.md`] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, binding);
    const prBody = readTaskTransitionDocument({ projection, taskId, slot: "task.pr-body" });
    assert.equal(prBody.body, PR_BODY);
    assert.equal(prBody.path, `${packagePath}/artifacts/pr-body.md`);
    assert.equal(
      checkPrBodyBilingual(prBody.body).ok,
      true,
      "the body the task PR precondition reads passes the bilingual gate",
    );
    await reader.drain();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
