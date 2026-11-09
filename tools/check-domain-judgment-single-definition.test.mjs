// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkDispatchLifecycleObservationSites,
  checkDomainJudgmentSingleDefinition,
  scanDispatchLifecycleObservationSites,
} from "./check-domain-judgment-single-definition.mjs";
import { checkAuthoredReadinessSites, scanAuthoredReadinessSites } from "./domain-judgment-authored-readiness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// The gate enumerates through git; a directory inside the real repository would
// resolve to the outer repo's tree, so the checked-in fixture runs from a copy
// that is its own repository.
function fixtureFindings(t) {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-domain-judgment-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "tools/fixtures/domain-judgment-single-definition"), fixture, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: fixture });
  return checkDomainJudgmentSingleDefinition(fixture);
}

test("domain judgment single-definition gate accepts the repository", () => {
  // The shrink-only comparison against the pull request base is covered by the ratchet unit test
  // below; here the checkout is its own base, so the run needs no fetched origin/main.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-domain-judgment-single-definition.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PR_BASE_SHA: head },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /twelve judgments resolve to kernel domain services; authored-document reads use the projection port; dispatch observation ratchet is active/u,
  );
});

test("positive fixture: a renderer readiness definition is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) => finding.includes("closeoutReadiness") && finding.includes("packages/gui/src/duplicate-readiness.ts"),
    ),
    findings.join("\n"),
  );
});

test("positive fixture: startability, query validation, and status vocabulary copies are refused", (t) => {
  const findings = fixtureFindings(t);
  for (const [judgment, file] of [
    ["startability", "packages/daemon/src/duplicate-judgments.ts"],
    ["queryPayloadValidation", "packages/daemon/src/duplicate-judgments.ts"],
    ["statusVocabulary", "packages/daemon/src/duplicate-judgments.ts"],
  ])
    assert.ok(
      findings.some((finding) => finding.includes(judgment) && finding.includes(file)),
      findings.join("\n"),
    );
});

test("positive fixture: daemon start preview and CLI cancellation eligibility copies are refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some((finding) => finding.includes("second Task startability preview")),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) => finding.includes("cancellation eligibility")),
    findings.join("\n"),
  );
});

// The bilingual closeout judgment is the writing boundary `ha task submit` and the PR body
// renderer share. A second implementation on either side — including a tool-side renderer copy —
// must fail this gate, which is what makes "same exported function" enforced rather than trusted.
test("positive fixture: a second bilingual closeout judgment in daemon or renderer is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("closeoutBilingualDelivery") && finding.includes("packages/daemon/src/duplicate-judgments.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("closeoutBilingualDelivery") &&
        finding.includes("tools/gates/duplicate-closeout-judgment.mjs"),
    ),
    findings.join("\n"),
  );
});

// dec_6B912A63D279A922FA1288536D CH2: authored-document readiness is judged once, by the kernel,
// over the body the canonical read port supplies. Each control runs the real gate function.
test("positive fixture: a daemon reading task_plan and deciding readiness itself is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/rogue-plan-readiness.ts#rogueTaskPlanReadiness") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("positive fixture: a local plan read handed to the kernel judgment is still refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/edge-plan-readiness.ts#edgePlanReadiness") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("negative fixture: the kernel judgment over a projection body passes", (t) => {
  const findings = fixtureFindings(t);
  assert.deepEqual(
    findings.filter((finding) => finding.includes("canonical-plan-readiness.ts")),
    [],
  );
});

test("positive fixture: a second authored-document readiness definition is refused", (t) => {
  const findings = fixtureFindings(t);
  for (const judgment of ["authoredDocumentReadiness", "transitionDocumentReadiness"]) {
    const symbol =
      judgment === "authoredDocumentReadiness" ? "assessAuthoredDocumentReadiness" : "assessTransitionDocument";
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes(`${judgment}: expected one definition of ${symbol}`) &&
          finding.includes("packages/daemon/src/duplicate-judgments.ts"),
      ),
      findings.join("\n"),
    );
  }
});

