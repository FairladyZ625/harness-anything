// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadGateAllowlist } from "../../gate-allowlists/load-gate-allowlist.mjs";
import { loadOntologyClosureSnapshot } from "../ontology-gate-lib.mjs";
import { auditOntologyClosure } from "../ontology-closure-audit.mjs";
import { scanOntologyText, scanOntologySources } from "../ontology-closure-scan.mjs";
import { baselineFile, evaluateOntologyClosure, main } from "../ontology-closure.mjs";
import { captureGate, makeRepo, writeRepoFile } from "./helpers.mjs";

const file = "packages/kernel/src/domain/approval.ts";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixture = (name) => readFileSync(new URL(`./fixtures/ontology-closure/${name}.ts`, import.meta.url), "utf8");
const empty = { actions: [], kinds: [] };
const scan = (name, target = file) => scanOntologyText(target, fixture(name));
const debt = (candidate) => ({
  id: candidate.id,
  category: candidate.category,
  owner: "approval",
  status: "legacy-to-remove",
  replacementRef: "entity-kind:approval",
  removalSlice: "S1",
  ref: "dec_7E44897ECDCAEF2B92EC66A260",
  reason: candidate.reason,
});
const document = (rows) =>
  JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "ontology-closure",
    entries: { candidates: rows },
  });
function audit(candidates, options = {}) {
  return auditOntologyClosure({ candidates, baseline: [], previous: [], snapshot: empty, ...options });
}
function registered(candidates) {
  const sources = (category) =>
    candidates.filter((row) => row.category === category).map((row) => ({ candidateId: row.id, route: row.kind }));
  return {
    actions: [{ kind: "approval", ontology: { owner: "approval", sources: sources("action") } }],
    kinds: [
      {
        kind: "approval",
        judgments: [
          {
            id: "canApprove",
            symbol: `${file}#canApprove`,
            inputs: ["value"],
            output: "boolean",
            failureCodes: ["denied"],
            explain: "Approval eligibility",
            consumers: ["daemon"],
            sources: sources("judgment"),
          },
        ],
        policies: [
          {
            id: "approval-timeout",
            ownerRef: "action:approval",
            unit: "ms",
            bounds: "positive",
            defaultValue: 500,
            version: 1,
            scope: "approval",
            reason: "Bound approval execution",
            fixtures: ["positive"],
            sources: sources("policy"),
          },
        ],
      },
    ],
  };
}

test("the full repository passes the classified closure gate", (t) => {
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  assert.deepEqual(result.findings, []);
  assert.ok(result.filesScanned > 1000);
  const owned = result.classified.filter(
    (row) => row.category === "action" && /^packages\/(?:cli|kernel|preset)\//u.test(row.file),
  );
  assert.ok(owned.length > 0);
  assert.ok(owned.every((row) => row.status === "registered"));
  // dec_7E44897ECDCAEF2B92EC66A260/CH1 S2b-S2e: syntax candidates must resolve to the real semantic owner.
  const judgments = result.classified.filter(
    (row) =>
      row.category === "judgment" &&
      /^packages\/(?:kernel|storage|gui|preset|cli|application|authorization-[^/]+|dsh-plugin)\//u.test(row.file),
  );
  assert.ok(judgments.length > 0);
  assert.deepEqual(
    judgments.filter((row) => row.status !== "registered"),
    [],
  );
  for (const [symbol, action] of [
    ["cleanupConsumedDocumentDescriptor", "cli-local-effects"],
    ["installPresetPackage", "preset-install"],
    ["createPresetProcessService.execute.child", "preset-run-start"],
    ["writeDaemonRegistry", "daemon-local-state"],
  ]) {
    const sources = owned.filter((row) => row.symbol === symbol);
    assert.ok(sources.length > 0, symbol);
    assert.ok(
      sources.every((row) => row.declarationRef === `action:${action}`),
      symbol,
    );
  }
  t.diagnostic(
    `full-source closure: files=${result.filesScanned}, totals=${JSON.stringify(result.totals)}, durationMs=${result.durationMs}`,
  );
});

// dec_7E44897ECDCAEF2B92EC66A260 / S3d: retired debt cannot return to the leaf packages.
test("CLI and preset Policy candidates resolve to the canonical registry without legacy debt", () => {
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const baseline = loadGateAllowlist("ontology-closure", { report: false }).candidates;
  for (const owner of ["packages/cli", "packages/preset"]) {
    assert.deepEqual(
      baseline.filter(({ id }) => id.startsWith(`policy:${owner}:`)),
      [],
    );
    const candidates = result.classified.filter(
      ({ category, file }) => category === "policy" && file.startsWith(`${owner}/`),
    );
    assert.ok(candidates.length > 0, owner);
    assert.ok(
      candidates.every(({ status }) => status === "registered"),
      owner,
    );
  }
});

