// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCompletionContract,
  validateFrozenCompletionContract,
  type FrozenCompletionContract,
} from "../../src/domain/completion-contract.ts";
import { validateSubmissionV1 } from "../../src/domain/execution.ts";
import { readSettingsFacet, validateRepositorySettings, repositorySettings } from "../../src/domain/settings.ts";

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
  gates: [
    {
      gateId: "ci",
      appliesTo: "code",
      witness: {
        adapterId: "github-actions",
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
      witness: { adapterId: "code-doc-reconciliation", adapterOptions: {} },
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
  assert.equal(ci.ok, false);
  assert.match(ci.ok ? "" : ci.message, /completion gate ci.*settings\.gates maps no witness/u);
  const custom = resolveCompletionContract(["lint"], readSettingsFacet(repositoryYaml(githubCi)));
  assert.equal(custom.ok, false);
  assert.match(custom.ok ? "" : custom.message, /completion gate lint/u);
  const emptyRegistry = resolveCompletionContract(["ci"], readSettingsFacet(repositoryYaml(githubCi, "[]")));
  assert.equal(emptyRegistry.ok, false);
  assert.match(emptyRegistry.ok ? "" : emptyRegistry.message, /settings\.ci\.workflows is empty/u);
});

test("none removes a declared requirement without minting a witness, and undeclared mappings add nothing", () => {
  const settings = readSettingsFacet(
    repositoryYaml(
      "  gates:\n" +
        "    ci: none\n" +
        "    code-doc-reconciliation: none\n" +
        "    lint:\n" +
        "      appliesTo: code\n" +
        "      adapter: local-command\n" +
        "      command: npm run lint\n" +
        "    signoff:\n" +
        "      appliesTo: artifacts\n" +
        "      adapter: manual-attest\n",
    ),
  );

  assert.deepEqual(resolveCompletionContract(["ci", "code-doc-reconciliation"], settings), {
    ok: true,
    contract: { gates: [] },
  });
  assert.deepEqual(resolveCompletionContract(["lint", "signoff", "code-doc-reconciliation"], settings), {
    ok: true,
    contract: {
      gates: [
        {
          gateId: "lint",
          appliesTo: "code",
          witness: { adapterId: "local-command", adapterOptions: { command: "npm run lint" } },
        },
        { gateId: "signoff", appliesTo: "artifacts", witness: { adapterId: "manual-attest", adapterOptions: {} } },
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
  rejects(`    ci:\n      appliesTo: code\n      adapter: gitlab-pipeline\n`, /adapter/u);
  rejects(
    `    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n`,
    /must declare exactly/u,
  );
  rejects(`    lint:\n      adapter: local-command\n      command: npm test\n`, /must declare exactly/u);
  rejects(`    code-doc-reconciliation:\n      appliesTo: code\n      adapter: manual-attest\n`, /internal checker/u);
  rejects(`    ci: github-actions\n`, /cannot read line/u);
  rejects(`    ci: none\n      appliesTo: code\n`, /cannot read line/u);
  rejects(`    lint:\n      appliesTo: code\n      appliesTo: artifacts\n`, /cannot read line/u);
  assert.throws(() => readSettingsFacet(repositoryYaml("  gates: []\n")), /block of gate witness mappings/u);
  assert.match(
    validateRepositorySettings({
      ...repositorySettings(readSettingsFacet(repositoryYaml(githubCi))),
      gates: [{ gateId: "ci", adapter: "none", appliesTo: "code" }],
    }).join("\n"),
    /must declare exactly/u,
  );
});

test("the frozen contract schema fails closed on unknown fields and foreign adapter bindings", () => {
  const [ci, codeDoc] = currentPresetContract.gates as [
    FrozenCompletionContract["gates"][number],
    FrozenCompletionContract["gates"][number],
  ];
  const withOptions = (adapterOptions: Record<string, unknown>) => ({
    gates: [{ ...ci, witness: { ...ci.witness, adapterOptions } }],
  });

  assert.equal(validateFrozenCompletionContract({ gates: [{ ...ci, extra: true }] }).length, 1);
  assert.equal(
    validateFrozenCompletionContract(withOptions({ ...ci.witness.adapterOptions, cancel: "skip" })).length,
    1,
  );
  assert.deepEqual(
    validateFrozenCompletionContract(withOptions({ ...ci.witness.adapterOptions, cancel: "skip" }), true),
    [],
  );
  assert.equal(
    validateFrozenCompletionContract(withOptions({ workflows: [], branch: "main", event: "push" })).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract({ gates: [{ ...ci, witness: { adapterId: "none", adapterOptions: {} } }] }, true)
      .length,
    1,
  );
  assert.equal(validateFrozenCompletionContract({ gates: [ci, ci] }).length, 1);
  assert.equal(
    validateFrozenCompletionContract({
      gates: [{ ...ci, witness: { adapterId: "manual-attest", adapterOptions: {} } }],
    }).length,
    0,
  );
  assert.equal(validateFrozenCompletionContract({ gates: [{ ...codeDoc, appliesTo: "artifacts" }] }).length, 1);
  assert.equal(validateFrozenCompletionContract({ gates: [{ ...ci, witness: codeDoc.witness }] }).length, 1);
  assert.equal(
    validateFrozenCompletionContract({
      gates: [{ ...codeDoc, witness: { adapterId: "manual-attest", adapterOptions: {} } }],
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
  assert.equal(validateSubmissionV1(legacy, true).length, 1);
  assert.equal(validateSubmissionV1({ ...submission, completionContract: { gates: [], reviewer: "x" } }).length, 1);
});
