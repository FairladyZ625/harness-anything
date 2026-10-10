// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCompletionContract as resolve,
  validateFrozenCompletionContract,
  type FrozenCompletionContract,
} from "../../src/domain/completion-contract.ts";
import { validateSubmissionV1 } from "../../src/domain/execution.ts";
import { readSettingsFacet, validateRepositorySettings, repositorySettings } from "../../src/domain/settings.ts";

import { completionSnapshot, emptyCompletionContract } from "./completion.fixtures.ts";
const resolveCompletionContract = (gates: readonly string[], settings: Parameters<typeof resolve>[1]) =>
  resolve(gates, settings, completionSnapshot);

const repositoryYaml = (gates: string, workflows = "[rewrite-ci]") =>
  `schema: harness-anything/v1\nsettings:\n  ci:\n    workflows: ${workflows}\n${gates}`;

const githubCi =
  "  gates:\n" +
  "    ci:\n" +
  "      adapter: github-actions  # verdict source\n" +
  "      appliesTo: code\n" +
  "      event: push\n      coverage: descendant\n      selection: newest\n" +
  "      branch: main\n";

const currentPresetContract: FrozenCompletionContract = {
  ...emptyCompletionContract,
  closeoutGates: { ...emptyCompletionContract.closeoutGates, codeDoc: true },
  gates: [
    {
      gateId: "ci",
      appliesTo: "code",
      witness: {
        adapterId: "github-actions",
        ...completionSnapshot.completion.sources["github-actions"],
        adapterOptions: {
          workflows: ["rewrite-ci"],
          branch: "main",
          event: "push",
          coverage: "descendant",
          selection: "newest",
        },
      },
    },
    {
      gateId: "code-doc-reconciliation",
      appliesTo: "code",
      witness: { kind: "internal", adapterId: "code-doc-reconciliation", adapterOptions: {} },
    },
  ],
};

test("the standard preset gates resolve gate by gate to today's GitHub CI and internal code/doc checker", () => {
  const settings = readSettingsFacet(repositoryYaml(githubCi));

  assert.deepEqual(settings.gates, [
    {
      gateId: "ci",
      adapter: "github-actions",
      appliesTo: "code",
      branch: "main",
      event: "push",
      coverage: "descendant",
      selection: "newest",
    },
  ]);
  const resolved = resolveCompletionContract(["ci", "code-doc-reconciliation"], settings);
  assert.deepEqual(resolved, { ok: true, contract: currentPresetContract });
  assert.deepEqual(validateFrozenCompletionContract(currentPresetContract), []);
});

test("a declared gate without a witness mapping fails closed instead of being skipped", () => {
  const unmapped = readSettingsFacet(repositoryYaml(""));

  assert.deepEqual(unmapped.gates, []);
  const ci = resolveCompletionContract(["ci", "code-doc-reconciliation"], unmapped);
  assert.equal(ci.ok, true, "the declared vertical default applies when settings omit a mapping");
  const custom = resolveCompletionContract(["unknown"], readSettingsFacet(repositoryYaml(githubCi)));
  assert.equal(custom.ok, false);
  assert.match(custom.ok ? "" : custom.message, /Gate unknown.*undeclared source/u);
  const emptyRegistry = resolveCompletionContract(["ci"], readSettingsFacet(repositoryYaml(githubCi, "[]")));
  assert.equal(emptyRegistry.ok, false);
  assert.match(emptyRegistry.ok ? "" : emptyRegistry.message, /registered workflows/u);
});

test("none removes a declared requirement without minting a witness, and undeclared mappings add nothing", () => {
  const settings = readSettingsFacet(
    repositoryYaml(
      "  gates:\n" +
        "    ci: none\n" +
        "    code-doc-reconciliation: none\n" +
        "    lint:\n" +
        "      appliesTo: code\n" +
        "      adapter: research/check\n" +
        "    signoff:\n" +
        "      appliesTo: artifacts\n" +
        "      adapter: manual-attest\n",
    ),
  );

  assert.deepEqual(resolveCompletionContract(["ci", "code-doc-reconciliation"], settings), {
    ok: true,
    contract: { ...currentPresetContract, gates: [] },
  });
  assert.deepEqual(resolveCompletionContract(["lint", "signoff", "code-doc-reconciliation"], settings), {
    ok: true,
    contract: {
      ...currentPresetContract,
      gates: [
        {
          gateId: "lint",
          appliesTo: "code",
          witness: {
            adapterId: "research/check",
            ...completionSnapshot.completion.sources["research/check"],
            adapterOptions: {},
          },
        },
        {
          gateId: "signoff",
          appliesTo: "artifacts",
          witness: {
            adapterId: "manual-attest",
            ...completionSnapshot.completion.sources["manual-attest"],
            adapterOptions: {},
          },
        },
      ],
    },
  });
});

