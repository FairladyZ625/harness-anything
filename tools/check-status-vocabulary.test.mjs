// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkDaemonMirrorAgreement,
  checkGuiMirrorAgreement,
  checkKernelDeclarationCoverage,
  checkKernelVocabularyBijection,
  checkRegisterShape,
  collectKernelDeclarationSites,
  KERNEL_DECLARATION_SUFFIX
} from "./check-status-vocabulary.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const GUI_MODEL = "packages/gui/src/renderer/model/types.ts";
const GUI_ADAPTER = "packages/gui/src/renderer/triadic-data.ts";

const register = await import(new URL("../packages/kernel/src/domain/status-vocabulary.ts", import.meta.url));
const realDecisionModule = await import(new URL("../packages/kernel/src/domain/fact-event.ts", import.meta.url));
const realModules = new Map();
for (const vocabulary of register.statusVocabularies) {
  if (!vocabulary.module.startsWith("packages/kernel/src/domain/") || vocabulary.anchor.startsWith("#")) continue;
  if (!realModules.has(vocabulary.module)) {
    realModules.set(vocabulary.module, await import(new URL(`../${vocabulary.module}`, import.meta.url)));
  }
}

function kernelSources() {
  const sites = new Map();
  for (const vocabulary of register.statusVocabularies) {
    if (!vocabulary.module.startsWith("packages/kernel/src/domain/")) continue;
    if (!sites.has(vocabulary.module)) sites.set(vocabulary.module, readFileSync(path.join(repoRoot, vocabulary.module), "utf8"));
  }
  return sites;
}

test("status vocabulary check accepts the repository", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-status-vocabulary.mjs")], {
    cwd: repoRoot, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status vocabulary check passed/);
});

test("pure checks accept the real register and kernel declarations", () => {
  const sources = kernelSources();
  const sites = collectKernelDeclarationSites(sources);
  assert.deepEqual([
    ...checkRegisterShape(register),
    ...checkKernelVocabularyBijection(register, realModules, sites),
    ...checkKernelDeclarationCoverage(register, sites)
  ], []);
});

test("bypass fixture: a new unregistered status vocabulary is refused", () => {
  // Simulates a regression that introduces a brand-new status word family in the
  // kernel domain without registering it: the ratchet must refuse (no allowlist).
  const sources = new Map(kernelSources());
  sources.set("packages/kernel/src/domain/timewarp.ts",
    'export const timewarpStates = ["before", "during", "afterlife"] as const;\n');
  const findings = checkKernelDeclarationCoverage(register, collectKernelDeclarationSites(sources));
  assert.ok(findings.some((finding) => finding.includes("timewarp.ts#timewarpStates") && finding.includes("unregistered")), findings.join("\n"));
});

test("bypass fixture: a kernel vocabulary gaining an unregistered word is refused", () => {
  const drifted = new Map([["packages/kernel/src/domain/fact-event.ts", {
    ...realDecisionModule,
    decisionStates: [...realDecisionModule.decisionStates, "reconsidered"]
  }]]);
  const sources = new Map(kernelSources());
  const sites = collectKernelDeclarationSites(sources);
  const findings = checkKernelVocabularyBijection(register, drifted, sites);
  assert.ok(findings.some((finding) => finding.includes("reconsidered")), findings.join("\n"));
});

test("bypass fixture: the GUI decision mirror losing a kernel word is refused", () => {
  // This is the slice-5 defect shape itself: the kernel vocabulary has a word the
  // mirror does not know (superseded), which used to display as awaiting approval.
  const guiModel = readFileSync(path.join(repoRoot, GUI_MODEL), "utf8")
    .replace(/\r?\n/gu, "\r\n")
    .replace(/  \| "superseded"\r?\n/u, "");
  const guiAdapter = readFileSync(path.join(repoRoot, GUI_ADAPTER), "utf8");
  const findings = checkGuiMirrorAgreement(register, guiModel, guiAdapter);
  assert.ok(findings.some((finding) => finding.includes("DecisionState") && finding.includes("superseded")), findings.join("\n"));
});

test("bypass fixture: smoothing an unknown decision state into a neighbour is refused", () => {
  const guiModel = readFileSync(path.join(repoRoot, GUI_MODEL), "utf8");
  const regressed = 'function decisionState(value: string): DecisionState { return "proposed"; }';
  const findings = checkGuiMirrorAgreement(register, guiModel, regressed);
  assert.ok(findings.some((finding) => finding.includes("must map unrecognised states to \"unknown\"")), findings.join("\n"));
});

test("bypass fixture: a daemon wire mirror drifting from the kernel vocabulary is refused", () => {
  // The wire contract cannot import the kernel barrel (CLI eager startup path), so its
  // mirrors are plain data — and the gate must keep them from silently diverging.
  const daemonText = readFileSync(path.join(repoRoot, "packages/daemon/src/protocol/daemon-protocol.contract.ts"), "utf8")
    .replace('const decisionStateWords = ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"] as const;',
      'const decisionStateWords = ["proposed", "in_effect", "rejected", "deferred", "outcome_retired"] as const;');
  const findings = checkDaemonMirrorAgreement(register, daemonText);
  assert.ok(findings.some((finding) => finding.includes("decisionStateWords") && finding.includes("drift")), findings.join("\n"));

  const unregistered = checkDaemonMirrorAgreement(register, daemonText + '\nconst timewarpPhaseWords = ["before", "after"] as const;\n');
  assert.ok(unregistered.some((finding) => finding.includes("timewarpPhaseWords") && finding.includes("unregistered")), unregistered.join("\n"));
});

test("bypass fixture: a divergent register row without a resolution is refused", () => {
  const shapeless = {
    ...register,
    statusWordRegister: [
      ...register.statusWordRegister,
      { word: "limbo", entity: "Task", field: "status", meaning: "Somewhere else.", divergence: "divergent" }
    ]
  };
  const findings = checkRegisterShape(shapeless);
  assert.ok(findings.some((finding) => finding.includes("divergent word limbo|Task|status must carry a resolution")), findings.join("\n"));
});

test("declaration suffix pattern keeps matching the vocabulary families", () => {
  for (const name of ["domainStatuses", "executionStates", "leasePhases", "packageDispositions", "reviewVerdicts", "writeReceiptOutcomes", "runtimeLivenessStates", "closeoutReadinesses"]) {
    assert.ok(KERNEL_DECLARATION_SUFFIX.test(name), name);
  }
  assert.equal(KERNEL_DECLARATION_SUFFIX.test("taskClasses"), false);
  assert.equal(KERNEL_DECLARATION_SUFFIX.test("factMemoryTags"), false);
});
