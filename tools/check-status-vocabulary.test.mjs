// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildStateStoreIndex,
  checkDaemonProjectionFreshness,
  checkGuiAdapterInvariants,
  checkKernelVocabularyBijection,
  checkExternalOwnership,
  checkInlineFieldCoverage,
  checkOwnerStoreAgreement,
  checkRegisterShape,
  checkStatusVocabularyCoverage,
  checkViewLocalDeclarations,
  collectStatusDeclarationSites,
  hasPersistentWrite,
  isAnchorImportedElsewhere,
  STATUS_DECLARATION_SUFFIX,
} from "./check-status-vocabulary.mjs";
import {
  statusVocabularyBaseline,
  statusVocabularyUnownedRegister,
} from "./gate-allowlists/status-vocabulary-baseline.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";
import { entityKindContracts } from "../packages/kernel/src/domain/entity-kind-registry.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const GUI_MODEL = "packages/gui/src/renderer/model/types.ts";
const GUI_ADAPTER = "packages/gui/src/renderer/triadic-data.ts";
const DAEMON_PROTOCOL = "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts";

const register = await import(new URL("../packages/kernel/src/domain/status-vocabulary.ts", import.meta.url));
const realDecisionModule = await import(
  new URL("../packages/kernel/src/domain/decision-event-types.ts", import.meta.url)
);
const realModules = new Map();
for (const vocabulary of register.statusVocabularies) {
  if (!vocabulary.module.startsWith("packages/kernel/src/domain/") || vocabulary.anchor.startsWith("#")) continue;
  if (!realModules.has(vocabulary.module)) {
    realModules.set(vocabulary.module, await import(new URL(`../${vocabulary.module}`, import.meta.url)));
  }
}

const SOURCE_FILE = /\.(?:ts|tsx|mts)$/u;
const NON_PRODUCTION = /(?:^|\/)(?:test|tests|fixtures)\//u;
const TEST_FILE = /\.(?:test|spec|vitest)\.[cm]?tsx?$/u;

function packageSources() {
  const sources = new Map();
  for (const rel of listWorktreeFiles(repoRoot, ["packages"]).filter(
    (entry) => SOURCE_FILE.test(entry) && !NON_PRODUCTION.test(entry) && !TEST_FILE.test(entry),
  )) {
    sources.set(rel, readFileSync(path.join(repoRoot, rel), "utf8"));
  }
  return sources;
}

const sources = packageSources();
const sites = collectStatusDeclarationSites(sources);
const storeIndex = buildStateStoreIndex(entityKindContracts);

function coverageFor(candidateSources, { baseline = statusVocabularyBaseline, candidateRegister = register } = {}) {
  return checkStatusVocabularyCoverage(candidateRegister, collectStatusDeclarationSites(candidateSources), [], {
    baseline,
  });
}

function emptyRegister() {
  return { statusVocabularies: [], statusWordRegister: [] };
}

test("status vocabulary check accepts the repository", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-status-vocabulary.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status vocabulary check passed/);
});

test("pure checks accept the real register, declarations, baseline, stores and view-local scopes", () => {
  assert.deepEqual(
    [
      ...checkRegisterShape(register),
      ...storeIndex.findings,
      ...checkOwnerStoreAgreement(register, storeIndex.byId),
      ...checkExternalOwnership(register, statusVocabularyUnownedRegister),
      ...checkKernelVocabularyBijection(register, realModules, sites),
      ...checkStatusVocabularyCoverage(register, sites, [], { baseline: statusVocabularyBaseline }),
      ...checkInlineFieldCoverage(register, sites, [], { baseline: statusVocabularyBaseline }),
      ...checkViewLocalDeclarations(register, sites, sources),
      ...checkGuiAdapterInvariants(register, sources),
      ...checkDaemonProjectionFreshness(register, sources),
    ],
    [],
  );
});

