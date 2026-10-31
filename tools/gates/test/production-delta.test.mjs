// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeProductionDelta, evaluateProductionDelta, main, reportComputedDelta } from "../production-delta.mjs";
import { git } from "../git.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

test("G33 computes production addition and deletion without a body declaration", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n" });
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\nthree\nfour\n");
  const result = evaluateProductionDelta({ rootDir, base });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual({ added: result.computed.added, deleted: result.computed.deleted }, { added: 2, deleted: 1 });
});

test("G33 measures additions and deletions in tool source", () => {
  const { rootDir, base } = makeRepo({ "tools/gates/example.mjs": "one\ntwo\n" });
  writeRepoFile(rootDir, "tools/gates/example.mjs", "one\nthree\nfour\n");
  const result = computeProductionDelta({ rootDir, base });
  assert.deepEqual({ added: result.added, deleted: result.deleted }, { added: 2, deleted: 1 });
  assert.deepEqual(result.changed, [
    {
      filePath: "tools/gates/example.mjs",
      module: "tooling",
      added: 2,
      deleted: 1,
    },
  ]);
});

test("G33 classifies replaceable authorization packages into governed production modules", () => {
  const { rootDir, base } = makeRepo({
    "packages/authorization-keycloak/src/provider.ts": "old\n",
    "packages/authorization-gui/src/contract.ts": "old\n",
    "packages/authorization-keycloak-gui/src/access-control.tsx": "old\n",
  });
  writeRepoFile(rootDir, "packages/authorization-keycloak/src/provider.ts", "new\n");
  writeRepoFile(rootDir, "packages/authorization-gui/src/contract.ts", "new\n");
  writeRepoFile(rootDir, "packages/authorization-keycloak-gui/src/access-control.tsx", "new\n");
  const result = computeProductionDelta({ rootDir, base });
  assert.deepEqual(result.unclassified, []);
  assert.deepEqual(
    result.changed.map(({ filePath, module }) => ({ filePath, module })),
    [
      { filePath: "packages/authorization-gui/src/contract.ts", module: "gui" },
      { filePath: "packages/authorization-keycloak-gui/src/access-control.tsx", module: "gui" },
      { filePath: "packages/authorization-keycloak/src/provider.ts", module: "identity-rbac" },
    ],
  );
});

test("G33 keeps an unregistered authorization implementation package unclassified", () => {
  const { rootDir, base } = makeRepo({
    "packages/authorization-custom/src/provider.ts": "old\n",
  });
  writeRepoFile(rootDir, "packages/authorization-custom/src/provider.ts", "new\n");
  const result = computeProductionDelta({ rootDir, base });
  assert.deepEqual(result.unclassified, ["packages/authorization-custom/src/provider.ts"]);
});

test("G33 ignores tool tests and fixtures in both delta directions", () => {
  const files = {
    "tools/gates/example.test.mjs": "old test\n",
    "tools/gates/test/example.mjs": "old helper\n",
    "tools/gates/fixtures/example.mjs": "old fixture\n",
  };
  const { rootDir, base } = makeRepo(files);
  for (const filePath of Object.keys(files)) writeRepoFile(rootDir, filePath, "new first\nnew second\n");
  const result = computeProductionDelta({ rootDir, base });
  assert.deepEqual({ added: result.added, deleted: result.deleted }, { added: 0, deleted: 0 });
  assert.deepEqual(result.changed, []);
});

test("G33 reports computed delta, churn, net, and unclassified count", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  const summaryPath = path.join(rootDir, "summary.md");
  const messages = [];
  const originalLog = console.log;
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  console.log = (message) => messages.push(message);
  try {
    assert.deepEqual(reportComputedDelta({ added: 7, deleted: 2, unclassified: [] }), { churn: 9, net: 5 });
  } finally {
    console.log = originalLog;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  }
  assert.deepEqual(messages, ["Production delta (computed): +7/-2; churn 9; net +5; unclassified 0"]);
  assert.equal(readFileSync(summaryPath, "utf8"), `${messages[0]}\n`);
});

test("G33 measures the branch from its merge-base, so the target advancing does not move the number", () => {
  const { rootDir: repo, base } = makeRepo({ "packages/kernel/src/a.ts": "export const a = 1;\n" }),
    target = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeRepoFile(repo, "packages/kernel/src/b.ts", "export const b = 1;\nexport const c = 2;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feature"]);
  const before = computeProductionDelta({ rootDir: repo, base });
  git(repo, ["checkout", "-q", target]);
  writeRepoFile(repo, "packages/kernel/src/z.ts", "export const z = 1;\nexport const y = 2;\nexport const x = 3;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main moves on"]);
  const mainTip = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-q", "feature"]);
  const after = computeProductionDelta({ rootDir: repo, base: mainTip });
  const featureTip = git(repo, ["rev-parse", "HEAD"]).trim(),
    explicitHead = computeProductionDelta({ rootDir: repo, base: mainTip, head: featureTip });
  assert.deepEqual([after.added, after.deleted], [before.added, before.deleted]);
  assert.deepEqual([after.added, after.deleted], [2, 0]);
  assert.deepEqual(explicitHead, after);
});

test("G33 JSON output names the resolved base and explicit delivery commit", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/a.ts": "export const a = 1;\n" });
  writeRepoFile(rootDir, "packages/kernel/src/b.ts", "export const b = 1;\nexport const c = 2;\n");
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["commit", "-q", "-m", "delivery"]);
  const head = git(rootDir, ["rev-parse", "HEAD"]).trim(),
    messages = [],
    originalLog = console.log,
    originalGateResults = process.env.HARNESS_CI_GATE_RESULTS;
  process.env.HARNESS_CI_GATE_RESULTS = path.join(rootDir, "gate-results.json");
  console.log = (message) => messages.push(message);
  try {
    assert.equal(main(["--base", base, "--head", head, "--root", rootDir, "--json"]), 0);
  } finally {
    console.log = originalLog;
    if (originalGateResults === undefined) delete process.env.HARNESS_CI_GATE_RESULTS;
    else process.env.HARNESS_CI_GATE_RESULTS = originalGateResults;
  }
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), {
    base: git(rootDir, ["rev-parse", "HEAD^1"]).trim(),
    head,
    ok: true,
    added: 2,
    deleted: 0,
    churn: 2,
    net: 2,
    changed: [{ filePath: "packages/kernel/src/b.ts", module: "kernel", added: 2, deleted: 0 }],
    unclassified: [],
    errors: [],
  });
});

test("G33 rejects --head without a ref", () => {
  const { rootDir, base } = makeRepo({ "README.md": "fixture\n" }),
    messages = [],
    errors = [],
    originalLog = console.log,
    originalError = console.error;
  console.log = (message) => messages.push(message);
  console.error = (message) => errors.push(message);
  try {
    assert.equal(main(["--base", base, "--head", "--json"], rootDir), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(messages, []);
  assert.match(errors.join("\n"), /--head requires a ref/u);
});
