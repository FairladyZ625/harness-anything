// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionSurfaceMaxItems,
  decisionSurfaceMaxLength,
  decisionSurfaceMaxTotalBytes
} from "../src/cli/decision-surface-values.ts";
import { parseDecisionSurfaceInputs } from "../src/cli/parsers/decision-surface-inputs.ts";
import {
  evaluateDecisionSurfaceAdmission,
  injectDecisionAdmissionReadSet,
  renderDecisionAdmissionReadSet
} from "../src/commands/core/decision-surface-admission.ts";
import { productionAuthorityHostServices } from "../src/composition/production-authority-host-services.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";

test("malformed shallow-cast surfaces fail open without blocking task write planning", () => {
  withRoot((rootDir) => {
    writeDecision(rootDir, "dec_VALID", "Valid decision", "valid-anchor");
    for (const malformed of ["valid-anchor", [null]]) {
      const admission = evaluateDecisionSurfaceAdmission(rootDir, malformed);
      assert.equal(admission.requested, true);
      assert.equal(admission.report.unavailable, "invalid_surface_payload");

      const planned = buildTaskWrites(rootDir, malformed);
      assert.equal(planned.ok, true);
      if (!planned.ok) continue;
      const readSet = planned.writes.find((write) => write.path === "read_set.md")?.body ?? "";
      assert.match(readSet, /invalid_surface_payload/u);
    }
  });
});

test("unavailable read-set bytes are stable across roots while diagnostics stay in receipts", () => {
  withRoot((leftRoot) => withRoot((rightRoot) => {
    const left = evaluateDecisionSurfaceAdmission(leftRoot, ["missing-root"]);
    const right = evaluateDecisionSurfaceAdmission(rightRoot, ["missing-root"]);
    const leftBody = renderDecisionAdmissionReadSet(left.report);
    const rightBody = renderDecisionAdmissionReadSet(right.report);

    assert.equal(left.report.unavailable, "decisions_root_unavailable");
    assert.equal(right.report.unavailable, "decisions_root_unavailable");
    assert.equal(leftBody, rightBody);
    assert.equal(leftBody.includes(leftRoot), false);
    assert.equal(rightBody.includes(rightRoot), false);
    assert.match(left.report.diagnostic ?? "", new RegExp(escapeRegExp(leftRoot), "u"));
    assert.match(right.report.diagnostic ?? "", new RegExp(escapeRegExp(rightRoot), "u"));
  }));
});

test("surface limits and short flag boundary are enforced by the canonical parser", () => {
  assert.equal(parseDecisionSurfaceInputs(["--surface", "-h"]).ok, false);
  assert.equal(parseDecisionSurfaceInputs([], Array.from({ length: decisionSurfaceMaxItems + 1 }, () => "x")).ok, false);
  assert.equal(parseDecisionSurfaceInputs([], ["x".repeat(decisionSurfaceMaxLength + 1)]).ok, false);
  const totalOverflow = Array.from(
    { length: Math.ceil(decisionSurfaceMaxTotalBytes / 120) },
    (_, index) => `${index}`.padEnd(120, "界")
  );
  assert.equal(parseDecisionSurfaceInputs([], totalOverflow).ok, false);
  assert.deepEqual(parseDecisionSurfaceInputs(["--surface=-h"]), { ok: true, value: ["-h"] });
});

test("bad and non-regular decision documents are skipped without erasing scan counts", () => {
  withRoot((rootDir) => {
    writeDecision(rootDir, "dec_VALID", "Valid decision", "damage-anchor");
    const decisionsRoot = path.join(rootDir, "harness", "decisions");
    const nonRegular = path.join(decisionsRoot, "decision-dec_NON_REGULAR", "decision.md");
    mkdirSync(nonRegular, { recursive: true });
    const malformed = path.join(decisionsRoot, "decision-dec_MALFORMED", "decision.md");
    mkdirSync(path.dirname(malformed), { recursive: true });
    writeFileSync(malformed, "damage-anchor\nnot a decision document\n", "utf8");

    const admission = evaluateDecisionSurfaceAdmission(rootDir, ["damage-anchor"]);
    assert.equal(admission.report.unavailable, undefined);
    assert.equal(admission.report.scannedDecisionCount, 3);
    assert.equal(admission.report.skippedDecisionCount, 2);
    assert.deepEqual(admission.report.candidates.map((candidate) => candidate.decisionId), ["dec_VALID"]);
  });
});

test("existing read_set content is preserved and its controlled admission section is replaced", () => {
  withRoot((rootDir) => {
    writeDecision(rootDir, "dec_MARKDOWN", "Title `code` *bold*", "anchor`tick");
    const initial = injectDecisionAdmissionReadSet([
      { path: "read_set.md", body: "# Custom read set\n\nKeep this custom content.\n" }
    ], {
      rootInput: rootDir,
      taskId: "task_MERGE",
      surfaces: ["anchor`tick"]
    });
    const firstBody = initial[0]!.body;
    assert.match(firstBody, /Keep this custom content/u);
    assert.match(firstBody, /anchor&#96;tick/u);
    assert.match(firstBody, /Title \\`code\\` \\\*bold\\\*/u);

    const replaced = injectDecisionAdmissionReadSet(initial, {
      rootInput: rootDir,
      taskId: "task_MERGE",
      surfaces: ["no-match"]
    });
    const body = replaced[0]!.body;
    assert.equal(body.split("<!-- decision-surface-admission:start -->").length - 1, 1);
    assert.match(body, /Keep this custom content/u);
    assert.match(body, /no-match/u);
    assert.equal(body.includes("anchor&#96;tick"), false);
  });
});

function buildTaskWrites(rootDir: string, surfaces: unknown) {
  return productionAuthorityHostServices.buildTaskCreateWrites({
    rootInput: rootDir,
    action: {
      kind: "new-task",
      taskId: "task_MALFORMED",
      title: "Malformed admission remains soft",
      slug: "malformed-admission-remains-soft",
      allowManualId: false,
      titleProvided: true,
      slugProvided: false,
      surfaces: surfaces as never,
      longRunning: false,
      dryRun: false
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    provenance: {
      runtime: "codex",
      sessionId: "session-admission-edge",
      boundAt: "2026-07-29T00:00:00.000Z"
    }
  });
}

function withRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-admission-edge-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeDecision(rootDir: string, decisionId: string, title: string, body: string): void {
  const decisionRoot = path.join(rootDir, "harness", "decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${title}"`,
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedAt: \"2026-07-01T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"test\", sessionId: \"session-fixture\", boundAt: \"2026-07-01T00:00:00.000Z\" }",
    "question: \"Should this fixture exist?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Keep the fixture deterministic\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Remove the fixture\", why_not: \"The admission test needs it\" }",
    "claims:",
    "  - { id: \"C1\", text: \"The fixture is searchable\" }",
    "relations:",
    "---",
    "",
    body,
    ""
  ].join("\n"), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