test("CLI/preset inline budgets still fail closed while canonical references add no leaf defaults", () => {
  for (const target of ["packages/cli/src/new-policy.ts", "packages/preset/src/new-policy.ts"]) {
    for (const source of [
      "const retryLimit = 5;",
      "const timeoutMs = 100;",
      "const maxConcurrency = 64;",
      "if (returnBudget > 3) reject();",
      "if (allowedAgents.length === 0) reject();",
    ]) {
      const candidates = scanOntologyText(target, source);
      assert.ok(
        audit(candidates).findings.some(({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED"),
        `${target}: ${source}`,
      );
    }
    const source =
      'import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";\nconst retryLimit = cliOperationalPolicy.defaultValue.reconnect.unreachableAttempts;';
    assert.deepEqual(audit(scanOntologyText(target, source)).findings, []);
  }
});

test("S3d kernel Policy source bindings retain LF/CRLF identities and reject changed defaults", () => {
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const [target, from, to] of [
    ["packages/kernel/src/domain/cli-operational-policy.ts", "unreachableAttempts: 5", "unreachableAttempts: 6"],
    ["packages/kernel/src/domain/preset-execution-policy.ts", "terminationGraceMs: 100", "terminationGraceMs: 101"],
  ]) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    assert.notEqual(source.replace(from, to), source);
    const original = scanOntologyText(target, source);
    assert.deepEqual(audit(original, { snapshot }).findings, []);
    assert.deepEqual(
      scanOntologyText(target, source.replaceAll("\n", "\r\n")).map(({ id }) => id),
      original.map(({ id }) => id),
    );
    assert.ok(
      audit(scanOntologyText(target, source.replace(from, to)), { snapshot }).findings.some(
        ({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED",
      ),
    );
  }
});

test("closure positive emits all three errors and prescriptions; negative text is accepted", () => {
  const result = audit(scan("positive"));
  assert.deepEqual([...new Set(result.findings.map((row) => row.code))].sort(), [
    "ONTOLOGY_ACTION_UNDECLARED",
    "ONTOLOGY_JUDGMENT_UNDECLARED",
    "ONTOLOGY_POLICY_UNDECLARED",
  ]);
  for (const row of result.findings) {
    assert.ok(row.id.includes(`${file}#`));
    assert.ok(row.line > 0 && row.reason.length > 20 && row.prescription.length > 20);
  }
  assert.deepEqual(audit(scan("negative")).findings, []);
});

test("input contracts retain their actual codec owner and exact identity without becoming domain judgments", () => {
  const target = "packages/preset/src/codec.ts",
    source =
      'function validateInput(value) { if (typeof value !== "string") return ["invalid input"]; return []; } function unrelated(value) { return value; }',
    candidates = scanOntologyText(target, source),
    contract = {
      id: "input",
      symbol: `${target}#validateInput`,
      explain: "Preset input codec",
      sources: [{ candidateId: candidates[0].id, route: `${target}#validateInput` }],
    },
    snapshot = { actions: [], kinds: [{ kind: "host", sourceContracts: [contract] }] };
  assert.deepEqual(audit(candidates, { snapshot }).findings, []);
  assert.equal(audit(candidates, { snapshot }).classified[0].declarationRef, "contract:host/input");
  assert.ok(
    audit(scanOntologyText(target, source.replace("string", "number")), { snapshot }).findings.some(
      (row) => row.code === "ONTOLOGY_JUDGMENT_UNDECLARED",
    ),
  );
  contract.symbol = `${target}#unrelated`;
  assert.ok(
    audit(candidates, { snapshot }).findings.some((row) => row.code === "ONTOLOGY_JUDGMENT_DUPLICATE"),
    "an unrelated function in the same file cannot own the input contract",
  );
  contract.symbol = "packages/preset/src/other.ts#wrongOwner";
  assert.ok(audit(candidates, { snapshot }).findings.some((row) => row.code === "ONTOLOGY_JUDGMENT_DUPLICATE"));
  contract.symbol = `${target}#validateInput`;
  contract.sources[0].route = `${target}#unrelated`;
  assert.ok(audit(candidates, { snapshot }).findings.some((row) => row.code === "ONTOLOGY_JUDGMENT_DUPLICATE"));
  contract.sources[0].route = contract.symbol;
  snapshot.kinds[0].sourceContracts.push(contract);
  assert.throws(() => audit(candidates, { snapshot }), /multiple ontology owners/u);
});

test("CLI deletion, timer, IPC and policy branch fixtures are detected", () => {
  assert.equal(scan("positive-cli-write")[0].name, "unlinkSync");
  const timer = scan("positive-timer-ipc");
  assert.ok(timer.some((row) => row.kind === "scheduled-occurrence"));
  assert.ok(timer.some((row) => row.kind === "gui-ipc"));
  const branch = scan("positive-policy-branch");
  assert.equal(branch[0].kind, "policy-branch");
  for (const candidates of [timer, branch, scan("positive-cli-write")]) {
    assert.ok(audit(candidates).findings.length > 0);
    const declarations = registered(scan("positive"));
    declarations.actions[0].ontology.sources = candidates
      .filter((row) => row.category === "action")
      .map((row) => ({ candidateId: row.id, route: row.kind }));
    if (!declarations.actions[0].ontology.sources.length) declarations.actions = [];
    declarations.kinds[0].policies[0].sources.push(
      ...candidates.filter((row) => row.category === "policy").map((row) => ({ candidateId: row.id, route: row.kind })),
    );
    assert.deepEqual(audit(candidates, { snapshot: declarations }).findings, []);
  }
});

test("identity ignores comments, blank lines, CRLF and quotes but preserves changed literals and multiplicity", () => {
  const text = fixture("positive");
  const ids = (source) => scanOntologyText(file, source).map((row) => row.id);
  assert.deepEqual(ids(text), ids(`// insertion\n\n${text.replaceAll('"', "'").replaceAll("\n", "\r\n")}`));
  assert.notDeepEqual(ids(text), ids(text.replace("500", "501")));
  const single = scanOntologyText(file, "function work() { dispatch(); }");
  const twice = scanOntologyText(file, "function work() { dispatch(); dispatch(); }");
  assert.equal(twice[0].id, single[0].id);
  assert.notEqual(twice[0].id, twice[1].id);
  assert.equal(audit(twice, { baseline: single.map(debt), previous: single.map(debt) }).findings.length, 1);
  for (const template of ["dispatch(tag`a\nb`);", "dispatch(tag`a\n${id}b\n${next}c\nd`);"]) {
    assert.deepEqual(ids(template), ids(template.replaceAll("\n", "\r\n")));
  }
  const jsx = "dispatch(<Confirm>approve\nrequest</Confirm>);";
  const jsxIds = (body) => scanOntologyText(file.replace(/\.ts$/u, ".tsx"), body).map((row) => row.id);
  assert.deepEqual(jsxIds(jsx), jsxIds(jsx.replaceAll("\n", "\r\n")));
});

// CH1 / review F1: every semantic text token must survive the normalized AST identity.
for (const change of JSON.parse(
  readFileSync(new URL("./fixtures/ontology-closure/literal-changes.json", import.meta.url), "utf8"),
)) {
  test(`literal identity rejects old debt after changing ${change.label}`, (t) => {
    const target = change.label === "JSX text" ? file.replace(/\.ts$/u, ".tsx") : file;
    const original = scanOntologyText(target, change.before),
      changed = scanOntologyText(target, change.after);
    const baseline = original.map(debt);
    assert.ok(original.some((row) => row.category === change.category));
    assert.deepEqual(audit(original, { baseline, previous: baseline }).findings, []);
    assert.notDeepEqual(
      changed.map((row) => row.id),
      original.map((row) => row.id),
    );
    const result = audit(changed, { baseline, previous: baseline });
    assert.ok(result.findings.some((row) => row.code === `ONTOLOGY_${change.category.toUpperCase()}_UNDECLARED`));
    t.diagnostic(`${change.label}: changed source rejects with ${result.findings.map((row) => row.code).join(", ")}`);
  });
}

function technicalSnapshot(candidate, expiresOn, actionLevel = false) {
  const exemption = {
    id: "technical-cleanup",
    candidateId: candidate.id,
    category: candidate.category,
    reason: "Technical cleanup",
    reviewer: "gate-reviewer",
    expiresOn,
  };
  return actionLevel
    ? {
        actions: [{ kind: "cleanup", ontology: { owner: "runtime", sources: [], exemptions: [exemption] } }],
        kinds: [],
      }
    : { actions: [], kinds: [{ kind: "runtime", ontologyExemptions: [exemption] }] };
}

for (const actionLevel of [false, true]) {
  for (const keepRow of [false, true]) {
    test(`shared ${actionLevel ? "action" : "kind"} exemption cannot renew expired debt with baseline ${keepRow ? "retained" : "removed"}`, () => {
      const candidates = scan("positive-cli-write"),
        candidate = candidates[0];
      const previous = [
        {
          ...debt(candidate),
          status: "technical-exempt",
          exemptionId: "expired",
          reviewer: "gate-reviewer",
          expiresOn: "2026-11-01",
        },
      ];
      const result = audit(candidates, {
        previous,
        baseline: keepRow ? previous : [],
        snapshot: technicalSnapshot(candidate, "2027-11-01", actionLevel),
        today: "2026-11-11",
      });
      assert.ok(result.findings.some((row) => row.code === "ONTOLOGY_BASELINE_GROWTH"));
      assert.equal(result.classified.length, 0);
    });
  }
}

test("frozen exemption deadlines allow shortening, true registration and deletion, without stale-baseline fallback", () => {
  const candidates = scan("positive-cli-write"),
    candidate = candidates[0];
  const previous = [
    {
      ...debt(candidate),
      status: "technical-exempt",
      exemptionId: "frozen",
      reviewer: "gate-reviewer",
      expiresOn: "2026-12-01",
    },
  ];
  const options = { baseline: previous, previous, today: "2026-11-11" };
  assert.ok(
    audit(candidates, { ...options, snapshot: technicalSnapshot(candidate, "2027-01-01") }).findings.some(
      (row) => row.code === "ONTOLOGY_BASELINE_GROWTH",
    ),
  );
  assert.deepEqual(
    audit(candidates, { ...options, snapshot: technicalSnapshot(candidate, "2026-11-20") }).findings,
    [],
  );
  assert.ok(
    audit(candidates, { ...options, snapshot: technicalSnapshot(candidate, "2026-11-01") }).findings.some(
      (row) => row.code === "ONTOLOGY_ACTION_UNDECLARED",
    ),
  );
  const expired = previous.map((row) => ({ ...row, expiresOn: "2026-11-01" }));
  const snapshot = {
    actions: [
      {
        kind: "cleanup",
        ontology: { owner: "runtime", sources: [{ candidateId: candidate.id, route: "cli-cleanup" }] },
      },
    ],
    kinds: [],
  };
  assert.deepEqual(audit(candidates, { baseline: [], previous: expired, snapshot, today: "2026-11-11" }).findings, []);
  assert.deepEqual(audit([], { baseline: [], previous: expired }).findings, []);
  const registeredHistory = [{ ...debt(candidate), status: "registered", declarationRef: "action:cleanup" }];
  assert.ok(
    audit(candidates, {
      baseline: [],
      previous: registeredHistory,
      snapshot: technicalSnapshot(candidate, "2027-01-01"),
      today: "2026-11-11",
    }).findings.some((row) => row.code === "ONTOLOGY_BASELINE_GROWTH"),
  );
  assert.deepEqual(audit(candidates, { baseline: [], previous: registeredHistory, snapshot }).findings, []);
  const other = scanOntologyText(file, "unlinkSync('another');")[0];
  assert.deepEqual(
    audit([other], {
      baseline: [],
      previous: expired,
      snapshot: technicalSnapshot(other, "2027-01-01"),
      today: "2026-11-11",
    }).findings,
    [],
  );
});

test("baseline rejects new identities even at equal count; deletion and registration shrink debt", () => {
  const candidates = scan("positive"),
    baseline = candidates.map(debt);
  assert.deepEqual(audit(candidates, { baseline, previous: baseline }).findings, []);
  const replacement = scanOntologyText(file, "unlinkSync('new');")[0];
  const swapped = [debt(replacement), ...baseline.slice(1)];
  const result = audit([replacement, ...candidates.slice(1)], { baseline: swapped, previous: baseline });
  assert.ok(result.findings.some((row) => row.code === "ONTOLOGY_BASELINE_GROWTH"));
  assert.deepEqual(audit([], { baseline: [], previous: baseline }).findings, []);
  const adopted = audit(candidates, { snapshot: registered(candidates), previous: baseline });
  assert.deepEqual(adopted.findings, []);
  assert.equal(adopted.removedIds.length, baseline.length);
});

test("registered counterparts pass; a copied edge judgment cannot claim a kernel declaration", () => {
  const candidates = scan("positive");
  assert.deepEqual(audit(candidates, { snapshot: registered(candidates) }).findings, []);
  const edge = scan("positive-duplicate-judgment", "packages/daemon/src/approval.ts");
  const snapshot = registered(candidates);
  snapshot.kinds[0].judgments[0].sources.push({ candidateId: edge[0].id, route: "edge-copy" });
  assert.equal(audit(edge, { snapshot }).findings[0].code, "ONTOLOGY_JUDGMENT_DUPLICATE");
  snapshot.kinds[0].policies[0].unit = "";
  assert.throws(() => audit(candidates, { snapshot }), /incomplete Policy declaration/u);
});

test("exemptions require owner, reason, reviewer and expiry; expiry cannot be extended or status downgraded", () => {
  const candidates = scan("positive-cli-write"),
    legacy = candidates.map(debt);
  const exempt = legacy.map((row) => ({
    ...row,
    status: "technical-exempt",
    exemptionId: row.id,
    reviewer: "gate-reviewer",
    expiresOn: "2026-12-01",
  }));
  assert.deepEqual(audit(candidates, { baseline: exempt, previous: exempt, today: "2026-11-11" }).findings, []);
  assert.equal(
    audit(candidates, { baseline: exempt, previous: exempt, today: "2026-12-02" }).findings[0].code,
    "ONTOLOGY_ACTION_UNDECLARED",
  );
  assert.equal(
    audit(candidates, { baseline: [{ ...exempt[0], expiresOn: "2027-01-01" }], previous: exempt }).findings[0].code,
    "ONTOLOGY_BASELINE_GROWTH",
  );
  assert.equal(audit(candidates, { baseline: legacy, previous: exempt }).findings[0].code, "ONTOLOGY_BASELINE_GROWTH");
  assert.throws(() => audit(candidates, { baseline: [{ ...exempt[0], owner: "" }] }), /invalid/u);
  const declared = legacy.map((row) => ({ ...row, status: "registered", declarationRef: "action:missing" }));
  assert.ok(audit(candidates, { baseline: declared, previous: declared }).findings.length);
  const snapshot = {
    actions: [],
    kinds: [
      {
        kind: "runtime",
        ontologyExemptions: [
          {
            id: "technical-cleanup",
            candidateId: candidates[0].id,
            category: "action",
            reason: "Technical fixture cleanup",
            reviewer: "gate-reviewer",
            expiresOn: "2026-12-01",
          },
        ],
      },
    ],
  };
  const admitted = audit(candidates, { snapshot, today: "2026-11-11" });
  assert.deepEqual(admitted.findings, []);
  assert.equal(admitted.classified[0].id, candidates[0].id);
  assert.equal(admitted.classified[0].exemptionId, "technical-cleanup");
  assert.ok(audit(candidates, { snapshot, today: "2026-12-02" }).findings.length);
});

test("real CLI scans the whole tracked/untracked source surface and compares against Git base", (t) => {
  const candidates = scan("positive"),
    baseline = candidates.map(debt);
  const { rootDir, base } = makeRepo({
    [file]: fixture("positive"),
    [baselineFile]: document(baseline),
    "packages/kernel/src/domain/action-declaration.ts": "export const actionDeclarations = [];",
    "packages/kernel/src/domain/entity-kind-registry.ts": "export const entityKindContracts = [];",
    ".gitignore": "ignored/\n",
  });
  assert.deepEqual(evaluateOntologyClosure({ rootDir, base }).findings, []);
  writeRepoFile(rootDir, "tools/new-command.mjs", "unlinkSync('new');");
  writeRepoFile(rootDir, "tools/test/excluded.ts", "dispatch();");
  writeRepoFile(rootDir, "tools/fixtures/excluded.ts", "dispatch();");
  writeRepoFile(rootDir, "tools/ignored/excluded.ts", "dispatch();");
  assert.equal(scanOntologySources(rootDir).filesScanned, 4);
  const red = captureGate(() => main(["--root", rootDir, "--base", base, "--mode", "ratchet"]));
  assert.equal(red.code, 1);
  assert.match(red.stderr, /ONTOLOGY_ACTION_UNDECLARED tools\/new-command/u);
  t.diagnostic(`unregistered source: exit=${red.code}\n${red.stderr}`);
  const newRow = scanOntologyText("tools/new-command.mjs", "unlinkSync('new');")[0];
  writeRepoFile(rootDir, baselineFile, document([...baseline, debt(newRow)]));
  assert.ok(evaluateOntologyClosure({ rootDir, base }).findings.some((row) => row.code === "ONTOLOGY_BASELINE_GROWTH"));
  writeRepoFile(rootDir, baselineFile, document(baseline));
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/action-declaration.ts",
    `export const actionDeclarations = ${JSON.stringify([{ kind: "cleanup", ontology: { owner: "host", sources: [{ candidateId: newRow.id, route: "cli" }] } }])};`,
  );
  const green = captureGate(() => main(["--root", rootDir, "--base", base, "--mode", "ratchet", "--json"]));
  assert.equal(green.code, 0, green.stderr);
  assert.equal(JSON.parse(green.stdout).findings.length, 0);
  t.diagnostic(`same source bound to ActionDeclaration: exit=${green.code}, findings=0`);
  assert.throws(() => evaluateOntologyClosure({ rootDir, base: "missing-base" }));
  assert.deepEqual(
    loadGateAllowlist("ontology-closure", { allowlistRoot: path.join(rootDir, "tools/gate-allowlists"), report: false })
      .candidates,
    baseline,
  );
});

// dec_7E44897ECDCAEF2B92EC66A260 / S3a: test budgets do not govern product admission.
test("GUI acceptance fixtures are excluded while neighboring product policies remain closed", () => {
  const text = "const retryLimit = 3; if (attempts > retryLimit + 1) dispatch();";
  const productFiles = [
    "packages/gui/src/renderer/query.ts",
    "packages/storage/src/query.ts",
    "packages/gui/src/e2e/product.ts",
    "packages/storage/src/gui-e2e/query.ts",
    "packages/gui/src/test-support/product.ts",
    "tools/gui-e2e.mjs",
    "tools/gui-e2e-helper.mjs",
  ];
  const fixtureFiles = [
    "packages/gui/e2e/builtin-first-run.e2e.mjs",
    "packages/gui/test-support/resident-daemon.mjs",
    "tools/gui-e2e/scenarios/project-windows.mjs",
    "tools/gui-e2e/capture.mjs",
  ];
  const { rootDir } = makeRepo(Object.fromEntries([...productFiles, ...fixtureFiles].map((file) => [file, text])));
  const scan = scanOntologySources(rootDir);
  assert.equal(scan.filesScanned, productFiles.length);
  assert.deepEqual([...new Set(scan.candidates.map((row) => row.file))].sort(), productFiles.sort());
  const findings = audit(scan.candidates).findings;
  for (const file of productFiles) {
    assert.ok(findings.some((row) => row.file === file && row.code === "ONTOLOGY_POLICY_UNDECLARED"));
    assert.ok(findings.some((row) => row.file === file && row.code === "ONTOLOGY_ACTION_UNDECLARED"));
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S1a: the owned package debt must leave the baseline.
test("S1a CLI/kernel/preset sources are declared without technical exemptions", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.removalSlice === "S1" && /^action:packages\/(?:cli|kernel|preset):/u.test(row.id)),
    [],
  );
});

test("every registered source contract names its own exact helper", () => {
  for (const kind of loadOntologyClosureSnapshot(repoRoot).kinds)
    for (const contract of kind.sourceContracts ?? [])
      for (const source of contract.sources)
        assert.equal(contract.symbol, source.route, `${contract.id} must name the actual source helper`);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S2c: storage decoding and transaction
// witnesses keep their exact source owner, with no frozen judgment debt.
test("storage judgment candidates leave the migration baseline", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.category === "judgment" && row.path.startsWith("packages/storage/")),
    [],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S2e: GUI IPC trust/payload validators, wire shape
// guards and viewport presentation helpers keep their exact source owner, with no frozen
// judgment debt and fail-closed rejection on undeclared or re-allowlisted GUI judgments.
test("gui judgment candidates leave the migration baseline", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.category === "judgment" && row.path.startsWith("packages/gui/")),
    [],
  );
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  const undeclared = scanOntologyText(
    "packages/gui/src/renderer/unregistered-guard.ts",
    "export function isUnregisteredGuiRow(v: unknown): boolean { if (!v || typeof v !== 'object') return false; return 'ok' in v; }\n",
  );
  assert.equal(undeclared.length, 1);
  assert.deepEqual(
    audit(undeclared, { snapshot }).findings.map((row) => row.code),
    ["ONTOLOGY_JUDGMENT_UNDECLARED"],
  );
  assert.deepEqual(
    audit(undeclared, { snapshot, baseline: [debt(undeclared[0])], previous: [] }).findings.map((row) => row.code),
    ["ONTOLOGY_BASELINE_GROWTH"],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S2f: tools engineering contracts are owned
// by their exact helpers and cannot return as frozen judgment debt.
test("tools judgment candidates leave the migration baseline and undeclared helpers fail closed", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.category === "judgment" && row.owner === "tools"),
    [],
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  const undeclared = scanOntologyText(
    "tools/unregistered-judgment.mjs",
    "export function isUnregisteredToolRow(v) { if (!v || typeof v !== 'object') return false; return 'ok' in v; }\n",
  );
  assert.equal(undeclared.length, 1);
  assert.deepEqual(
    audit(undeclared, { snapshot }).findings.map((row) => row.code),
    ["ONTOLOGY_JUDGMENT_UNDECLARED"],
  );
  assert.deepEqual(
    audit(undeclared, { snapshot, baseline: [debt(undeclared[0])], previous: [] }).findings.map((row) => row.code),
    ["ONTOLOGY_BASELINE_GROWTH"],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S3c: technical tool settings are not domain defaults.
test("tool technical syntax is classified without relaxing identical product policies", () => {
  const cases = JSON.parse(
    readFileSync(new URL("./fixtures/ontology-closure/tool-technical.json", import.meta.url), "utf8"),
  );
  for (const { label, text, target } of cases) {
    const tool = scanOntologyText(target, text);
    assert.deepEqual(
      tool.filter((row) => row.category === "policy"),
      [],
      label,
    );
    const product = scanOntologyText("packages/daemon/src/tool-settings.ts", text);
    assert.ok(
      product.some((row) => row.category === "policy"),
      label,
    );
    assert.ok(
      audit(product).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
      label,
    );
    assert.deepEqual(
      tool.filter((row) => row.category !== "policy").map(({ category, kind }) => ({ category, kind })),
      product.filter((row) => row.category !== "policy").map(({ category, kind }) => ({ category, kind })),
      label,
    );
    if (/^tools\/(?:perf|scale|soak|stress)\//u.test(target)) continue;
    const realPolicy = scanOntologyText(
      target,
      "const approvalTimeoutMs = 500; const retryLimit = 3; if (retryCount > 3) returnValue('deny');",
    );
    assert.equal(realPolicy.filter((row) => row.category === "policy").length, 3, label);
    assert.ok(
      audit(realPolicy).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
      label,
    );
  }
});

test("tools Policy debt is cleared without adding exemptions", () => {
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  assert.deepEqual(
    result.classified.filter((row) => row.category === "policy" && row.file.startsWith("tools/")),
    [],
  );
});

test("technical neighbors cannot hide a new tool policy threshold or nested config", () => {
  for (const text of [
    "const allowDispatch = true; const maxConcurrent = 3; const eligibilityRequired = true;",
    "if (admission.timeoutMs > 500) deny();",
    "if (admission.limit > 3) deny();",
    "if (concurrency > 3) deny();",
    "if (timeoutMs > 500) deny();",
    "if (attempt > 3) deny();",
    "const DEFAULT_ATTEMPTS = { retryLimit: 3 };",
    "if (approvalTimeoutMs > 500 || Date.now() >= deadline) deny();",
  ]) {
    for (const file of ["tools/ci/runner.mjs", "tools/gates/audit.mjs", "tools/new-command.mjs"]) {
      assert.ok(
        audit(scanOntologyText(file, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
        `${file}: ${text}`,
      );
    }
  }
});

test("audited load roots narrow only Policy, keeping actions and judgments and similar product paths", () => {
  const text = "const newQuota = 7; function canDispatch() { if (newQuota > 3) return true; } dispatch();";
  const product = scanOntologyText("packages/daemon/src/load.ts", text);
  for (const root of ["perf", "scale", "soak", "stress"]) {
    const rows = scanOntologyText(`tools/${root}/arbitrary.mjs`, text);
    assert.deepEqual(
      rows.filter((row) => row.category === "policy"),
      [],
    );
    assert.deepEqual(
      rows.map(({ category, kind }) => ({ category, kind })),
      product.filter((row) => row.category !== "policy").map(({ category, kind }) => ({ category, kind })),
    );
    for (const target of [`packages/daemon/src/${root}/load.ts`, `tools/${root}-helper.mjs`])
      assert.ok(
        audit(scanOntologyText(target, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
      );
  }
});

test("tool syntax classification generalizes across counter, flag and constant names", () => {
  for (const text of [
    "const PARSER_RETRY_ATTEMPTS = 4; const CUSTOM_TIMEOUT_MS = 900;",
    "const allowedParserDialects = new Set(['js']); if (!allowedParserDialects.has('mjs')) report();",
    "for (let retryIndex = 0; retryIndex < 4; retryIndex++) { if (retryIndex === 3) throw problem; }",
    "for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) { if (attemptIndex + 1 < attempts) next(); }",
    "if (cutoffDeadline <= Date.now() && pending > 0) throw problem;",
    "if (typeof transport.retryable === 'boolean') returnValue();",
    "const MIN_TOOL_TIMEOUT_MS = 17; if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < MIN_TOOL_TIMEOUT_MS) throw problem;",
    "launchTool('compiler', ['--version'], { cwd: scratch, timeout: 2345 });",
  ]) {
    assert.deepEqual(
      scanOntologyText("tools/ci/arbitrary.mjs", text).filter((row) => row.category === "policy"),
      [],
      text,
    );
    assert.ok(
      audit(scanOntologyText(file, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
      text,
    );
  }
});

test("tool process option classification cannot hide domain call options", () => {
  for (const file of ["tools/ci/runner.mjs", "tools/gates/audit.mjs", "tools/new-command.mjs"]) {
    for (const text of [
      "dispatch({ timeoutMs: 500, limit: 3 });",
      "const settings = { timeout: 500, limit: 3 };",
      "const schema = { limit: { type: 'integer', default: 3 } };",
      "const settings = { riskTier: 'high', retryLimit: 3 };",
      "const approvalPolicy = 'strict';",
      "const constraints = { retryOnFailure: false };",
      "configure({ settings: { limit: 3 } });",
      "const retryLimit = 0;",
      "if (retryCount === 0) dispatch();",
      "const config = { retryLimit: 0 };",
      "if (receipt.limit >= 0) dispatch();",
    ])
      assert.ok(
        audit(scanOntologyText(file, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
        `${file}: ${text}`,
      );
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: syntax alone cannot prove technical semantics.
const undeclaredPolicy = (text) => {
  for (const target of ["tools/new-command.mjs", file])
    assert.ok(
      audit(scanOntologyText(target, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
      `${target}: ${text}`,
    );
};

test("unrelated and shadowing loop bindings cannot hide independent retry policies", () => {
  for (const text of [
    "for (let item = 0; item < batch.length; item++) { if (retryCount > 3) dispatch(); }",
    "for (let item = 0; item < 2; item++) { for (let entry = 0; entry < 4; entry++) { if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { { const retryCount = externalCount; if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { { const { retryCount } = settings; if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { function run(retryCount) { if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { try { work(); } catch (retryCount) { if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { for (const retryCount of values) { if (retryCount > 3) dispatch(); } }",
    "for (let retryCount = 0; retryCount < 4; retryCount++) { if (admission.retryCount > 3) dispatch(); }",
    "for (let retryLimit = 3; running; tick()) { if (retryLimit > 3) dispatch(); }",
  ])
    undeclaredPolicy(text);
});

test("unknown call and constructor inputs retain Policy even behind effect wrappers", () => {
  for (const text of [
    "function configure(settings) { dispatch(settings); } configure({ limit: 3 });",
    "function configure(settings) { dispatch(settings); } const settings = { limit: 3 }; configure(settings);",
    "function readPage(settings) { dispatch(settings); } readPage({ limit: 3 });",
    "class Request { constructor(settings) { dispatch(settings); } } new Request({ limit: 3 });",
    "unknownCall({ limit: 3 });",
    "new UnknownType({ limit: 3 });",
  ])
    undeclaredPolicy(text);
});

test("returned zero and nonzero retry settings are policies rather than assumed observations", () => {
  for (const text of [
    "function retryOptions() { return { retryLimit: 0 }; } dispatch(retryOptions());",
    "function retryOptions() { return { retryLimit: 1 }; } dispatch(retryOptions());",
    "function retryOptions() { return { attempts: 0 }; } dispatch(retryOptions());",
    "function retryOptions() { return { settings: { retryLimit: 0 } }; } dispatch(retryOptions());",
    "const retryOptions = () => ({ retryLimit: 0 }); dispatch(retryOptions());",
  ])
    undeclaredPolicy(text);
});

test("integer guards do not erase numeric admission and retry boundaries", () => {
  for (const text of [
    "if (Number.isInteger(admission.limit) && admission.limit > 3) dispatch();",
    "if (!Number.isInteger(admission.limit) || admission.limit < 3) deny();",
    "if (ready && (Number.isInteger(admission.limit) && admission.limit > 3)) dispatch();",
    "if (Number.isSafeInteger(admission.timeoutMs) && admission.timeoutMs >= 500) dispatch();",
    "if (Number.isInteger(admission.limit) && admission.limit >= 0) dispatch();",
    "if (Number.isInteger(value.retryCount) && value.retryCount > 3) dispatch();",
    "if (Number.isInteger(admission.limit) && admission.limit > Math.max(3, 0)) dispatch();",
    "if (Number.isInteger(admission.limit) && checkLimit(admission.limit, 3)) dispatch();",
    "if (admission.limit > configuredThreshold(3)) dispatch();",
    "const errors = []; if (!(Number.isInteger(admission.limit) && admission.limit >= 0)) dispatch();",
    "const errors = []; if (!(Number.isInteger(admission.limit) && admission.limit >= 3)) errors.push('denied');",
    "if (!(Number.isInteger(admission.limit) && admission.limit >= 0)) unknownErrors.push('denied');",
    "function validate(Number, value) { const errors = []; if (!(Number.isInteger(value.limit) && value.limit >= 0)) errors.push('denied'); return errors; }",
    "const validate = function Number(value) { const errors = []; if (!(Number.isInteger(value.limit) && value.limit >= 0)) errors.push('denied'); return errors; };",
    "const errors = []; try { work(); } catch (errors) { if (!(Number.isInteger(admission.limit) && admission.limit >= 0)) errors.push('denied'); }",
    "const errors = []; if (!(Number.isInteger(admission.limit) && admission.limit >= 0) && permit()) errors.push('denied');",
    "const errors = []; if (!(Number.isInteger(admission.limit) && admission.limit >= 0)) errors.push(message());",
  ])
    undeclaredPolicy(text);
});

test("primitive non-negative shape diagnostics do not configure an action", () => {
  const text =
    "function validate(value) { const diagnostics = []; if (!(Number.isInteger(value.limit) && value.limit >= 0)) diagnostics.push('invalid'); return diagnostics; }";
  assert.deepEqual(
    scanOntologyText("tools/new-command.mjs", text).filter((row) => row.category === "policy"),
    [],
  );
  assert.ok(audit(scanOntologyText(file, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"));
});

test("explicit tool constant sources retain technical reads and observations of any count", () => {
  for (const count of [0, 2]) {
    for (const text of [
      `const OBSERVED_ATTEMPTS = ${count}; function receipt() { return { attempts: OBSERVED_ATTEMPTS }; }`,
      "const SNAPSHOT_LIMIT = 100; snapshot({ limit: SNAPSHOT_LIMIT });",
    ]) {
      assert.deepEqual(
        scanOntologyText("tools/new-command.mjs", text).filter((row) => row.category === "policy"),
        [],
      );
      assert.ok(audit(scanOntologyText(file, text)).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"));
    }
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S2g: daemon protocol wire validators, local client
// socket/handshake checks, home overview shape validation and Fleet transport/preflight
// contracts keep their exact source owner, with zero frozen judgment debt in those paths.
test("daemon protocol, client, home and fleet judgment candidates leave the migration baseline", () => {
  const s2gPath =
    /^packages\/daemon\/src\/(?:protocol\/|gui-s3-control\.ts$|client\/|home\/|fleet\/|fleet-edge-git-preflight\.ts$|fleet-task-delivery\.ts$)/u;
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.category === "judgment" && s2gPath.test(row.path)),
    [],
  );

  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const registeredInSlice = result.classified.filter((row) => row.category === "judgment" && s2gPath.test(row.file));
  assert.ok(registeredInSlice.length >= 100);
  assert.deepEqual(
    registeredInSlice.filter((row) => row.status !== "registered"),
    [],
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const target of [
    "packages/daemon/src/protocol/unregistered-wire-guard.ts",
    "packages/daemon/src/client/unregistered-socket-guard.ts",
    "packages/daemon/src/fleet/unregistered-frame-guard.ts",
  ]) {
    const undeclared = scanOntologyText(
      target,
      "export function validateUnregisteredFrame(v: unknown): boolean { if (!v || typeof v !== 'object') return false; return 'ok' in v; }\n",
    );
    assert.equal(undeclared.length, 1, target);
    assert.deepEqual(
      audit(undeclared, { snapshot }).findings.map((row) => row.code),
      ["ONTOLOGY_JUDGMENT_UNDECLARED"],
      target,
    );
    assert.deepEqual(
      audit(undeclared, { snapshot, baseline: [debt(undeclared[0])], previous: [] }).findings.map((row) => row.code),
      ["ONTOLOGY_BASELINE_GROWTH"],
      target,
    );
  }
});
