import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import {
  authorityOperationRecords,
  latestAuthorityOperation,
  type ProductionCanonicalIngressFixture,
  writeColdCodexSessionLog
} from "./fixture.ts";
import { authorityOperationProofShape } from "./operation-shape.ts";

export function verifyExplicitTaskSubmitIngress(input: {
  readonly fixture: ProductionCanonicalIngressFixture;
  readonly env: Readonly<Record<string, string>>;
  readonly taskId: string;
  readonly executionId: string;
  readonly leaseToken: string;
}) {
  const { fixture, env, taskId, executionId, leaseToken } = input;
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `tasks/${taskId}/executions/${executionId}.md`
  ), "utf8"), /^  "state": "active",$/mu);
  const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "submit", taskId, "--json-input", JSON.stringify({
      completionClaim: "Explicit execution submit is atomic.",
      deliverables: [],
      outputs: [],
      verificationNotes: ["Production daemon explicit route passed."],
      knownGaps: [],
      residualRisks: [],
      executionId,
      leaseToken
    })
  ], env);
  assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
  assert.equal(submitted.receipt.ok, true, JSON.stringify(submitted.receipt));
  const operation = latestAuthorityOperation(fixture.serviceRoot);
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `tasks/${taskId}/executions/${executionId}.md`
  ), "utf8"), /^  "state": "submitted",$/mu);
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `tasks/${taskId}/INDEX.md`
  ), "utf8"), /^  status: in_review$/mu);
  const executionProjection = runRawJsonMaybeFail(fixture.repoRoot, [
    "execution", "show", executionId
  ], env);
  assert.equal(executionProjection.status, 0, JSON.stringify(executionProjection.receipt));
  assert.match(JSON.stringify(executionProjection.receipt), /"state":"submitted"/u);
  const taskProjection = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "show", taskId
  ], env);
  assert.equal(taskProjection.status, 0, JSON.stringify(taskProjection.receipt));
  assert.match(JSON.stringify(taskProjection.receipt), /in_review/u);
  return operation;
}

export function verifyInferredTaskSubmitIngress(input: {
  readonly fixture: ProductionCanonicalIngressFixture;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly comparisonOperation: unknown;
}): {
  readonly env: Readonly<Record<string, string>>;
  readonly taskId: string;
  readonly executionId: string;
} {
  const { fixture, baseEnv, comparisonOperation } = input;
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "service-slugged-lifecycle-session";
  writeColdCodexSessionLog(fixture.repoRoot, sessionId);
  const env = { ...baseEnv, CODEX_THREAD_ID: sessionId };
  const exportedSession = runRawJsonMaybeFail(fixture.repoRoot, [
    "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
    "--detected-at", "2026-07-17T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
  ], env);
  assert.equal(exportedSession.status, 0, JSON.stringify(exportedSession.receipt));
  assert.equal(exportedSession.receipt.ok, true, JSON.stringify(exportedSession.receipt));
  const claimed = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "claim", taskId, "--execution-id", executionId
  ], env);
  assert.equal(claimed.status, 0, JSON.stringify(claimed.receipt));
  assert.equal(claimed.receipt.ok, true, JSON.stringify(claimed.receipt));

  const packetPath = path.join(fixture.root, "slugged-submission.json");
  writeFileSync(packetPath, JSON.stringify({
    completionClaim: "Slugged production lifecycle is complete.",
    deliverables: ["Canonical slug-aware lifecycle intents."],
    outputs: ["slugged lifecycle passed"],
    verificationNotes: ["Production daemon route passed."],
    knownGaps: [], residualRisks: []
  }));
  const beforeSubmit = authorityOperationRecords(fixture.serviceRoot).length;
  const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "submit", taskId, "--from-file", packetPath
  ], env);
  assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
  assert.equal(submitted.receipt.ok, true, JSON.stringify(submitted.receipt));
  const submitData = (submitted.receipt.details as {
    readonly data?: {
      readonly executionId?: unknown;
      readonly report?: { readonly leaseReleased?: unknown };
    };
  } | undefined)?.data ?? {};
  assert.equal(submitData.executionId, executionId, JSON.stringify(submitted.receipt));
  assert.equal(submitData.report?.leaseReleased, true, JSON.stringify(submitted.receipt));
  assert.equal(authorityOperationRecords(fixture.serviceRoot).length, beforeSubmit + 1,
    "task submit must publish one execution-submit operation; owner completion owns code-doc reconciliation");
  const operation = latestAuthorityOperation(fixture.serviceRoot);
  assert.deepEqual(
    authorityOperationProofShape(operation),
    authorityOperationProofShape(comparisonOperation),
    "inferred execution-submit must preserve every stored authority proof category"
  );
  assert.equal(existsSync(path.join(
    fixture.authoredRoot,
    `tasks/${taskId}-production-route/code-doc-anchors.json`
  )), false, "task submit must not reconcile code-doc anchors before owner completion");
  assert.equal(existsSync(path.join(fixture.authoredRoot, `tasks/${taskId}`)), false);
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `tasks/${taskId}-production-route/executions/${executionId}.md`
  ), "utf8"), /^  "state": "submitted",$/mu);
  assert.match(readFileSync(path.join(
    fixture.authoredRoot, `tasks/${taskId}-production-route/INDEX.md`
  ), "utf8"), /^  status: in_review$/mu);
  const executionProjection = runRawJsonMaybeFail(fixture.repoRoot, [
    "execution", "show", executionId
  ], env);
  assert.equal(executionProjection.status, 0, JSON.stringify(executionProjection.receipt));
  assert.match(JSON.stringify(executionProjection.receipt), /"state":"submitted"/u);
  const taskProjection = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "show", taskId
  ], env);
  assert.equal(taskProjection.status, 0, JSON.stringify(taskProjection.receipt));
  assert.match(JSON.stringify(taskProjection.receipt), /in_review/u);
  return { env, taskId, executionId };
}
