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
// dec_7E44897ECDCAEF2B92EC66A260/CH1: application, builtin and DSH have no remaining migration debt.
test("application, builtin authorization and DSH remain closed in every ontology category", () => {
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const baseline = loadGateAllowlist("ontology-closure", { report: false }).candidates;
  for (const owner of ["packages/application", "packages/authorization-builtin", "packages/dsh-plugin"]) {
    assert.deepEqual(
      baseline.filter((row) => row.owner === owner),
      [],
      owner,
    );
    for (const category of ["action", "judgment", "policy"]) {
      const candidates = result.classified.filter(
        (row) => row.category === category && row.file.startsWith(`${owner}/`),
      );
      assert.ok(candidates.length > 0, `${owner}/${category}`);
      assert.deepEqual(
        candidates.filter((row) => row.status !== "registered"),
        [],
        `${owner}/${category}`,
      );
    }
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the final provider slice closes every authorization package.
test("all authorization packages stay at zero ontology migration debt", () => {
  const baseline = loadGateAllowlist("ontology-closure", { report: false }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner.startsWith("packages/authorization-")),
    [],
  );
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  for (const owner of ["packages/authorization-keycloak", "packages/authorization-keycloak-gui"]) {
    assert.deepEqual(
      baseline.filter((row) => row.owner === owner),
      [],
      owner,
    );
    const candidates = result.classified.filter((row) => row.file.startsWith(`${owner}/`));
    assert.ok(
      candidates.some((row) => row.category === "action"),
      owner,
    );
    assert.deepEqual(
      candidates.filter((row) => row.status !== "registered"),
      [],
      owner,
    );
  }
  const policies = loadOntologyClosureSnapshot(repoRoot).kinds.flatMap((kind) => kind.policies ?? []);
  for (const owner of ["packages/authorization-keycloak", "packages/authorization-keycloak-gui"])
    assert.ok(
      policies.some((policy) => policy.sources.some((source) => source.candidateId.startsWith(`policy:${owner}:`))),
      owner,
    );
  assert.deepEqual(
    result.findings.filter((row) => row.file?.startsWith("packages/authorization-")),
    [],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: daemon protocol, client, transport, access and Fleet closure is shrink-only.
test("daemon protocol and Fleet boundary remains at zero ontology migration debt", () => {
  const baseline = loadGateAllowlist("ontology-closure", { report: false }).candidates;
  const boundary = (row) =>
    row.owner === "packages/daemon" &&
    /^packages\/daemon\/src\/(?:protocol\/|client\/|fleet\/|fleet-|access-|gui-s3-|oidc-|keycloak-|host-action-authorization\.ts|authorization-provider\.ts|hosting-provider\.ts|remote-proxy\.ts|rpc-command-routing\.ts|transport\/|tls-)/u.test(
      row.path,
    );
  assert.deepEqual(baseline.filter(boundary), []);
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const classified = result.classified.filter(
    (row) =>
      boundary({ owner: "packages/daemon", path: row.file }) &&
      (row.category === "action" || row.category === "policy"),
  );
  assert.ok(classified.some((row) => row.category === "action"));
  assert.ok(classified.some((row) => row.category === "policy"));
  assert.deepEqual(
    classified.filter((row) => row.status !== "registered"),
    [],
    "every daemon boundary action and policy candidate must resolve to its shared declaration",
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: reject a changed default and a neighboring effect, not just a path.
test("daemon boundary registrations reject changed policies and undeclared actions", () => {
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  const target = "packages/kernel/src/domain/cli-operational-policy.ts";
  const source = readFileSync(path.join(repoRoot, target), "utf8");
  const original = scanOntologyText(target, source);
  assert.deepEqual(audit(original, { snapshot }).findings, []);
  const changed = source.replace("reconnectAttemptLimit: 5", "reconnectAttemptLimit: 6");
  assert.notEqual(changed, source);
  assert.ok(
    audit(scanOntologyText(target, changed), { snapshot }).findings.some(
      ({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED",
    ),
  );
  const daemonTarget = "packages/daemon/src/client/local-json-rpc-stream.ts";
  const daemonSource = readFileSync(path.join(repoRoot, daemonTarget), "utf8");
  assert.deepEqual(audit(scanOntologyText(daemonTarget, daemonSource), { snapshot }).findings, []);
  for (const [extra, expected] of [
    ["\nconst reconnectAttemptLimit = 6;", "ONTOLOGY_POLICY_UNDECLARED"],
    ["\nunlinkSync('unregistered-neighbor');", "ONTOLOGY_ACTION_UNDECLARED"],
  ]) {
    assert.ok(
      audit(scanOntologyText(daemonTarget, daemonSource + extra), { snapshot }).findings.some(
        ({ code }) => code === expected,
      ),
      expected,
    );
  }
});

test("leaf Policy bindings preserve defaults and distinguish exact presentation contracts from new budgets", () => {
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const [target, from, to] of [
    [
      "packages/kernel/src/domain/task-submission-policy.ts",
      'snapshotAdmissionKind: "repository-path"',
      'snapshotAdmissionKind: "url"',
    ],
    ["packages/kernel/src/domain/task-submission-policy.ts", "pageLimit: 100", "pageLimit: 101"],
    ["packages/kernel/src/domain/cli-operational-policy.ts", "outputLimit: 1_000_000", "outputLimit: 1_000_001"],
    ["packages/kernel/src/domain/cli-operational-policy.ts", "terminationGraceMs: 5_000", "terminationGraceMs: 5_001"],
    [
      "packages/authorization-builtin/src/builtin-policy-adapter.ts",
      'policyRef = "builtin-policy@1"',
      'policyRef = "builtin-policy@2"',
    ],
    ["packages/dsh-plugin/src/client.ts", 'referrerPolicy: "no-referrer"', 'referrerPolicy: "origin"'],
    ["packages/dsh-plugin/src/tutorial-content.ts", 'retry: "重试"', 'retry: "再次尝试"'],
    ["packages/dsh-plugin/src/tutorial-content.ts", 'retry: "Retry"', 'retry: "Try again"'],
  ]) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    assert.notEqual(source.replace(from, to), source, target);
    const candidates = scanOntologyText(target, source);
    assert.deepEqual(audit(candidates, { snapshot }).findings, [], target);
    assert.deepEqual(
      scanOntologyText(target, source.replaceAll("\n", "\r\n")).map(({ id }) => id),
      candidates.map(({ id }) => id),
    );
    assert.ok(
      audit(scanOntologyText(target, source.replace(from, to)), { snapshot }).findings.some(
        ({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED",
      ),
      `${target}: ${from}`,
    );
  }
  for (const owner of ["application", "authorization-builtin", "dsh-plugin"]) {
    const target = `packages/${owner}/src/new-policy.ts`;
    assert.ok(
      audit(scanOntologyText(target, "const retryLimit = 3;"), { snapshot }).findings.some(
        ({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED",
      ),
    );
  }
});

test("leaf action registrations remain exact and do not authorize a neighboring undeclared call", () => {
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const target of [
    "packages/application/src/task-lifecycle-service.ts",
    "packages/authorization-builtin/src/builtin-policy-adapter.ts",
    "packages/dsh-plugin/src/broker.ts",
  ]) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    assert.deepEqual(audit(scanOntologyText(target, source), { snapshot }).findings, [], target);
    const result = audit(scanOntologyText(target, `${source}\nfunction undeclared() { dispatch(); }`), { snapshot });
    assert.equal(result.findings.length, 1, target);
    assert.equal(result.findings[0].code, "ONTOLOGY_ACTION_UNDECLARED");
    assert.equal(result.findings[0].symbol, "undeclared");
  }
});

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

// dec_7E44897ECDCAEF2B92EC66A260/CH1: packages/kernel has no frozen ontology debt in any category.
test("packages/kernel stays at zero ontology baseline and every kernel candidate is registered", () => {
  const baseline = loadGateAllowlist("ontology-closure", { report: false }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner === "packages/kernel" || row.path?.startsWith("packages/kernel/")),
    [],
  );
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  for (const category of ["action", "judgment", "policy"]) {
    const candidates = result.classified.filter(
      (row) => row.category === category && row.file.startsWith("packages/kernel/"),
    );
    assert.ok(candidates.length > 0, category);
    assert.deepEqual(
      candidates.filter((row) => row.status !== "registered"),
      [],
      category,
    );
  }
  assert.deepEqual(
    result.findings.filter((row) => row.file?.startsWith("packages/kernel/")),
    [],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: kernel defaults stay bound to their declaration; a changed value is new debt.
test("kernel Policy defaults keep LF/CRLF identities and a changed default fails closed", () => {
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const [target, from, to] of [
    [
      "packages/kernel/src/schemas/vertical-definition.ts",
      "VERTICAL_DECODE_ISSUE_LIMIT = 8",
      "VERTICAL_DECODE_ISSUE_LIMIT = 9",
    ],
    ["packages/kernel/src/domain/todo-soft-limit.ts", "DEFAULT_TODO_SOFT_LIMIT = 30", "DEFAULT_TODO_SOFT_LIMIT = 31"],
    ["packages/kernel/src/domain/task-wip-policy.ts", "DEFAULT_TASK_WIP_LIMIT = 30", "DEFAULT_TASK_WIP_LIMIT = 31"],
    [
      "packages/kernel/src/domain/settings-field-declarations.ts",
      "DEFAULT_GUI_REQUEST_TIMEOUT_MS = 30_000",
      "DEFAULT_GUI_REQUEST_TIMEOUT_MS = 30_001",
    ],
    ["packages/kernel/src/domain/execution.ts", "{ capacity: 32 }", "{ capacity: 33 }"],
    [
      "packages/kernel/src/domain/dispatch-lifecycle.ts",
      "DISPATCH_LIFECYCLE_PAGE_LIMIT = 100",
      "DISPATCH_LIFECYCLE_PAGE_LIMIT = 101",
    ],
    ["packages/kernel/src/domain/query-payload-validation.ts", "Number(limit) > 500", "Number(limit) > 501"],
    ["packages/kernel/src/composition/receipt-acceptance.ts", "timeout > 60_000", "timeout > 60_001"],
    ["packages/kernel/src/domain/canonical-event-summary.ts", "SUMMARY_TEXT_LIMIT = 280", "SUMMARY_TEXT_LIMIT = 281"],
  ]) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    assert.notEqual(source.replace(from, to), source, `${target}: ${from}`);
    const original = scanOntologyText(target, source);
    assert.deepEqual(audit(original, { snapshot }).findings, [], target);
    assert.deepEqual(
      scanOntologyText(target, source.replaceAll("\n", "\r\n")).map(({ id }) => id),
      original.map(({ id }) => id),
      target,
    );
    assert.ok(
      audit(scanOntologyText(target, source.replace(from, to)), { snapshot }).findings.some(
        ({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED",
      ),
      `${target}: ${from}`,
    );
  }
  const fresh = scanOntologyText("packages/kernel/src/domain/new-policy.ts", "const retryLimit = 3;");
  assert.ok(audit(fresh, { snapshot }).findings.some(({ code }) => code === "ONTOLOGY_POLICY_UNDECLARED"));
  assert.deepEqual(
    audit(fresh, { snapshot, baseline: [debt(fresh[0])], previous: [] }).findings.map(({ code }) => code),
    ["ONTOLOGY_BASELINE_GROWTH"],
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

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S4: every tools/ action source is registered with zero
// baseline debt; business CLI/RPC calls bind to their owning business ActionDeclaration while
// temp/report writes, harness runners, and build scripts remain owned by package-assets-build,
// and new unregistered technical or business calls fail closed.
test("tools baseline is permanently zero and new tool execution calls fail closed", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner === "tools" || row.path?.startsWith("tools/")),
    [],
  );
  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const tools = result.classified.filter((row) => row.file.startsWith("tools/") && row.category === "action");
  assert.ok(tools.length > 0);
  assert.deepEqual(
    tools.filter((row) => row.status !== "registered"),
    [],
  );
  assert.deepEqual(
    result.findings.filter((row) => row.file?.startsWith("tools/")),
    [],
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  const byId = new Map(tools.map((row) => [row.id, row]));
  for (const [id, kind, route] of [
    [
      "action:tools:tools/dispatch-task.mjs#runDispatch.created:af6e933980fd681782dea0c6c5b3378d",
      "task-create",
      "task-create",
    ],
    [
      "action:tools:tools/dispatch-task.mjs#runDispatch.started:0093d222ea8f5c746b8628b32f79b4c2",
      "task-start",
      "task-start",
    ],
    [
      "action:tools:tools/dispatch-task.mjs#runDispatch.dispatched:87fdb4d67496dcabe68fb5191092ec1a",
      "runtime-run",
      "runtime-run",
    ],
    [
      "action:tools:tools/stress/fleet/fleet-fixture.mjs#openFleetCampaignFixture.installed:8657606fb6a6e38dd7dd960fe4cefb14",
      "agent-install",
      "agent-install",
    ],
  ]) {
    const row = byId.get(id);
    assert.equal(row?.declarationRef, `action:${kind}`, id);
    const source = snapshot.actions
      .find((action) => action.kind === kind)
      ?.ontology?.sources?.find((entry) => entry.candidateId === id);
    assert.equal(source?.route, route, id);
    assert.equal(source?.role, "client", id);
  }
  for (const id of [
    "action:tools:tools/dispatch-task.mjs#runDispatch:2dda8ecc56927d74b87336bc5de0b57e",
    "action:tools:tools/measure-cli-command-timing.mjs#main:c5fd5bac60d8abe94db1a9a556b7874e",
  ]) {
    assert.equal(byId.get(id)?.declarationRef, "action:package-assets-build", id);
  }

  const text = 'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/unregistered", "x");\n';
  for (const target of [
    "tools/unregistered-effect.mjs",
    "tools/scale/unregistered-effect.mjs",
    "packages/cli/src/x.ts",
  ]) {
    const undeclared = scanOntologyText(target, text);
    assert.deepEqual(
      undeclared.map(({ category, name }) => ({ category, name })),
      [{ category: "action", name: "writeFileSync" }],
      target,
    );
    assert.deepEqual(
      audit(undeclared, { snapshot }).findings.map((row) => row.code),
      ["ONTOLOGY_ACTION_UNDECLARED"],
      target,
    );
    assert.deepEqual(
      audit(undeclared, { snapshot, baseline: [debt(undeclared[0])], previous: [] }).findings.map((row) => row.code),
      ["ONTOLOGY_BASELINE_GROWTH"],
      target,
    );
  }

  const businessCallText = [
    'import { spawn } from "node:child_process";',
    'export function deleteTask(id) { spawn("ha", ["task", "delete", id]); }',
  ].join("\n");
  for (const target of ["tools/unregistered-business-call.mjs", "tools/scale/unregistered-business-call.mjs"]) {
    const undeclared = scanOntologyText(target, businessCallText);
    assert.deepEqual(
      undeclared.map(({ category, name }) => ({ category, name })),
      [{ category: "action", name: "spawn" }],
      target,
    );
    assert.deepEqual(
      audit(undeclared, { snapshot }).findings.map((row) => row.code),
      ["ONTOLOGY_ACTION_UNDECLARED"],
      target,
    );
    assert.deepEqual(
      audit(undeclared, { snapshot, baseline: [debt(undeclared[0])], previous: [] }).findings.map((row) => row.code),
      ["ONTOLOGY_BASELINE_GROWTH"],
      target,
    );
  }
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

// dec_7E44897ECDCAEF2B92EC66A260/CH1 S2h: final repository-wide Judgment debt zeroing.
// Zero `category === "judgment"` entries remain in `ontology-closure.json` across the entire
// repository; every judgment candidate in `packages/` and `tools/` resolves to a canonical
// kernel `EntityKindContract.judgments` entry or exact `sourceContracts` owner, and any
// undeclared or re-allowlisted judgment candidate fails closed.
test("dec_7E44897ECDCAEF2B92EC66A260/CH1 S2h: repository-wide judgment baseline is permanently zero", () => {
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.category === "judgment"),
    [],
    "dec_7E44897ECDCAEF2B92EC66A260/CH1 requires 0 judgment allowlist entries across the entire repository",
  );

  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  assert.equal(result.after.judgment, 0);
  const allJudgments = result.classified.filter((row) => row.category === "judgment");
  assert.ok(allJudgments.length >= 550);
  assert.deepEqual(
    allJudgments.filter((row) => row.status !== "registered"),
    [],
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const target of [
    "packages/daemon/src/runtime-unregistered-guard.ts",
    "packages/daemon/src/repo-cell-unregistered-guard.ts",
    "packages/daemon/src/migration-unregistered-guard.ts",
    "packages/kernel/src/domain/unregistered-judgment.ts",
  ]) {
    const undeclared = scanOntologyText(
      target,
      "export function assertUnregisteredS2hCandidate(v: unknown): boolean { if (!v || typeof v !== 'object') return false; return 'ok' in v; }\n",
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

// dec_7E44897ECDCAEF2B92EC66A260/CH1: daemon repo, writer, submission, doc-sync and workspace
// action and policy candidates leave the migration baseline cleanly via semantic action owners and
// shared kernel policy declarations (never cli-local-effects).
test("dec_7E44897ECDCAEF2B92EC66A260/CH1: daemon repo/writer/submission/doc-sync/workspace action & policy closure", () => {
  const scopePath =
    /^packages\/daemon\/src\/(?:repo-|writer-|submission-|doc-sync|artifacts-gui-read|entity-document-|ignored-ledger-|submit-old-|transition-document-|workspace-|worktree-)/u;
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner === "packages/daemon" && scopePath.test(row.path)),
    [],
    "dec_7E44897ECDCAEF2B92EC66A260/CH1 requires 0 allowlist entries for daemon repo/writer/submission/doc-sync/workspace paths",
  );

  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const inScope = result.classified.filter((row) => scopePath.test(row.file));
  assert.ok(inScope.length >= 240);
  assert.deepEqual(
    inScope.filter((row) => row.status !== "registered"),
    [],
  );

  const daemonActions = result.classified.filter(
    (row) => row.category === "action" && row.file.startsWith("packages/daemon/"),
  );
  assert.deepEqual(
    daemonActions.filter((row) => row.declarationRef === "action:cli-local-effects"),
    [],
    "daemon actions must never bind to cli-local-effects",
  );

  for (const [symbol, action] of [
    ["removeHarnessIgnoreRules", "repo-purge"],
    ["purgeRepoCache", "repo-purge"],
    ["removeRepoHarnessRoots", "repo-purge"],
    ["runDocMaterialize", "doc-materialize"],
    ["createRepoCellApi.cancelRuntime", "runtime-cancel"],
  ]) {
    const matches = inScope.filter((row) => row.category === "action" && row.symbol === symbol);
    assert.ok(matches.length > 0, symbol);
    assert.ok(
      matches.every((row) => row.declarationRef === `action:${action}`),
      symbol,
    );
  }

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const target of [
    "packages/daemon/src/repo-unregistered-probe.ts",
    "packages/daemon/src/writer-unregistered-probe.ts",
    "packages/daemon/src/submission-unregistered-probe.ts",
    "packages/daemon/src/doc-sync-unregistered-probe.ts",
  ]) {
    const inlinePolicy = scanOntologyText(target, "export const DEFAULT_EVENT_LIST_LIMIT = 50;\n");
    assert.equal(inlinePolicy.length, 1, target);
    assert.deepEqual(
      audit(inlinePolicy, { snapshot }).findings.map((row) => row.code),
      ["ONTOLOGY_POLICY_UNDECLARED"],
      target,
    );
    assert.deepEqual(
      audit(inlinePolicy, { snapshot, baseline: [debt(inlinePolicy[0])], previous: [] }).findings.map(
        (row) => row.code,
      ),
      ["ONTOLOGY_BASELINE_GROWTH"],
      target,
    );

    const undeclaredEffect = scanOntologyText(
      target,
      "import { rmSync } from 'node:fs'; export function clean(p: string) { rmSync(p); }\n",
    );
    assert.equal(undeclaredEffect.filter((row) => row.category === "action").length, 1, target);
    assert.deepEqual(
      audit(undeclaredEffect, { snapshot }).findings.map((row) => row.code),
      ["ONTOLOGY_ACTION_UNDECLARED"],
      target,
    );
  }

  const storagePolicyFile = "packages/kernel/src/domain/storage-read-policy.ts";
  const storagePolicyText = readFileSync(path.join(repoRoot, storagePolicyFile), "utf8");
  const crlfStoragePolicy = scanOntologyText(storagePolicyFile, storagePolicyText.replace(/\r?\n/gu, "\r\n"));
  assert.deepEqual(audit(crlfStoragePolicy, { snapshot }).findings, []);

  const mutatedStoragePolicy = scanOntologyText(
    storagePolicyFile,
    storagePolicyText.replace("artifacts: { defaultLimit: 100 }", "artifacts: { defaultLimit: 101 }"),
  );
  assert.ok(
    audit(mutatedStoragePolicy, { snapshot }).findings.some((row) => row.code === "ONTOLOGY_POLICY_UNDECLARED"),
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the final daemon runtime slice is a closed
// world boundary. Removing its frozen rows is safe only while every live source is
// bound to the shared ActionDeclaration or EntityKindContract Policy registry.
test("dec_7E44897ECDCAEF2B92EC66A260/CH1: daemon runtime/terminal/evaluation closure is ratcheted", () => {
  const scopePath = /^packages\/daemon\/src\/(?:runtime|agent-runtime-instance|terminal-|process-port|skill-eval-)/u;
  const baseline = loadGateAllowlist("ontology-closure", {
    allowlistRoot: path.join(repoRoot, "tools/gate-allowlists"),
    report: false,
  }).candidates;
  assert.deepEqual(
    baseline.filter((row) => row.owner === "packages/daemon" && scopePath.test(row.path)),
    [],
    "daemon runtime, terminal and evaluation paths must have no migration baseline rows",
  );

  const result = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" });
  const inScope = result.classified.filter((row) => scopePath.test(row.file));
  assert.ok(inScope.length >= 360, `expected the daemon runtime slice, got ${inScope.length} rows`);
  assert.deepEqual(
    inScope.filter((row) => row.status !== "registered"),
    [],
  );
  assert.deepEqual(
    inScope.filter((row) => row.category === "action" && row.declarationRef === "action:cli-local-effects"),
    [],
    "daemon runtime actions must never bind to cli-local-effects",
  );

  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  const undeclaredAction = scanOntologyText(
    "packages/daemon/src/runtime-ontology-mutation.ts",
    "export function unregisteredRuntimeAction() { dispatch(); }\n",
  );
  assert.deepEqual(
    audit(undeclaredAction, { snapshot }).findings.map((row) => row.code),
    ["ONTOLOGY_ACTION_UNDECLARED"],
  );
  const undeclaredPolicy = scanOntologyText(
    "packages/daemon/src/runtime-ontology-mutation.ts",
    "export const UNREGISTERED_RUNTIME_TIMEOUT_MS = 123;\n",
  );
  assert.deepEqual(
    audit(undeclaredPolicy, { snapshot }).findings.map((row) => row.code),
    ["ONTOLOGY_POLICY_UNDECLARED"],
  );
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1 review F1: operating defaults belong to the
// shared Policy declaration, and consumers must derive them instead of retaining leaves.
test("daemon runtime Policy owns concrete defaults and consumers have no leaf budgets", async () => {
  const { daemonRuntimePolicy } = await import("../../../packages/kernel/src/domain/cli-operational-policy.ts");
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  assert.deepEqual(daemonRuntimePolicy.defaultValue, {
    batch: { defaultConcurrency: 2, maximumConcurrency: 32 },
    process: {
      providerErrorLimit: 64 * 1024,
      resumeAdmissionTimeoutMs: 30_000,
      exitNotificationTimeoutMs: 30_000,
      processTableTimeoutMs: 10_000,
      exitPollMs: 25,
      terminationGraceMs: 500,
      streamPollMs: 250,
      firstRecordPollMs: 10,
      groupSweepAttempts: 80,
      groupKillAttempt: 40,
      lockHolderProbeTimeoutMs: 8_000,
      authFileRemovalRetries: 5,
      authFileRemovalRetryDelayMs: 20,
    },
    acp: { cancelGraceMs: 2_000 },
    daemon: { shutdownDeadlineMs: 30_000, drainRecheckMs: 1_000, fleetDrainDeadlineMs: 30 * 60_000 },
    evidence: {
      snapshotLimitBytes: 4 * 1024 * 1024,
      promptLimitBytes: 128 * 1024,
      traceLimitBytes: 512 * 1024,
      correlationValueLimit: 256,
      providerTranscriptLimitBytes: 16 * 1024 * 1024,
      maximumCompressedFrames: 4096,
      correlationIdsLimit: 64,
    },
    health: { cooldownBaseSeconds: 30, cooldownMaxSeconds: 300, freezeAfter: 5, freezeDurationSeconds: 1_800 },
    runtime: {
      subscriptionProbeTimeoutMs: { status: 5_000, standard: 10_000, extended: 15_000, modelListing: 60_000 },
      unsettledTurnMaxContinuations: 3,
      nativePrintTimeout: "120m",
      recoveryStuckAfterMs: 2 * 60_000,
      workspaceActivityIntervalMs: 1_000,
      handoffLifetimeMs: 86_400_000,
      localContextWindow: { nCtx: 40_960, outputReserve: 4_096 },
      modelSlots: {
        globalCapacity: 64,
        perOwnerCapacity: 64,
        defaultCapacity: 1,
        maximumCapacity: 64,
        defaultWaitMs: 30 * 60 * 1000,
        maximumWaitMs: 24 * 3600 * 1000,
      },
      currentWorktreeHeadTimeoutMs: 5_000,
      githubCredentialProbeTimeoutMs: 10_000,
      handoffGitTimeoutMs: 30_000,
      taskPublicationTimeoutMs: 30_000,
      workerPushTimeoutMs: 60_000,
      workerPushDetailLimit: 512,
      workerHistoryLimitBytes: 1 << 20,
      windowsProcessGroupTimeoutMs: 15_000,
      continuationConclusionLimit: 8_192,
      outcomeRecheckMs: 5_000,
      cloudDispatchRelay: {
        maxBodyBytes: 2 * 1024 * 1024,
        maxResponseBytes: 8 * 1024 * 1024,
        outputCapTokens: 32_768,
        requestOverheadTokens: 20_000,
        codeReserveMicros: 2_000_000,
        defaultMaxGenerations: 16,
        maximumGenerations: 10_000,
        upstreamTimeoutMs: 600_000,
        requestTimeoutMs: 125_000,
        headersTimeoutMs: 10_000,
        defaultMaxUpstreamConcurrency: 2,
      },
    },
    terminal: {
      defaultCols: 80,
      defaultRows: 24,
      minimumDimension: 2,
      maximumDimension: 500,
      frameOverheadBytes: 96,
      loginShellSnapshotTimeoutMs: 4_000,
      scrollbackLimit: 1024 * 1024,
      replayLimit: 256 * 1024,
      subscriberLimit: 256 * 1024,
      ptyExitDrainMs: 5_000,
      activityPersistIntervalMs: 10_000,
    },
    skillEvaluation: {
      maxBodyLength: 100_000,
      maxNameLength: 200,
      maxUsageMarkerLength: 1_000,
      maxRequiredTextCount: 100,
      maxRequiredTextLength: 1_000,
      maximumObservePolls: 1_000,
      diagnosticLimit: 200,
      defaultThreshold: 1,
      maxCases: 20,
      maxCaseIdLength: 64,
      maxInputLength: 20_000,
      modelSlots: 2,
    },
  });

  const consumers = [
    [
      "packages/daemon/src/runtime-inventory.ts",
      [
        "daemonRuntimePolicy.defaultValue.runtime.subscriptionProbeTimeoutMs",
        "daemonRuntimePolicy.defaultValue.runtime.unsettledTurnMaxContinuations",
      ],
    ],
    ["packages/daemon/src/runtime.ts", ["daemonRuntimePolicy.defaultValue.daemon"]],
    ["packages/daemon/src/runtime-dispatch-evidence.ts", ["daemonRuntimePolicy.defaultValue.evidence"]],
    ["packages/daemon/src/runtime-spawn-deepseek-session.ts", ["daemonRuntimePolicy.defaultValue.evidence"]],
    ["packages/daemon/src/runtime-worker-control.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    ["packages/daemon/src/runtime-spawn-provider-stream.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    ["packages/daemon/src/runtime/process-group-reconciler.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    ["packages/daemon/src/runtime/model-slot-queue.ts", ["daemonRuntimePolicy.defaultValue.runtime.modelSlots"]],
    ["packages/daemon/src/agent-runtime-instance-storage.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    [
      "packages/daemon/src/runtime-orchestration.ts",
      [
        "daemonRuntimePolicy.defaultValue.batch.defaultConcurrency",
        "daemonRuntimePolicy.defaultValue.batch.maximumConcurrency",
      ],
    ],
    ["packages/daemon/src/runtime-spawn-process.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    ["packages/daemon/src/runtime-spawner.ts", ["daemonRuntimePolicy.defaultValue.process"]],
    ["packages/daemon/src/runtime-worker-acp.ts", ["daemonRuntimePolicy.defaultValue.acp.cancelGraceMs"]],
    ["packages/daemon/src/runtime-provider-health.ts", ["daemonRuntimePolicy.defaultValue.health"]],
    ["packages/daemon/src/runtime-continuation-context.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    ["packages/daemon/src/runtime-github-credentials.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    ["packages/daemon/src/runtime-handoff-native.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    ["packages/daemon/src/runtime-task-publication.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    ["packages/daemon/src/runtime-worker-push.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    ["packages/daemon/src/runtime-settlement.ts", ["daemonRuntimePolicy.defaultValue.runtime.outcomeRecheckMs"]],
    [
      "packages/daemon/src/runtime/cloud-dispatch-relay.ts",
      ["daemonRuntimePolicy.defaultValue.runtime.cloudDispatchRelay"],
    ],
    ["packages/daemon/src/runtime/windows-process-group-port.ts", ["daemonRuntimePolicy.defaultValue.runtime"]],
    [
      "packages/daemon/src/terminal-environment.ts",
      ["daemonRuntimePolicy.defaultValue.terminal.loginShellSnapshotTimeoutMs"],
    ],
    ["packages/daemon/src/terminal-host.ts", ["daemonRuntimePolicy.defaultValue.terminal"]],
    ["packages/daemon/src/skill-eval-runner.ts", ["daemonRuntimePolicy.defaultValue.skillEvaluation"]],
    ["packages/daemon/src/skill-eval-production.ts", ["daemonRuntimePolicy.defaultValue.skillEvaluation"]],
  ];
  for (const [target, references] of consumers) {
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    for (const reference of references)
      assert.match(source, new RegExp(reference.replaceAll(".", "\\.")), `${target} must read ${reference}`);
  }
  const spawnLimits = readFileSync(path.join(repoRoot, "packages/daemon/src/runtime-spawn-limits.ts"), "utf8");
  assert.match(spawnLimits, /daemonRuntimePolicy\.defaultValue\.process/u);
  assert.doesNotMatch(spawnLimits, /(?:64 \* 1024|30_000)/u, "the compatibility exports must not own defaults");
  const cloudRelay = readFileSync(path.join(repoRoot, "packages/daemon/src/runtime/cloud-dispatch-relay.ts"), "utf8");
  assert.doesNotMatch(cloudRelay, /(?:600_000|125_000|10_000|\?\? 2|> 10_000)/u, "the relay must not own budgets");
  const daemonTarget = "packages/daemon/src/runtime-orchestration.ts",
    daemonSource = readFileSync(path.join(repoRoot, daemonTarget), "utf8"),
    restoredLeaf = daemonSource.replace("daemonRuntimePolicy.defaultValue.batch.defaultConcurrency", "2");
  assert.notEqual(restoredLeaf, daemonSource);
  assert.ok(
    audit(scanOntologyText(daemonTarget, restoredLeaf), { snapshot }).findings.some(
      (row) => row.code === "ONTOLOGY_POLICY_UNDECLARED",
    ),
    "restoring a former leaf default must not reuse a stale source registration",
  );
  const policyTarget = "packages/kernel/src/domain/cli-operational-policy.ts",
    policySource = readFileSync(path.join(repoRoot, policyTarget), "utf8"),
    changedDefault = policySource.replace("resumeAdmissionTimeoutMs: 30_000", "resumeAdmissionTimeoutMs: 31_000");
  assert.notEqual(changedDefault, policySource);
  assert.ok(
    audit(scanOntologyText(policyTarget, changedDefault), { snapshot }).findings.some(
      (row) => row.code === "ONTOLOGY_POLICY_UNDECLARED",
    ),
    "a changed shared runtime default must fail closed",
  );
});