test("positive fixture: direct authored reads are refused regardless of verdict shape", (t) => {
  const findings = fixtureFindings(t);
  for (const symbol of [
    "documentReadiness",
    "scaffoldState",
    "evaluate",
    "ordinaryBoolean",
    "aliasedVerdict",
    "promiseBoolean",
    "namespaceBoolean",
    "listedFileRead",
  ])
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes(`packages/daemon/src/custom-word-readiness.ts#${symbol}`) &&
          finding.includes("direct-authored-document-read"),
      ),
      findings.join("\n"),
    );
});

test("positive fixture: an authored task artifact read through a workspace wrapper is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/wrapped-authored-read.ts#readPacketThroughHelper") &&
        finding.includes("wrapped-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

test("a direct authored read is reported without a readiness heuristic", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authored-readiness-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  const file = path.join(root, "packages/daemon/src/access.ts"),
    write = (extra) =>
      writeFileSync(
        file,
        [
          'import { readFileSync } from "node:fs";',
          'import path from "node:path";',
          'import { assertTransitionDocumentReady } from "@harness-anything/kernel";',
          "export function assertPlanReady(authoredRoot: string, contract: unknown): void {",
          '  const body = readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");',
          extra,
          '  assertTransitionDocumentReady("task.plan", body, contract as never);',
          "}",
          "",
        ].join("\n"),
      );
  write('  const planReady = body.includes("## Goal");');
  const findings = checkAuthoredReadinessSites(scanAuthoredReadinessSites(root));
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/access.ts#assertPlanReady") &&
        finding.includes("direct-authored-document-read"),
    ),
    findings.join("\n"),
  );
});

// dec_BEFCF7D0484E901F187C2C8EC6: whether a fixed finding needs a re-review is judged only by the
// kernel reverify route. A daemon copy — a second route or a raw `reverify` comparison — is refused.
test("positive fixture: a daemon copy of the review reverify judgment is refused", (t) => {
  const findings = fixtureFindings(t);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("reviewReverifyRoute: expected one definition") &&
        finding.includes("packages/daemon/src/duplicate-reverify.ts"),
    ),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) =>
      finding.startsWith("packages/daemon/src/duplicate-reverify.ts: judges a finding's reverify outside the kernel"),
    ),
    findings.join("\n"),
  );
});

test("dispatch observation ratchet rejects admission and terminal judgments but accepts observations", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-dispatch-observation-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(repoRoot, "tools/fixtures/dispatch-lifecycle-observation"), fixture, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: fixture });
  const sites = scanDispatchLifecycleObservationSites(fixture),
    findings = checkDispatchLifecycleObservationSites(sites, {
      schema: "harness-anything/gate-allowlist/v1",
      entries: { observationSites: [] },
    });
  assert.deepEqual(sites.map(({ symbol, kind }) => `${symbol}:${kind}`).sort(), [
    "admissionFromPid:runtimePidIsAlive",
    "capacityFromLocalTables:fallback-state-branch",
    "capacityFromLocalTables:liveness-comparison",
    "capacityFromLocalTables:process-table-probe",
    "terminalFromProcessLost:process-lost-terminal-return",
  ]);
  // observeProcess reads the same PID fact but only submits a process_observed event: no finding.
  assert.ok(!sites.some(({ symbol }) => symbol === "observeProcess"));
  assert.equal(findings.length, 5);
  assert.ok(findings.every((finding) => finding.includes("new ")));
});

test("dispatch observation baseline rejects additions and permits reductions", () => {
  const entry = {
      path: "packages/daemon/src/legacy.ts",
      symbol: "admission",
      kind: "runtimePidIsAlive",
      fingerprint: "fingerprint-a",
    },
    current = { schema: "harness-anything/gate-allowlist/v1", entries: { observationSites: [] } },
    prior = [entry],
    reduced = checkDispatchLifecycleObservationSites([], current, prior),
    expanded = checkDispatchLifecycleObservationSites(
      [entry],
      { ...current, entries: { observationSites: [entry] } },
      [],
    ),
    stale = checkDispatchLifecycleObservationSites([], { ...current, entries: { observationSites: [entry] } });
  assert.deepEqual(reduced, []);
  assert.ok(expanded.some((finding) => finding.includes("baseline may only shrink")));
  assert.ok(stale.some((finding) => finding.includes("stale baseline entry should be removed")));
});
