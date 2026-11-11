// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadGateAllowlist } from "../../gate-allowlists/load-gate-allowlist.mjs";
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
  t.diagnostic(
    `full-source closure: files=${result.filesScanned}, totals=${JSON.stringify(result.totals)}, durationMs=${result.durationMs}`,
  );
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
