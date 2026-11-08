// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkDomainJudgmentSingleDefinition } from "./check-domain-judgment-single-definition.mjs";
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
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-domain-judgment-single-definition.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /nine judgments resolve to kernel domain services; authored-document readiness ratchet holds/u,
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
        finding.includes("local-readiness-derivation"),
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
        finding.includes("local-read-kernel-readiness"),
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
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("authoredDocumentReadiness") && finding.includes("packages/daemon/src/duplicate-judgments.ts"),
    ),
    findings.join("\n"),
  );
});

test("authored readiness baseline only shrinks and drops migrated sites", () => {
  const site = {
      path: "packages/daemon/src/legacy.ts",
      symbol: "taskContext",
      kind: "local-read-kernel-readiness",
      fingerprint: "a",
    },
    edited = { ...site, fingerprint: "b" },
    baseline = (entries) => ({ schema: "authored-document-readiness-baseline/v1", entries });
  assert.deepEqual(checkAuthoredReadinessSites([], baseline([]), [site]), []);
  assert.deepEqual(checkAuthoredReadinessSites([edited], baseline([edited]), [site]), []);
  assert.ok(
    checkAuthoredReadinessSites([site, edited], baseline([site, edited]), [site]).some((finding) =>
      finding.includes("baseline may only shrink"),
    ),
  );
  assert.ok(
    checkAuthoredReadinessSites([], baseline([site]), [site]).some((finding) =>
      finding.includes("stale baseline entry should be removed"),
    ),
  );
  assert.ok(
    checkAuthoredReadinessSites([site], { entries: [site] }).some((finding) => finding.includes("invalid or missing")),
  );
});

test("positive fixture: readiness derived with custom words or without a ready literal is refused", (t) => {
  const findings = fixtureFindings(t);
  for (const symbol of ["documentReadiness", "scaffoldState", "evaluate"])
    assert.ok(
      findings.some(
        (finding) =>
          finding.includes(`packages/daemon/src/custom-word-readiness.ts#${symbol}`) &&
          finding.includes("local-readiness-derivation"),
      ),
      findings.join("\n"),
    );
});

// Review F2: a grandfathered kernel-read scope must not hide a local judgment added beside it.
test("a local judgment added to a grandfathered kernel-read scope is a new site", (t) => {
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
          'import { assertTransitionDocumentReady } from "@harness-anything/kernel";',
          "export function assertPlanReady(planPath: string, contract: unknown): void {",
          '  const body = readFileSync(planPath, "utf8");',
          extra,
          '  assertTransitionDocumentReady("task.plan", body, contract as never);',
          "}",
          "",
        ].join("\n"),
      );
  write("");
  const baseline = {
    schema: "authored-document-readiness-baseline/v1",
    entries: scanAuthoredReadinessSites(root),
  };
  assert.deepEqual(
    baseline.entries.map(({ kind }) => kind),
    ["local-read-kernel-readiness"],
  );
  assert.deepEqual(checkAuthoredReadinessSites(scanAuthoredReadinessSites(root), baseline), []);
  write('  const planReady = body.includes("## Goal");');
  const findings = checkAuthoredReadinessSites(scanAuthoredReadinessSites(root), baseline);
  assert.ok(
    findings.some(
      (finding) =>
        finding.includes("packages/daemon/src/access.ts#assertPlanReady") &&
        finding.includes("new local-readiness-derivation"),
    ),
    findings.join("\n"),
  );
});
