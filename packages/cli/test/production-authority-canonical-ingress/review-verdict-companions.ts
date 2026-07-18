import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import type { ProductionCanonicalIngressFixture } from "./fixture.ts";

export function verifyReviewVerdictCompanions(
  fixture: ProductionCanonicalIngressFixture,
  env: NodeJS.ProcessEnv
): void {
  verifyChangesRequested(fixture, env);
  verifyDismissed(fixture, env);
}

function verifyChangesRequested(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): void {
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNH0";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNH1";
  const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "review-execution", taskId, "--execution-id", executionId,
    "--verdict", "changes_requested", "--findings", "Companion writes must be atomic.",
    "--rationale", "The submitted round needs another delivery."
  ], env);
  assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));
  assert.equal(reviewed.receipt.ok, true, JSON.stringify(reviewed.receipt));
  const reviewId = receiptReviewId(reviewed.receipt);
  const taskRoot = path.join(fixture.authoredRoot, "tasks", taskId);
  assert.equal(existsSync(path.join(taskRoot, "reviews", `${reviewId}.md`)), true);
  const execution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as {
    readonly state?: string;
    readonly closed_at?: string | null;
  };
  assert.equal(execution.state, "changes_requested");
  assert.equal(typeof execution.closed_at, "string");
  assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);
  const executionProjection = runRawJsonMaybeFail(fixture.repoRoot, ["execution", "show", executionId], env);
  assert.equal(executionProjection.status, 0, JSON.stringify(executionProjection.receipt));
  assert.match(JSON.stringify(executionProjection.receipt), /"state":"changes_requested"/u);
  const taskProjection = runRawJsonMaybeFail(fixture.repoRoot, ["task", "show", taskId], env);
  assert.equal(taskProjection.status, 0, JSON.stringify(taskProjection.receipt));
  assert.match(JSON.stringify(taskProjection.receipt), /active/u);
}

function verifyDismissed(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): void {
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNH2";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNH3";
  const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "review-execution", taskId, "--execution-id", executionId,
    "--verdict", "dismissed", "--findings", "This review round is not authoritative.",
    "--rationale", "Dismissal leaves the submitted delivery reviewable."
  ], env);
  assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));
  assert.equal(reviewed.receipt.ok, true, JSON.stringify(reviewed.receipt));
  const reviewId = receiptReviewId(reviewed.receipt);
  const taskRoot = path.join(fixture.authoredRoot, "tasks", taskId);
  assert.equal(existsSync(path.join(taskRoot, "reviews", `${reviewId}.md`)), true);
  const execution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as {
    readonly state?: string;
    readonly closed_at?: string | null;
  };
  assert.equal(execution.state, "submitted");
  assert.equal(execution.closed_at, null);
  assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
  const executionProjection = runRawJsonMaybeFail(fixture.repoRoot, ["execution", "show", executionId], env);
  assert.equal(executionProjection.status, 0, JSON.stringify(executionProjection.receipt));
  assert.match(JSON.stringify(executionProjection.receipt), /"state":"submitted"/u);
  const taskProjection = runRawJsonMaybeFail(fixture.repoRoot, ["task", "show", taskId], env);
  assert.equal(taskProjection.status, 0, JSON.stringify(taskProjection.receipt));
  assert.match(JSON.stringify(taskProjection.receipt), /in_review/u);
}

function receiptReviewId(receipt: { readonly details?: unknown }): string {
  const reviewId = String((receipt.details as { readonly data?: { readonly reviewId?: string } } | undefined)?.data?.reviewId ?? "");
  assert.match(reviewId, /^rev_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(receipt));
  return reviewId;
}
