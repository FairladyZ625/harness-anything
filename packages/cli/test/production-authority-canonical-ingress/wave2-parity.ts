import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseDecisionDocument } from "../../../kernel/src/index.ts";
import { runRawJsonMaybeFail } from "../helpers/daemon-cli.ts";
import { createFixture, type ProductionCanonicalIngressFixture } from "./fixture.ts";

export function verifyWave2CanonicalParity(
  daemonFixture: ProductionCanonicalIngressFixture,
  daemonEnv: NodeJS.ProcessEnv
): void {
  const directFixture = createFixture();
  const directEnv = { ...daemonEnv, HARNESS_DAEMON_MODE: "direct", HARNESS_AUTHORITY_MANIFEST: "" };
  const failures: Error[] = [];
  const check = (assertion: () => void): void => {
    try { assertion(); } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
  };
  try {
    const directDecision = proposeRichPacket(directFixture, directEnv);
    const daemonDecision = proposeRichPacket(daemonFixture, daemonEnv);
    check(() => assert.deepEqual(normalizedDecision(daemonFixture, daemonDecision), normalizedDecision(directFixture, directDecision)));
    check(() => assert.deepEqual(decisionEnrichment(daemonFixture, daemonDecision), decisionEnrichment(directFixture, directDecision)));
    check(() => assert.deepEqual(decisionEnrichment(directFixture, directDecision), {
      chosen: [{ id: "CH1", text: "Preserve explicit load bearing", load_bearing: true }],
      claims: [{ id: "C1", text: "Rich packet survives ingress", load_bearing: true, fulfillment: "delivered" }],
      relations: [{ sourceAnchor: "C1", target: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", type: "relates", rationale: "wave2 evidence" }]
    }));

    claimPriorityTask(directFixture, directEnv);
    claimPriorityTask(daemonFixture, daemonEnv);
    relateDerives(directFixture, directEnv, directDecision);
    relateDerives(daemonFixture, daemonEnv, daemonDecision);
    check(() => assert.equal(priorityLines(daemonFixture), priorityLines(directFixture)));
    check(() => assert.equal(priorityLines(directFixture), "riskTier: high\nurgency: low"));

    forceCancel(directFixture, directEnv);
    forceCancel(daemonFixture, daemonEnv);
    check(() => assert.match(progressBody(directFixture), /FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=wave2 parity/u));
    check(() => assert.match(progressBody(daemonFixture), /FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=wave2 parity/u));

    submitWithFinalizedBinding(directFixture, directEnv);
    submitWithFinalizedBinding(daemonFixture, daemonEnv);
    check(() => assert.equal(bindingFinalization(daemonFixture).archive_status, bindingFinalization(directFixture).archive_status));
    check(() => assert.equal(typeof bindingFinalization(daemonFixture).capture_range?.end_at, typeof bindingFinalization(directFixture).capture_range?.end_at));
    check(() => assert.equal(bindingFinalization(directFixture).archive_status, "complete"));
    check(() => assert.equal(typeof bindingFinalization(directFixture).capture_range?.end_at, "string"));
    if (failures.length > 0) throw new AggregateError(failures, "wave2 canonical parity mismatches");
  } finally {
    rmSync(directFixture.root, { recursive: true, force: true });
  }
}

function claimPriorityTask(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): void {
  const result = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"], env);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
}

function proposeRichPacket(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): string {
  const result = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "propose", "--title", "Wave2 rich proposal", "--question", "Does enrichment cross canonical ingress?",
    "--chosen", JSON.stringify({ id: "CH1", text: "Preserve explicit load bearing", load_bearing: true }),
    "--rejected", "Drop daemon-only fields", "--why-not", "Canonical parity is required",
    "--claim", JSON.stringify({ id: "C1", text: "Rich packet survives ingress", load_bearing: true }),
    "--fulfillment", "C1:delivered", "--evidence-relation",
    "C1:relates:task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4:wave2 evidence",
    "--risk-tier", "high", "--urgency", "low"
  ], env);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
  const decisionId = String((result.receipt.details as { readonly data?: { readonly decisionId?: string } } | undefined)?.data?.decisionId ?? "");
  assert.match(decisionId, /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u);
  return decisionId;
}