test("harness.yaml gate mappings reject unknown fields, unknown adapters, and remapping the internal checker", () => {
  const rejects = (gates: string, pattern: RegExp) =>
    assert.throws(() => readSettingsFacet(repositoryYaml(`  gates:\n${gates}`)), pattern);

  rejects(
    `    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n      workflow: x\n`,
    /workflow/u,
  );
  const unknown = resolveCompletionContract(
    ["ci"],
    readSettingsFacet(repositoryYaml("  gates:\n    ci:\n      appliesTo: code\n      adapter: gitlab-pipeline\n")),
  );
  assert.equal(unknown.ok, false);
  assert.equal(
    resolveCompletionContract(
      ["ci"],
      readSettingsFacet(
        repositoryYaml("  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n"),
      ),
    ).ok,
    true,
  );
  assert.equal(
    resolveCompletionContract(
      ["lint"],
      readSettingsFacet(repositoryYaml("  gates:\n    lint:\n      adapter: research/check\n")),
    ).ok,
    true,
  );
  rejects(`    code-doc-reconciliation:\n      appliesTo: code\n      adapter: manual-attest\n`, /is internal/u);
  rejects(`    ci: github-actions\n`, /cannot read line/u);
  rejects(`    ci: none\n      appliesTo: code\n`, /cannot read line/u);
  rejects(`    lint:\n      appliesTo: code\n      appliesTo: artifacts\n`, /cannot read line/u);
  assert.throws(() => readSettingsFacet(repositoryYaml("  gates: []\n")), /block of gate witness mappings/u);
  assert.match(
    validateRepositorySettings({
      ...repositorySettings(readSettingsFacet(repositoryYaml(githubCi))),
      gates: [{ gateId: "ci", adapter: "none", appliesTo: "code" }],
    }).join("\n"),
    /none carries no options/u,
  );
});

