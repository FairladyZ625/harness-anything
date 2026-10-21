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

import { completionSnapshot, emptyCompletionContract, retiredHostedCiSource } from "./completion.fixtures.ts";
const resolveCompletionContract = (gates: readonly string[], settings: Parameters<typeof resolve>[1]) =>
  resolve(gates, settings, completionSnapshot);

const repositoryYaml = (gates: string) => `schema: harness-anything/v1\nsettings:\n${gates}`;

const githubCi =
  "  gates:\n" +
  "    ci:\n" +
  "      adapter: github-actions  # verdict source\n" +
  "      appliesTo: code\n" +
  "      event: push\n      coverage: descendant\n      selection: newest\n" +
  "      branch: main\n";

const historicalContract: FrozenCompletionContract = {
  ...emptyCompletionContract,
  closeoutGates: emptyCompletionContract.closeoutGates,
  gates: [
    {
      gateId: "ci",
      appliesTo: "code",
      witness: {
        adapterId: "github-actions",
        ...retiredHostedCiSource,
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

test("the retired code/doc gate mints no requirement, while frozen history stays readable", () => {
  const resolved = resolveCompletionContract(["code-doc-reconciliation"], readSettingsFacet(repositoryYaml("")));
  assert.deepEqual(resolved, { ok: true, contract: { ...historicalContract, gates: [] } });
  assert.deepEqual(validateFrozenCompletionContract(historicalContract), [], "frozen hosted history remains readable");
});

test("a declared local gate resolves its default source and an unknown gate fails closed", () => {
  const settings = readSettingsFacet(repositoryYaml(""));
  assert.deepEqual(settings.gates, []);
  assert.equal(resolveCompletionContract(["lint"], settings).ok, true);
  const custom = resolveCompletionContract(["unknown"], settings);
  assert.equal(custom.ok, false);
  assert.match(custom.ok ? "" : custom.message, /Gate unknown.*undeclared source/u);
});

test("new completion contracts cannot add hosted CI witnesses", () => {
  const settings = readSettingsFacet(repositoryYaml(githubCi));
  assert.deepEqual(settings.gates, [], "the retired settings field is normalized before settings are read");
  const resolved = resolveCompletionContract(["ci"], settings);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.ok ? resolved.contract.gates : null, [], "the retired source cannot mint a witness");
  for (const adapter of ["github-actions", "gitlab-pipeline"]) {
    const result = resolveCompletionContract(["ci"], { gates: [{ gateId: "ci", adapter }] });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /Hosted CI completion witnesses are retired/u);
  }
});

test("a task carrying the retired ci and code/doc profile gates freezes neither witness", () => {
  const resolved = resolveCompletionContract(["ci", "code-doc-reconciliation"], readSettingsFacet(repositoryYaml("")));
  assert.deepEqual(resolved, { ok: true, contract: { ...historicalContract, gates: [] } });
  assert.deepEqual(validateFrozenCompletionContract(resolved.ok ? resolved.contract : null), []);
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
    contract: { ...historicalContract, gates: [] },
  });
  assert.deepEqual(resolveCompletionContract(["lint", "signoff", "code-doc-reconciliation"], settings), {
    ok: true,
    contract: {
      ...historicalContract,
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

test("harness.yaml gate mappings reject unknown fields, unknown adapters, and malformed options", () => {
  const rejects = (gates: string, pattern: RegExp) =>
    assert.throws(() => readSettingsFacet(repositoryYaml(`  gates:\n${gates}`)), pattern);

  rejects(`    lint:\n      appliesTo: code\n      adapter: research/check\n      workflow: x\n`, /workflow/u);
  const unknown = resolveCompletionContract(["lint"], {
    gates: [{ gateId: "lint", adapter: "unknown", appliesTo: "code" }],
  });
  assert.equal(unknown.ok, false);
  assert.deepEqual(
    readSettingsFacet(repositoryYaml("    ci:\n      appliesTo: code\n      adapter: gitlab-pipeline\n")).gates,
    [],
    "the registered retired hosted mapping is removed from historical settings",
  );
  assert.equal(
    resolveCompletionContract(
      ["lint"],
      readSettingsFacet(repositoryYaml("  gates:\n    lint:\n      adapter: research/check\n")),
    ).ok,
    true,
  );
  rejects(`    lint: github-actions\n`, /cannot read line/u);
  rejects(`    lint: none\n      appliesTo: code\n`, /cannot read line/u);
  rejects(`    lint:\n      appliesTo: code\n      appliesTo: artifacts\n`, /cannot read line/u);
  assert.throws(() => readSettingsFacet(repositoryYaml("  gates: []\n")), /block of gate witness mappings/u);
  assert.match(
    validateRepositorySettings({
      ...repositorySettings(readSettingsFacet(repositoryYaml(""))),
      gates: [{ gateId: "ci", adapter: "none", appliesTo: "code" }],
    }).join("\n"),
    /none carries no options/u,
  );
});

test("the frozen contract schema fails closed on unknown fields and foreign adapter bindings", () => {
  const [ci, codeDoc] = historicalContract.gates as [
    FrozenCompletionContract["gates"][number],
    FrozenCompletionContract["gates"][number],
  ];
  const withOptions = (adapterOptions: Record<string, unknown>) => ({
    ...historicalContract,
    gates: [{ ...ci, witness: { ...ci.witness, adapterOptions } }],
  });

  assert.equal(validateFrozenCompletionContract({ ...historicalContract, gates: [{ ...ci, extra: true }] }).length, 1);
  for (const malformed of [{ predicateType: "" }, { resultSchema: null }])
    assert.equal(
      validateFrozenCompletionContract({
        ...historicalContract,
        gates: [{ ...ci, witness: { ...ci.witness, ...malformed } }],
      }).length,
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
      { ...historicalContract, gates: [{ ...ci, witness: { adapterId: "none", adapterOptions: {} } }] },
      true,
    ).length,
    1,
  );
  assert.equal(validateFrozenCompletionContract({ ...historicalContract, gates: [ci, ci] }).length, 1);
  assert.equal(
    validateFrozenCompletionContract({
      ...historicalContract,
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
    validateFrozenCompletionContract({ ...historicalContract, gates: [{ ...codeDoc, appliesTo: "artifacts" }] }).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract({ ...historicalContract, gates: [{ ...ci, witness: codeDoc.witness }] }).length,
    1,
  );
  assert.equal(
    validateFrozenCompletionContract({
      ...historicalContract,
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
    completionContract: historicalContract,
  };
  const { completionContract: _completionContract, ...legacy } = submission;

  assert.deepEqual(validateSubmissionV1(submission), []);
  assert.equal(validateSubmissionV1(legacy).length, 1);
  // dec_5EC2631352B17EE2BF4979E37E: old bytes require explicit offline conversion.
  assert.equal(validateSubmissionV1(legacy, true).length, 1);
  assert.equal(validateSubmissionV1({ ...submission, completionContract: { gates: [], reviewer: "x" } }).length, 1);
});

test("unconverted history never infers requirements from the current settings", () => {
  assert.equal(validateFrozenCompletionContract({ gates: historicalContract.gates }, true).length, 1);
  assert.equal(
    validateFrozenCompletionContract(
      {
        ...historicalContract,
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
      "    check:\n      adapter: research/check\n      appliesTo: code\n      mandatorySignoff: true\n" +
      "    lint:\n      adapter: research/check\n      appliesTo: code\n" +
      "      allowOverride: true\n      mandatorySignoff: false\n" +
      "    review:\n      adapter: manual-attest\n      appliesTo: artifacts\n",
    resolved = resolveCompletionContract(["check", "lint", "review"], readSettingsFacet(repositoryYaml(governedYaml)));
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
  assert.deepEqual(validateFrozenCompletionContract(historicalContract), []);

  const invalid = (patch: Record<string, unknown>, index = 0) =>
    validateFrozenCompletionContract({
      ...historicalContract,
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