function decisionEnrichment(fixture: ProductionCanonicalIngressFixture, decisionId: string) {
  const decision = readDecision(fixture, decisionId);
  return {
    chosen: decision.chosen,
    claims: decision.claims,
    relations: decision.relations.map((relation) => ({
      sourceAnchor: relation.source.split("/").at(-1), target: relation.target,
      type: relation.type, rationale: relation.rationale
    }))
  };
}

function normalizedDecision(fixture: ProductionCanonicalIngressFixture, decisionId: string) {
  const decision = readDecision(fixture, decisionId);
  const { _coordinatorWatermark: _watermark, proposedAt: _proposedAt, provenance: _provenance, ...stable } = decision;
  return {
    ...stable,
    decision_id: "<generated>",
    relations: decision.relations.map(({ relation_id: _relationId, source, ...relation }) => ({
      ...relation,
      relation_id: "<derived>",
      source: source.replace(`decision/${decisionId}/`, "decision/<generated>/")
    }))
  };
}

function readDecision(fixture: ProductionCanonicalIngressFixture, decisionId: string) {
  return parseDecisionDocument(readFileSync(path.join(
    fixture.authoredRoot, `decisions/decision-${decisionId}/decision.md`
  ), "utf8")).decision;
}

function relateDerives(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv, decisionId: string): void {
  const result = runRawJsonMaybeFail(fixture.repoRoot, [
    "decision", "relate", decisionId, "--anchor", "C1", "--type", "derives",
    "--target", "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--rationale", "materialize priority"
  ], env);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
}

function priorityLines(fixture: ProductionCanonicalIngressFixture): string {
  const body = readFileSync(path.join(fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/INDEX.md"), "utf8");
  return [...body.matchAll(/^(?:riskTier|urgency): .+$/gmu)].map((match) => match[0]).join("\n");
}

function forceCancel(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): void {
  const result = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "transition", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "cancelled", "--force", "--reason", "wave2 parity"
  ], env);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
  assert.equal(result.receipt.ok, true, JSON.stringify(result.receipt));
}

function progressBody(fixture: ProductionCanonicalIngressFixture): string {
  return readFileSync(path.join(fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"), "utf8");
}

function submitWithFinalizedBinding(fixture: ProductionCanonicalIngressFixture, env: NodeJS.ProcessEnv): void {
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNJ0";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNJ1";
  const sessionId = "service-wave2-submit-session";
  const sessionEnv = { ...env, CODEX_THREAD_ID: sessionId };
  const exported = runRawJsonMaybeFail(fixture.repoRoot, [
    "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
    "--detected-at", "2026-07-17T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
  ], sessionEnv);
  assert.equal(exported.status, 0, JSON.stringify(exported.receipt));
  const claimed = runRawJsonMaybeFail(fixture.repoRoot, ["task", "claim", taskId, "--execution-id", executionId], sessionEnv);
  assert.equal(claimed.status, 0, JSON.stringify(claimed.receipt));
  const leaseToken = String((claimed.receipt.details as { readonly report?: { readonly leaseToken?: string } } | undefined)?.report?.leaseToken ?? "");
  assert.notEqual(leaseToken, "", JSON.stringify(claimed.receipt));
  const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
    "task", "transition", taskId, "in_review", "--execution-id", executionId, "--lease-token", leaseToken,
    "--completion-claim", "Wave2 binding finalization", "--verification", "A/B parity"
  ], sessionEnv);
  assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
}

function bindingFinalization(fixture: ProductionCanonicalIngressFixture) {
  const execution = JSON.parse(readFileSync(path.join(
    fixture.authoredRoot,
    "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNJ0/executions/exe_01KXQ4WTA7Q4XJ5GDDRS1YXNJ1.md"
  ), "utf8")) as { readonly session_bindings: ReadonlyArray<{ readonly archive_status: string; readonly capture_range: { readonly end_at: string | null } | null }> };
  return execution.session_bindings[0]!;
}