test("the frozen contract schema fails closed on unknown fields and foreign adapter bindings", () => {
  const [ci, codeDoc] = currentPresetContract.gates as [
    FrozenCompletionContract["gates"][number],
    FrozenCompletionContract["gates"][number],
  ];
  const withOptions = (adapterOptions: Record<string, unknown>) => ({
    ...currentPresetContract,
    gates: [{ ...ci, witness: { ...ci.witness, adapterOptions } }],
  });

  assert.equal(
    validateFrozenCompletionContract({ ...currentPresetContract, gates: [{ ...ci, extra: true }] }).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract(withOptions({ ...ci.witness.adapterOptions, cancel: "skip" })).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract(withOptions({ ...ci.witness.adapterOptions, cancel: "skip" }), true).length,
    0,
  );
  assert.equal(
    validateFrozenCompletionContract(withOptions({ workflows: [], branch: "main", event: "push" })).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract(
      { ...currentPresetContract, gates: [{ ...ci, witness: { adapterId: "none", adapterOptions: {} } }] },
      true,
    ).length,
    1,
  );
  assert.equal(validateFrozenCompletionContract({ ...currentPresetContract, gates: [ci, ci] }).length, 1);
  assert.equal(
    validateFrozenCompletionContract({
      ...currentPresetContract,
      gates: [
        {
          ...ci,
          witness: {
            adapterId: "manual-attest",
            ...completionSnapshot.completion.sources["manual-attest"],
            adapterOptions: {},
          },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    validateFrozenCompletionContract({ ...currentPresetContract, gates: [{ ...codeDoc, appliesTo: "artifacts" }] })
      .length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract({ ...currentPresetContract, gates: [{ ...ci, witness: codeDoc.witness }] }).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract({
      ...currentPresetContract,
      gates: [
        {
          ...codeDoc,
          witness: {
            adapterId: "manual-attest",
            ...completionSnapshot.completion.sources["manual-attest"],
            adapterOptions: {},
          },
        },
      ],
    }).length,
    1,
  );
});

test("a submission carries its frozen completion contract as a required field", () => {
  const submission = {
    completionClaim: "Delivered.",
    deliverables: ["src/a.ts"],
    outputs: [],
    verificationNotes: ["Tests passed."],
    knownGaps: [],
    residualRisks: [],
    commitSha: "a".repeat(40),
    completionContract: currentPresetContract,
  };
  const { completionContract: _completionContract, ...legacy } = submission;

  assert.deepEqual(validateSubmissionV1(submission), []);
  assert.equal(validateSubmissionV1(legacy).length, 1);
  // dec_5EC2631352B17EE2BF4979E37E: old bytes require explicit offline conversion.
  assert.equal(validateSubmissionV1(legacy, true).length, 1);
  assert.equal(validateSubmissionV1({ ...submission, completionContract: { gates: [], reviewer: "x" } }).length, 1);
});

test("unconverted history never infers requirements from the current settings", () => {
  assert.equal(validateFrozenCompletionContract({ gates: currentPresetContract.gates }, true).length, 1);
  assert.equal(
    validateFrozenCompletionContract(
      {
        ...currentPresetContract,
        gates: [{ gateId: "ci", appliesTo: "code", witness: { adapterId: "github-actions", adapterOptions: {} } }],
      },
      true,
    ).length,
    1,
  );
});

test("governance modifiers freeze only as true, only on automated witnesses, and absence keeps automated-only", () => {
  const governedYaml =
      "  gates:\n" +
      "    ci:\n      adapter: github-actions\n      appliesTo: code\n      event: push\n" +
      "      coverage: descendant\n      selection: newest\n      branch: main\n      mandatorySignoff: true\n" +
      "    lint:\n      adapter: research/check\n      appliesTo: code\n" +
      "      allowOverride: true\n      mandatorySignoff: false\n" +
      "    review:\n      adapter: manual-attest\n      appliesTo: artifacts\n",
    resolved = resolveCompletionContract(["ci", "lint", "review"], readSettingsFacet(repositoryYaml(governedYaml)));
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const [ci, lint, review] = resolved.contract.gates;
  assert.equal(ci?.mandatorySignoff, true);
  assert.equal(Object.hasOwn(ci!, "allowOverride"), false);
  assert.equal(lint?.allowOverride, true);
  // `false` is the absent modifier: the frozen shape and its digest do not change.
  assert.equal(Object.hasOwn(lint!, "mandatorySignoff"), false);
  assert.deepEqual(Object.keys(review!).sort(), ["appliesTo", "gateId", "witness"]);
  assert.deepEqual(validateFrozenCompletionContract(resolved.contract), []);
  assert.deepEqual(validateFrozenCompletionContract(currentPresetContract), []);

  const invalid = (patch: Record<string, unknown>, index = 0) =>
    validateFrozenCompletionContract({
      ...currentPresetContract,
      gates: resolved.contract.gates.map((gate, at) => (at === index ? { ...gate, ...patch } : gate)),
    }).length > 0;
  assert.equal(invalid({ allowOverride: false }), true);
  assert.equal(invalid({ mandatorySignoff: "true" }), true);
  assert.equal(invalid({ mandatorySignoff: true }, 2), true);

  const rejects = (gates: string, pattern: RegExp) =>
    assert.throws(() => readSettingsFacet(repositoryYaml(`  gates:\n${gates}`)), pattern);
  const manual = resolveCompletionContract(
    ["review"],
    readSettingsFacet(
      repositoryYaml(
        "  gates:\n    review:\n      adapter: manual-attest\n      appliesTo: code\n      mandatorySignoff: true\n",
      ),
    ),
  );
  assert.equal(manual.ok, false);
  rejects(
    `    lint:\n      adapter: research/check\n      appliesTo: code\n      allowOverride: yes\n`,
    /allowOverride/u,
  );
});