test("the scan root covers every package, not only kernel domain and three mirror files", () => {
  // Each of these packages was outside the old scan roots.
  for (const [module, body] of [
    ["packages/storage/src/rogue.ts", 'export type StoreState = "before" | "after";\n'],
    ["packages/preset/src/rogue.ts", 'export type PresetPhase = "one" | "two";\n'],
    ["packages/gui/src/renderer/rogue.ts", 'export type WidgetStatus = "up" | "down";\n'],
    ["packages/daemon/src/fleet/rogue.ts", 'export type PeerState = "up" | "down";\n'],
    ["packages/cli/src/rogue.ts", 'export type CliState = "up" | "down";\n'],
  ]) {
    const findings = coverageFor(new Map([...sources, [module, body]]));
    assert.ok(
      findings.some((finding) => finding.includes(`${module}#`) && finding.includes("unregistered")),
      `${module}: ${findings.join("\n")}`,
    );
  }
});

test("bypass fixture: a new unregistered status vocabulary is refused", () => {
  // Simulates a regression that introduces a brand-new status word family in the
  // kernel domain without registering it: the ratchet must refuse (no allowlist).
  const candidateSources = new Map([
    ...sources,
    [
      "packages/kernel/src/domain/timewarp.ts",
      'export const timewarpStates = ["before", "during", "afterlife"] as const;\n',
    ],
  ]);
  const findings = coverageFor(candidateSources);
  assert.ok(
    findings.some((finding) => finding.includes("timewarp.ts#timewarpStates") && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

// Prettier's canonical multi-line union leads with a pipe, which the site pattern
// did not accept. Both directions were affected; only one of them was loud.
test("bypass fixture: an unregistered status vocabulary in prettier's multi-line union form is still refused", () => {
  // This is the silent half. A site the pattern cannot see is never collected, so
  // the unregistered-vocabulary finding cannot fire on it — the ratchet would let a
  // brand-new unregistered vocabulary through with nothing going red anywhere.
  const candidateSources = new Map([
    ...sources,
    [
      "packages/kernel/src/domain/timewarp.ts",
      'export type TimewarpStatus =\n  | "before"\n  | "during"\n  | "afterlife";\n',
    ],
  ]);
  const findings = coverageFor(candidateSources);
  assert.ok(
    findings.some((finding) => finding.includes("timewarp.ts#TimewarpStatus") && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

test("a registered anchor reformatted into prettier's multi-line union form still counts as existing", () => {
  // This is the loud half: reformatting a registered declaration must not report it
  // as deleted. RuntimeSessionSemanticState is a real registered anchor, and this is
  // the exact shape prettier produced for it.
  assert.ok(sources.get("packages/kernel/src/domain/agent-runtime.ts")?.includes("RuntimeSessionSemanticState"));
  assert.ok(
    sites.some((site) => site.anchor === "RuntimeSessionSemanticState"),
    "the anchored type must be collected as a site in whatever form the repository currently holds it",
  );
  assert.deepEqual(
    checkStatusVocabularyCoverage(register, sites, [], { baseline: statusVocabularyBaseline }).filter((finding) =>
      finding.includes("RuntimeSessionSemanticState"),
    ),
    [],
  );
});

test("bypass fixture: a kernel vocabulary gaining an unregistered word is refused", () => {
  const drifted = new Map([
    [
      "packages/kernel/src/domain/decision-event-types.ts",
      {
        ...realDecisionModule,
        decisionStates: [...realDecisionModule.decisionStates, "reconsidered"],
      },
    ],
  ]);
  const findings = checkKernelVocabularyBijection(register, drifted, sites);
  assert.ok(
    findings.some((finding) => finding.includes("reconsidered")),
    findings.join("\n"),
  );
});

test("bypass fixture: a daemon vocabulary drifting from its registered words is refused", () => {
  const drifted = new Map([
    ...sources,
    [
      "packages/daemon/src/dispatch-activity.ts",
      'export type DispatchActivityStatus = "thinking" | "tool" | "waiting" | "silent" | "stalled" | "unknown" | "paused";\n',
    ],
  ]);
  const findings = coverageFor(drifted);
  assert.ok(
    findings.some(
      (finding) => finding.includes("dispatch-activity.ts#DispatchActivityStatus") && finding.includes("drift"),
    ),
    findings.join("\n"),
  );
});

test("bypass fixture: the GUI decision mirror losing a kernel word is refused", () => {
  // This is the slice-5 defect shape itself: the kernel vocabulary has a word the
  // mirror does not know (superseded), which used to display as awaiting approval.
  const guiModel = (sources.get(GUI_MODEL) ?? "").replace(/  \| "superseded"\r?\n/u, "");
  const findings = checkStatusVocabularyCoverage(
    register,
    collectStatusDeclarationSites(new Map([...sources, [GUI_MODEL, guiModel]])),
    [],
    { baseline: statusVocabularyBaseline },
  );
  assert.ok(
    findings.some((finding) => finding.includes("DecisionState") && finding.includes("superseded")),
    findings.join("\n"),
  );
});

test("bypass fixture: smoothing an unknown decision state into a neighbour is refused", () => {
  const regressed = 'function decisionState(value: string): DecisionState { return "proposed"; }';
  const findings = checkGuiAdapterInvariants(
    register,
    new Map([
      [GUI_MODEL, sources.get(GUI_MODEL)],
      [GUI_ADAPTER, regressed],
    ]),
  );
  assert.ok(
    findings.some((finding) => finding.includes('must map unrecognised states to "unknown"')),
    findings.join("\n"),
  );
});

test("bypass fixture: BOARD_COLUMNS drifting from SnapshotStatus is refused", () => {
  const guiModel = (sources.get(GUI_MODEL) ?? "").replace('  "archived",\n', "");
  const findings = checkGuiAdapterInvariants(register, new Map([[GUI_MODEL, guiModel]]));
  assert.ok(
    findings.some((finding) => finding.includes("BOARD_COLUMNS") && finding.includes("SnapshotStatus")),
    findings.join("\n"),
  );
});

test("bypass fixture: a stale generated daemon projection is refused", () => {
  const daemonText = (sources.get(DAEMON_PROTOCOL) ?? "").replace('  "superseded",\n', "");
  const findings = checkDaemonProjectionFreshness(register, new Map([[DAEMON_PROTOCOL, daemonText]]));
  assert.ok(
    findings.some((finding) => finding.includes("Generated daemon status vocabulary is stale")),
    findings.join("\n"),
  );
});

test("bypass fixture: a daemon wire mirror drifting from the kernel vocabulary is refused", () => {
  const drifted = new Map([
    ...sources,
    [DAEMON_PROTOCOL, (sources.get(DAEMON_PROTOCOL) ?? "").replace('  "superseded",\n', "")],
  ]);
  const findings = coverageFor(drifted);
  assert.ok(
    findings.some((finding) => finding.includes("decisionStateWords") && finding.includes("drift")),
    findings.join("\n"),
  );
});

test("bypass fixture: a new daemon wire mirror const is refused", () => {
  const appended = new Map([
    ...sources,
    [
      DAEMON_PROTOCOL,
      `${sources.get(DAEMON_PROTOCOL)}\nexport const timewarpPhaseWords = ["before", "after"] as const;\n`,
    ],
  ]);
  const findings = coverageFor(appended);
  assert.ok(
    findings.some((finding) => finding.includes("timewarpPhaseWords") && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

test("bypass fixture: a divergent register row without a resolution is refused", () => {
  const shapeless = {
    ...register,
    statusWordRegister: [
      ...register.statusWordRegister,
      { word: "limbo", entity: "Task", field: "status", meaning: "Somewhere else.", divergence: "divergent" },
    ],
  };
  const findings = checkRegisterShape(shapeless);
  assert.ok(
    findings.some((finding) => finding.includes("divergent word limbo|Task|status must carry a resolution")),
    findings.join("\n"),
  );
});

test("declaration suffix pattern keeps matching the vocabulary families", () => {
  for (const name of [
    "domainStatuses",
    "executionStates",
    "leasePhases",
    "packageDispositions",
    "reviewVerdicts",
    "writeReceiptOutcomes",
    "runtimeLivenessStates",
    "closeoutReadinesses",
    "PlanReadiness",
  ]) {
    assert.ok(STATUS_DECLARATION_SUFFIX.test(name), name);
  }
  assert.equal(STATUS_DECLARATION_SUFFIX.test("taskClasses"), false);
  assert.equal(STATUS_DECLARATION_SUFFIX.test("factMemoryTags"), false);
});

test("bypass fixture: a new inline kernel status union is refused", () => {
  const inlineSources = new Map([
    ...sources,
    ["packages/kernel/src/domain/review-probe.ts", 'export interface Probe { readonly status: "up" | "down"; }\n'],
  ]);
  const findings = checkInlineFieldCoverage(register, collectStatusDeclarationSites(inlineSources), [], {
    baseline: statusVocabularyBaseline,
  });
  assert.ok(
    findings.some((finding) => finding.includes("review-probe.ts##Probe.status") && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

test("bypass fixture: an unregistered authored-document inline readiness union is refused", () => {
  const inlineSources = new Map([
    ...sources,
    [
      "packages/daemon/src/fleet/edge-doc-readiness.ts",
      'export interface EdgeDocReadiness { readonly readinessState: "ready" | "awaiting_center"; }\n',
    ],
  ]);
  const findings = checkInlineFieldCoverage(register, collectStatusDeclarationSites(inlineSources), [], {
    baseline: statusVocabularyBaseline,
  });
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("edge-doc-readiness.ts##EdgeDocReadiness.readinessState") &&
        finding.includes("awaiting_center"),
    ),
    findings.join("\n"),
  );
});

test("bypass fixture: an external register row without an ownership form is refused", () => {
  const module = "packages/daemon/src/review-probe.ts";
  const row = {
    id: "probe.state",
    entity: "Probe",
    field: "state",
    module,
    anchor: "ProbeState",
    words: ["up", "down"],
  };
  const candidate = {
    statusVocabularies: [...register.statusVocabularies, row],
    statusWordRegister: [
      ...register.statusWordRegister,
      ...row.words.map((word) => ({
        word,
        entity: "Probe",
        field: "state",
        meaning: `The probe is ${word}.`,
        divergence: "entity-scoped",
      })),
    ],
  };
  const findings = checkExternalOwnership(candidate, statusVocabularyUnownedRegister);
  assert.ok(
    findings.some((finding) => finding.includes("probe.state") && finding.includes("must declare mirrorOf")),
    findings.join("\n"),
  );
});

test("unowned-register baseline: owning a frozen external row makes the entry stale", () => {
  const owned = {
    ...register,
    statusVocabularies: register.statusVocabularies.map((vocabulary) =>
      vocabulary.id === "docCandidate.state" ? { ...vocabulary, ownerStore: "document.events" } : vocabulary,
    ),
  };
  const findings = checkExternalOwnership(owned, statusVocabularyUnownedRegister);
  assert.ok(
    findings.some((finding) => finding.includes("docCandidate.state") && finding.includes("now owned")),
    findings.join("\n"),
  );
});

test("bypass fixture: Freshness and Availability families are scanned", () => {
  const module = "packages/daemon/src/review-probe.ts";
  for (const [name, body] of [
    ["PeerFreshness", 'export type PeerFreshness = "fresh" | "stale";\n'],
    ["PeerAvailability", 'export type PeerAvailability = "up" | "down";\n'],
  ]) {
    const findings = coverageFor(new Map([...sources, [module, body]]));
    assert.ok(
      findings.some((finding) => finding.includes(`${module}#${name}`) && finding.includes("unregistered")),
      `${name}: ${findings.join("\n")}`,
    );
  }
});

test("bypass fixture: a single-quoted status union is scanned", () => {
  const module = "packages/daemon/src/review-probe.ts";
  const findings = coverageFor(new Map([...sources, [module, "export type PeerState = 'up' | 'down';\n"]]));
  assert.ok(
    findings.some((finding) => finding.includes(`${module}#PeerState`) && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

test("bypass fixture: a status-word const alias is resolved and refused when unregistered", () => {
  const wire = "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts";
  const appended = new Map([
    ...sources,
    [wire, `${sources.get(wire)}\nexport const timewarpStateWords = taskStatusWords;\n`],
  ]);
  const findings = coverageFor(appended);
  assert.ok(
    findings.some((finding) => finding.includes("timewarpStateWords") && finding.includes("unregistered")),
    findings.join("\n"),
  );
});

test("bypass fixture: a status-word const alias with an unknown target is refused", () => {
  const wire = "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts";
  const appended = new Map([
    ...sources,
    [wire, `${sources.get(wire)}\nexport const timewarpStateWords = missingStates;\n`],
  ]);
  const findings = coverageFor(appended);
  assert.ok(
    findings.some(
      (finding) => finding.includes("missingStates") && finding.includes("no unique registered vocabulary"),
    ),
    findings.join("\n"),
  );
});

// dec_499E4E98A3D4754132B3BCA1E6 CH1: the wizard's local phase union is registered
// as view-local instead of being special-cased by file path.

test("view-local positive fixture: the GUI wizard phase is registered and accepted", () => {
  const vocabulary = register.statusVocabularies.find(
    (candidate) =>
      candidate.module === "packages/gui/src/renderer/components/EdgeJoinWizard.tsx" && candidate.anchor === "Phase",
  );
  assert.equal(vocabulary?.scope, "view-local");
  assert.ok(
    sites.some(
      (site) => site.module === vocabulary.module && site.anchor === vocabulary.anchor && site.exported === false,
    ),
  );
  assert.deepEqual(checkViewLocalDeclarations(register, sites, sources), []);
});

test("view-local negative fixture: exporting or importing the view-local type is refused", () => {
  const module = "packages/gui/src/renderer/components/EdgeJoinWizard.tsx";
  const exportedSources = new Map([
    ...sources,
    [module, (sources.get(module) ?? "").replace("type Phase =", "export type Phase =")],
    [
      "packages/gui/src/renderer/rogue-importer.ts",
      'import type { Phase } from "./components/EdgeJoinWizard.tsx";\nexport const phase: Phase = "paste";\n',
    ],
  ]);
  assert.equal(isAnchorImportedElsewhere(module, "Phase", exportedSources), true);
  const findings = checkViewLocalDeclarations(
    register,
    collectStatusDeclarationSites(exportedSources),
    exportedSources,
  );
  assert.ok(
    findings.some(
      (finding) => finding.includes("EdgeJoinWizard.tsx#Phase") && finding.includes("must not be exported"),
    ),
    findings.join("\n"),
  );
});

test("view-local negative fixture: a local export alias cannot launder the type out of its module", () => {
  const module = "packages/gui/src/renderer/components/EdgeJoinWizard.tsx";
  const aliasedSources = new Map([
    ...sources,
    [module, `${sources.get(module)}\nexport type { Phase as WizardPhase };\n`],
    [
      "packages/gui/src/renderer/rogue-importer.ts",
      'import type { WizardPhase } from "./components/EdgeJoinWizard.tsx";\nexport const phase: WizardPhase = "paste";\n',
    ],
  ]);
  assert.equal(
    isAnchorImportedElsewhere(module, "Phase", aliasedSources, { declaredExported: false }),
    true,
    "the exported alias must count as importing the view-local type",
  );
  const findings = checkViewLocalDeclarations(register, collectStatusDeclarationSites(aliasedSources), aliasedSources);
  assert.ok(
    findings.some(
      (finding) => finding.includes("EdgeJoinWizard.tsx#Phase") && finding.includes("directly or through an alias"),
    ),
    findings.join("\n"),
  );
});

test("view-local negative fixture: an aliased persistent-write import is refused", () => {
  const module = "packages/gui/src/renderer/components/EdgeJoinWizard.tsx";
  const aliasedWrite = new Map([
    ...sources,
    [
      module,
      `${sources.get(module)}\nimport { writeFileSync as persist } from "node:fs";\npersist("/tmp/phase.json", "paste");\n`,
    ],
  ]);
  assert.equal(hasPersistentWrite(aliasedWrite.get(module)), true);
  const findings = checkViewLocalDeclarations(register, collectStatusDeclarationSites(aliasedWrite), aliasedWrite);
  assert.ok(
    findings.some((finding) => finding.includes("EdgeJoinWizard.tsx#Phase") && finding.includes("persistent write")),
    findings.join("\n"),
  );
});

test("view-local negative fixture: a file with a persistent write cannot declare a view-local type", () => {
  const module = "packages/gui/src/renderer/components/EdgeJoinWizard.tsx";
  assert.equal(hasPersistentWrite(sources.get(module) ?? ""), false);
  const writingSources = new Map([
    ...sources,
    [module, `${sources.get(module)}\nwriteFileSync("/tmp/phase.json", "x");\n`],
  ]);
  const findings = checkViewLocalDeclarations(register, collectStatusDeclarationSites(writingSources), writingSources);
  assert.ok(
    findings.some((finding) => finding.includes("EdgeJoinWizard.tsx#Phase") && finding.includes("persistent write")),
    findings.join("\n"),
  );
});

test("view-local negative fixture: a non-GUI or non-view-local scope is refused", () => {
  const shapeless = {
    ...register,
    statusVocabularies: [
      ...register.statusVocabularies,
      {
        id: "fake.state",
        entity: "GuiAdapter",
        field: "state",
        module: "packages/daemon/src/fake.ts",
        anchor: "FakeState",
        words: ["up", "down"],
        scope: "view-local",
      },
    ],
  };
  const findings = checkRegisterShape(shapeless);
  assert.ok(
    findings.some((finding) => finding.includes("view-local scope is only for GUI")),
    findings.join("\n"),
  );
});

test("ownerStore positive fixture: authority vocabularies resolve to their declared stores", () => {
  for (const [id, storeId] of [
    ["decision.state", "decision.events"],
    ["relation.state", "relation.events"],
    ["schedule.state", "schedule.events"],
  ]) {
    const vocabulary = register.statusVocabularies.find((candidate) => candidate.id === id);
    assert.equal(vocabulary?.ownerStore, storeId, id);
    assert.equal(storeIndex.byId.has(storeId), true, storeId);
  }
  assert.deepEqual(checkOwnerStoreAgreement(register, storeIndex.byId), []);
});

test("ownerStore negative fixture: an unknown store id is refused", () => {
  const shapeless = {
    ...register,
    statusVocabularies: register.statusVocabularies.map((vocabulary) =>
      vocabulary.id === "decision.state" ? { ...vocabulary, ownerStore: "rogue.events" } : vocabulary,
    ),
  };
  const findings = checkOwnerStoreAgreement(shapeless, storeIndex.byId);
  assert.ok(
    findings.some((finding) => finding.includes("decision.state") && finding.includes("does not resolve")),
    findings.join("\n"),
  );
});

test("ownerStore negative fixture: a store that does not list the vocabulary is refused", () => {
  const shapeless = {
    ...register,
    statusVocabularies: register.statusVocabularies.map((vocabulary) =>
      vocabulary.id === "decision.state" ? { ...vocabulary, ownerStore: "task.task-events" } : vocabulary,
    ),
  };
  const findings = checkOwnerStoreAgreement(shapeless, storeIndex.byId);
  assert.ok(
    findings.some((finding) => finding.includes("does not list this vocabulary")),
    findings.join("\n"),
  );
});

test("ownerStore negative fixture: a store vocabulary row without the back-reference is refused", () => {
  const shapeless = {
    ...register,
    statusVocabularies: register.statusVocabularies.map((vocabulary) =>
      vocabulary.id === "decision.state" ? { ...vocabulary, ownerStore: undefined } : vocabulary,
    ),
  };
  const findings = checkOwnerStoreAgreement(shapeless, storeIndex.byId);
  assert.ok(
    findings.some((finding) => finding.includes("decision.events lists decision.state")),
    findings.join("\n"),
  );
});

test("baseline: an unregistered declaration outside the baseline is refused", () => {
  const synthetic = [{ module: "packages/x/src/a.ts", anchor: "RogueState", kind: "type", words: ["a", "b"] }];
  const findings = checkStatusVocabularyCoverage(emptyRegister(), synthetic, [], { baseline: [] });
  assert.ok(findings.some((finding) => finding.includes("a.ts#RogueState") && finding.includes("unregistered")));
});

test("baseline: a frozen declaration keeps its words", () => {
  const synthetic = [{ module: "packages/x/src/a.ts", anchor: "FrozenState", kind: "type", words: ["a", "b"] }];
  assert.deepEqual(
    checkStatusVocabularyCoverage(emptyRegister(), synthetic, [], {
      baseline: [{ key: "packages/x/src/a.ts#FrozenState", words: ["a", "b"] }],
    }),
    [],
  );
});

test("baseline: a frozen declaration gaining a word is refused", () => {
  const synthetic = [{ module: "packages/x/src/a.ts", anchor: "FrozenState", kind: "type", words: ["a", "b", "c"] }];
  const findings = checkStatusVocabularyCoverage(emptyRegister(), synthetic, [], {
    baseline: [{ key: "packages/x/src/a.ts#FrozenState", words: ["a", "b"] }],
  });
  assert.ok(
    findings.some((finding) => finding.includes("drifted from the frozen baseline")),
    findings.join("\n"),
  );
});

test("baseline: a stale entry is refused", () => {
  const findings = checkStatusVocabularyCoverage(emptyRegister(), [], [], {
    baseline: [{ key: "packages/x/src/gone.ts#GoneState", words: ["a"] }],
  });
  assert.ok(
    findings.some((finding) => finding.includes("stale status-vocabulary baseline entry")),
    findings.join("\n"),
  );
});

test("baseline: a baseline entry that has been registered must be deleted", () => {
  const synthetic = [{ module: "packages/x/src/a.ts", anchor: "OwnedState", kind: "type", words: ["a"] }];
  const candidateRegister = {
    statusVocabularies: [
      {
        id: "x.state",
        entity: "GuiAdapter",
        field: "state",
        module: "packages/x/src/a.ts",
        anchor: "OwnedState",
        words: ["a"],
        ownerStore: "x.events",
      },
    ],
    statusWordRegister: [],
  };
  const findings = checkStatusVocabularyCoverage(candidateRegister, synthetic, [], {
    baseline: [{ key: "packages/x/src/a.ts#OwnedState", words: ["a"] }],
  });
  assert.ok(findings.some((finding) => finding.includes("is now registered — delete the baseline entry")));
});

test("baseline: duplicate entries are refused", () => {
  const findings = checkStatusVocabularyCoverage(emptyRegister(), [], [], {
    baseline: [
      { key: "packages/x/src/a.ts#AState", words: ["a"] },
      { key: "packages/x/src/a.ts#AState", words: ["a"] },
    ],
  });
  assert.ok(findings.some((finding) => finding.includes("duplicate status-vocabulary baseline entry")));
});

test("register shape: a row carrying two ownership forms is refused", () => {
  const shapeless = {
    ...register,
    statusVocabularies: [
      ...register.statusVocabularies,
      {
        id: "fake.state",
        entity: "GuiAdapter",
        field: "state",
        module: "packages/gui/src/fake.ts",
        anchor: "FakeState",
        words: ["up"],
        mirrorOf: "task.status",
        scope: "view-local",
      },
    ],
  };
  const findings = checkRegisterShape(shapeless);
  assert.ok(
    findings.some((finding) => finding.includes("at most one ownership form")),
    findings.join("\n"),
  );
});

test("registered inline anchors still have to declare their registered words", () => {
  const module = "packages/daemon/src/dispatch-stream.ts";
  const drifted = new Map([
    ...sources,
    [
      module,
      (sources.get(module) ?? "").replace(
        'readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null',
        'readonly fallbackState: "scheduled" | "exhausted" | null',
      ),
    ],
  ]);
  const findings = checkInlineFieldCoverage(register, collectStatusDeclarationSites(drifted), [], {
    baseline: statusVocabularyBaseline,
  });
  assert.ok(
    findings.some((finding) => finding.includes("dispatch.fallbackState") && finding.includes("no longer declares")),
    findings.join("\n"),
  );
});

// dec_6B912A63D279A922FA1288536D CH2: authored-document words outside the kernel are
// now covered by the generic scan; the old token-family/path special case is gone.
test("authored-document vocabularies are covered by the generic scan", () => {
  const expected = [
    "packages/daemon/src/doc-sync-candidate-scanner.ts#DocCandidateState",
    "packages/daemon/src/doc-sync-reads.ts#ProjectedDocumentSyncState",
    "packages/daemon/src/doc-sync-reads.ts##syncState",
    "packages/daemon/src/protocol/daemon-protocol-gui-types.ts##syncState",
  ];
  for (const key of expected) {
    const [module, anchor] = key.split("#", 2);
    const realAnchor = key.endsWith("##syncState") ? "#syncState" : anchor;
    assert.ok(
      register.statusVocabularies.some(
        (vocabulary) => vocabulary.module === module && vocabulary.anchor === realAnchor,
      ),
      key,
    );
  }
  assert.deepEqual(
    checkStatusVocabularyCoverage(register, sites, [], { baseline: statusVocabularyBaseline }).filter((finding) =>
      expected.some((key) => finding.includes(key.replace("##", "#"))),
    ),
    [],
  );
  const rogue = new Map([
    ...sources,
    [
      "packages/daemon/src/fleet/edge-doc-candidate.ts",
      'export type EdgeDocCandidateState = "clean" | "candidate_v2";\n',
    ],
  ]);
  assert.ok(coverageFor(rogue).some((finding) => finding.includes("edge-doc-candidate.ts#EdgeDocCandidateState")));
});

test("the deleted fixed-file and authored-document special cases cannot reappear", async () => {
  const gate = await import("./check-status-vocabulary.mjs");
  for (const removed of [
    "checkGuiMirrorAgreement",
    "checkDaemonMirrorAgreement",
    "checkKernelDeclarationCoverage",
    "collectKernelDeclarationSites",
    "collectAuthoredDocumentVocabularySites",
    "checkAuthoredDocumentVocabularyCoverage",
    "isAuthoredDocumentVocabulary",
    "AUTHORED_DOCUMENT_SCOPES",
  ]) {
    assert.equal(removed in gate, false, `${removed} must stay deleted`);
  }
  const source = readFileSync(path.join(repoRoot, "tools/check-status-vocabulary.mjs"), "utf8");
  for (const removed of ["GUI_MODEL", "DAEMON_PROTOCOL", "AUTHORED_DOCUMENT"]) {
    assert.equal(source.includes(removed), false, `${removed} must not come back as a fixed-file special case`);
  }
});
