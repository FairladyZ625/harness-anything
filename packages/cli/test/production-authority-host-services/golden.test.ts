// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  ProductionAuthorityDecisionProposeAction,
  ProductionAuthorityNewTaskAction
} from "@harness-anything/application";
import { productionAuthorityHostServices as host } from "../../src/composition/production-authority-host-services.ts";

const golden = JSON.parse(readFileSync(
  new URL("../../../daemon/test/fixtures/batch5a-equivalence-golden.json", import.meta.url),
  "utf8"
)) as Record<string, unknown>;

test("production authority CLI host capabilities retain their pre-extraction bytes", () => {
  const decisionAction: ProductionAuthorityDecisionProposeAction = {
    kind: "decision-propose",
    decisionId: "dec_GOLDEN",
    proposedAt: "2026-07-20T00:00:00.000Z",
    title: "Golden decision",
    question: "Keep bytes?",
    chosen: [{ id: "CH1", text: "Yes", load_bearing: true }],
    rejected: [{ id: "RJ1", text: "No", why_not: "Breaks parity" }],
    claims: [{ id: "C1", text: "Bytes stay stable", load_bearing: true }],
    claimLoadBearing: true,
    fulfillments: [],
    riskTier: "medium",
    urgency: "high",
    modules: ["daemon"],
    productLines: ["authority"],
    evidenceRelations: [],
    dryRun: false
  };
  const normalized = host.normalizeDecisionProposeAction(decisionAction);
  const capabilityBytes = JSON.stringify({
    ingress: host.productionAuthorityIngressFor("new-task"),
    unsupported: host.productionAuthorityUnsupportedHint("golden-unsupported"),
    factSource: host.normalizedFactSource({
      kind: "record-fact",
      taskId: "task_GOLDEN",
      factId: "fact_GOLDEN",
      statement: "stable",
      source: "session/golden",
      observedAt: "2026-07-20T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      dryRun: false
    }),
    forceAudit: host.renderForceStatusAudit("completed", "golden reason", "2026-07-20T00:00:00.000Z"),
    normalized,
    materialized: host.materializeProposedDecision(normalized),
    relation: host.decisionRelationRecord({
      decisionId: "dec_GOLDEN",
      anchor: "C1",
      target: "task/task_GOLDEN",
      relationType: "supports",
      rationale: "golden"
    })
  });
  assert.equal(capabilityBytes, JSON.stringify(golden.hostCapabilities));
});

test("production authority adapter/settings task writes retain their pre-extraction bytes", () => {
  const action: ProductionAuthorityNewTaskAction = {
    kind: "new-task",
    taskId: "task_GOLDEN",
    title: "Golden task",
    slug: "golden-task",
    allowManualId: false,
    longRunning: false,
    dryRun: false
  };
  const result = host.buildTaskCreateWrites({
    rootInput: { rootDir: "/definitely-missing-golden-root" },
    action,
    createdAt: "2026-07-20T00:00:00.000Z",
    provenance: {
      runtime: "codex",
      sessionId: "session-golden",
      boundAt: "2026-07-20T00:00:00.000Z"
    }
  });
  assert.equal(JSON.stringify(result), JSON.stringify(golden.taskCreateWrites));
});

test("batch 4 receipt/error bytes remain the batch 5A baseline", () => {
  const bytes = readFileSync(new URL("../../../daemon/test/fixtures/batch4-equivalence-golden.json", import.meta.url));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    golden.batch4ReceiptErrorFixtureSha256
  );
});
