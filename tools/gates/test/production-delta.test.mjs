// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  computeProductionDelta,
  evaluateProductionDelta,
  parseRetainedPaths,
  reportComputedDelta,
} from "../production-delta.mjs";
import { git } from "../git.mjs";
import { signReceipt } from "../receipt-verify.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

test("G33 computes production addition and deletion without a body declaration", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\ntwo\n" });
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\nthree\nfour\n");
  const result = evaluateProductionDelta({ rootDir, base, prBody: "" });
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

test("G33 ignores the retired Production-Delta body field", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/index.ts": "one\n" });
  writeRepoFile(rootDir, "packages/kernel/src/index.ts", "one\ntwo\n");
  const absent = evaluateProductionDelta({ rootDir, base, prBody: "" });
  const retired = evaluateProductionDelta({ rootDir, base, prBody: "Production-Delta: +0/-0" });
  assert.equal(absent.ok, true, absent.errors.join("\n"));
  assert.equal(retired.ok, true, retired.errors.join("\n"));
  assert.deepEqual(retired.computed, absent.computed);
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

test("G33 does not read a Retained-Path value from the next line", () => {
  const result = parseRetainedPaths(
    ["Retained-Path:", "packages/kernel/src/legacy.ts until 2099-12-30 per dec_01KZQ92VEPTDRS2HS8CKDBKW2Q"].join("\n"),
  );

  assert.deepEqual(result.declarations, []);
  assert.match(result.errors.join("\n"), /each Retained-Path line must use/u);
});

test("G33 verifies retained production paths against an expiring decision receipt", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/legacy.ts": "legacy\n" });
  const unsigned = {
    decisionId: "dec_01KZQ92VEPTDRS2HS8CKDBKW2Q",
    scope: "retained-path:packages/kernel/src/legacy.ts",
    kind: "retained-path",
    limit: "2099-12-30",
    expiry: "2099-12-31T23:59:59Z",
  };
  writeRepoFile(
    rootDir,
    "tools/gates/receipts/retained.json",
    `${JSON.stringify({ ...unsigned, signature: signReceipt(unsigned) }, null, 2)}\n`,
  );
  const prBody = "Retained-Path: packages/kernel/src/legacy.ts until 2099-12-30 per dec_01KZQ92VEPTDRS2HS8CKDBKW2Q";
  const result = evaluateProductionDelta({
    rootDir,
    base,
    prBody,
    receiptsDir: path.join(rootDir, "tools/gates/receipts"),
    now: new Date("2026-08-11T00:00:00Z"),
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("G33 still rejects a retained production path without a valid receipt", () => {
  const { rootDir, base } = makeRepo({ "packages/kernel/src/legacy.ts": "legacy\n" });
  const result = evaluateProductionDelta({
    rootDir,
    base,
    prBody: "Retained-Path: packages/kernel/src/legacy.ts until 2099-12-30 per dec_MISSING",
    now: new Date("2026-08-11T00:00:00Z"),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /lacks a valid receipt/u);
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
  assert.deepEqual([after.added, after.deleted], [before.added, before.deleted]);
  assert.deepEqual([after.added, after.deleted], [2, 0]);
});
