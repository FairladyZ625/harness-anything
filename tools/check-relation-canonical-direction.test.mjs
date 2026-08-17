// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkDirectionBijection,
  checkGuiMirrorAgreement,
  checkNoRetiredAliasReads,
  checkRegistryShape,
  checkRetiredReverseTriplesRefused,
  checkReverseQueryAgreement
} from "./check-relation-canonical-direction.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const realModules = await import(
  new URL("../packages/kernel/src/domain/relation-direction.ts", import.meta.url)
);
const realAllowlist = await import(
  new URL("../packages/kernel/src/domain/entity-relation.ts", import.meta.url)
);
const real = { ...realAllowlist, ...realModules };

test("canonical direction check accepts the repository", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-relation-canonical-direction.mjs")], {
    cwd: repoRoot, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Canonical relation direction check passed/);
});

test("pure checks accept the real kernel modules", () => {
  assert.deepEqual([
    ...checkRegistryShape(real),
    ...checkDirectionBijection(real),
    ...checkRetiredReverseTriplesRefused(real),
    ...checkReverseQueryAgreement(real)
  ], []);
});

test("bypass fixture: re-widening the write surface to a retired mirror fails", () => {
  // Simulates a regression that re-adds fact→decision supports (or task→task blocks)
  // to the allowlist and the registry together: the ratchet must still refuse.
  const widened = {
    ...real,
    isAllowedRelationKindTriple: () => true,
    canonicalRelationDirections: [
      ...real.canonicalRelationDirections,
      { type: "supports", sourceKind: "fact", targetKind: "decision", reads: "widened", registration: "ratified" }
    ]
  };
  const findings = [
    ...checkRegistryShape(widened),
    ...checkDirectionBijection(widened),
    ...checkRetiredReverseTriplesRefused(widened)
  ];
  assert.ok(findings.some((finding) => finding.includes("fact --supports--> decision must stay unwritable")), findings.join("\n"));
});

test("bypass fixture: an allowlist that drifts from the registry fails the bijection", () => {
  const drifted = {
    ...real,
    isAllowedRelationKindTriple: (sourceKind, type, targetKind) =>
      !(sourceKind === "task" && type === "depends-on" && targetKind === "task") &&
      real.isAllowedRelationKindTriple(sourceKind, type, targetKind)
  };
  const findings = checkDirectionBijection(drifted);
  assert.ok(findings.some((finding) => finding.includes("task --depends-on--> task")), findings.join("\n"));
});

test("bypass fixture: a reverse query that answers from the wrong endpoint fails", () => {
  const flipped = {
    ...real,
    incomingRelations: (sourceRef, type, edges) => edges.filter((edge) => edge.source === sourceRef && edge.type === type)
  };
  const findings = checkReverseQueryAgreement(flipped);
  assert.ok(findings.length > 0, "the agreement probe must catch a reverse query keyed on the wrong endpoint");
});

test("bypass fixture: a renderer mirror that drifts from the kernel query fails", async () => {
  const guiMirror = await import(new URL("../packages/gui/src/renderer/model/relation-direction.ts", import.meta.url));
  const drifted = (targetRef, kind, relations) =>
    relations.filter((relation) => relation.to === targetRef && relation.kind === kind && relation.from.startsWith("decision/"));
  const kernelFindings = checkGuiMirrorAgreement(real, guiMirror.incomingRelations);
  assert.deepEqual(kernelFindings, []);
  const driftedFindings = checkGuiMirrorAgreement(real, drifted);
  assert.ok(driftedFindings.some((finding) => finding.includes("renderer reverse-query mirror disagrees")), driftedFindings.join("\n"));
});

test("bypass fixture: a production source re-reading the retired alias fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ironlaw3-alias-"));
  try {
    mkdirSync(path.join(root, "packages/app/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/app/src/consumer.ts"),
      'const refuted = relations.filter((r) => r.kind === "invalidated-by");\n');
    const findings = checkNoRetiredAliasReads(root);
    assert.ok(findings.some((finding) => finding.includes("consumer.ts")), findings.join("\n"));
    writeFileSync(path.join(root, "packages/app/src/vocabulary.ts"),
      'export const vocabulary = ["supports", "invalidated-by"];\n');
    assert.deepEqual(checkNoRetiredAliasReads(root).filter((finding) => finding.includes("vocabulary.ts")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
