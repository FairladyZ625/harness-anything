// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeRepo, runGit } from "./gates/test/helpers.mjs";
import { MODULES } from "./gates/module-policy.mjs";
import { resolveLocalLineBudgetBase } from "./run-local-line-budget.mjs";

const runnerPath = fileURLToPath(new URL("./run-local-line-budget.mjs", import.meta.url));
const canonicalUrl = "https://github.com/FairladyZ625/harness-anything.git";

function budgetBody(kernel) {
  return `${JSON.stringify({
    version: 1,
    ceilings: Object.fromEntries(MODULES.map((moduleName) => [moduleName, moduleName === "kernel" ? kernel : 0]))
  }, null, 2)}\n`;
}

function addCanonicalRemote(rootDir) {
  const remoteRoot = mkdtempSync(path.join(tmpdir(), "local-line-budget-remote-"));
  const bareRoot = path.join(remoteRoot, "canonical.git");
  runGit(remoteRoot, ["init", "--bare", "--quiet", bareRoot]);
  runGit(rootDir, ["config", `url.${pathToFileURL(bareRoot).href}.insteadOf`, canonicalUrl]);
  runGit(rootDir, ["remote", "add", "origin", canonicalUrl]);
  runGit(rootDir, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  runGit(rootDir, ["update-ref", "-d", "refs/remotes/origin/main"]);
  return remoteRoot;
}

test("local line-budget refuses a repository without the canonical remote and gives the next action", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  try {
    const result = spawnSync(process.execPath, [runnerPath], { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs network access to fetch canonical main/u);
    assert.match(result.stderr, /no configured remote points to github\.com\/FairladyZ625\/harness-anything/u);
    assert.match(result.stderr, /git remote add upstream https:\/\/github\.com\/FairladyZ625\/harness-anything\.git/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// G32 itself is suspended under dec_3879E19D9D1D76BAD538E77C1F
// (task_2c909af2cae0b23abd1e34a2e2) while the remaining compressed production
// files are bulk-restored, so this runner still resolves and reports the base but
// the gate behind it short-circuits. The two assertions this test carried about
// G32's own output are preserved verbatim and must be restored when the
// suspension is lifted:
//
//   assert.match(result.stdout, /kernel: 1\/1/u);
//   assert.match(result.stdout, /G32 line-budget-ratchet: pass/u);
//
// Until then this asserts the suspension, so it is self-retiring: the moment
// SUSPENDED flips back to false the notice stops being printed, this test goes
// red, and whoever re-enables the gate is forced to restore the two lines above.
// The base-resolution assertion is unaffected by the suspension and stays live.
test("local line-budget fetches canonical main and reports that exact base while G32 is suspended", () => {
  const { rootDir, base } = makeRepo({
    "packages/kernel/src/index.ts": "one\n",
    "tools/gates/line-budgets.json": budgetBody(1)
  });
  const remoteRoot = addCanonicalRemote(rootDir);
  try {
    const result = spawnSync(process.execPath, [runnerPath], { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Local line-budget base: origin/main ${base}`, "u"));
    assert.match(result.stdout, /G32 line-budget-ratchet: suspended under dec_3879E19D9D1D76BAD538E77C1F/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test("local line-budget explains a canonical-main fetch failure and gives the next action", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  try {
    const missingRemote = pathToFileURL(path.join(rootDir, "missing-canonical.git")).href;
    runGit(rootDir, ["config", `url.${missingRemote}.insteadOf`, canonicalUrl]);
    runGit(rootDir, ["remote", "add", "origin", canonicalUrl]);
    const result = spawnSync(process.execPath, [runnerPath], { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs network access to fetch canonical main/u);
    assert.match(result.stderr, /fetching canonical main from remote "origin" failed/u);
    assert.match(result.stderr, /check network access and Git credentials/u);
    assert.match(result.stderr, /git fetch origin main/u);
    assert.match(result.stderr, /Git reported:/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local line-budget bounds canonical-main fetch latency and explains a timeout", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  const remoteRoot = addCanonicalRemote(rootDir);
  try {
    assert.throws(
      () => resolveLocalLineBudgetBase(rootDir, 1),
      (error) => {
        assert.match(error.message, /needs network access to fetch canonical main/u);
        assert.match(error.message, /fetching canonical main from remote "origin" timed out after 1ms/u);
        assert.match(error.message, /check network access/u);
        assert.match(error.message, /git fetch origin main/u);
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test("local line-budget rejects a branch behind canonical main and tells the worker to rebase", () => {
  const { rootDir, base } = makeRepo({
    "packages/kernel/src/index.ts": "one\n",
    "tools/gates/line-budgets.json": budgetBody(1)
  });
  const remoteRoot = addCanonicalRemote(rootDir);
  try {
    const advancedMain = runGit(rootDir, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", "advance canonical main"]);
    runGit(rootDir, ["push", "--quiet", "origin", `${advancedMain}:refs/heads/main`]);

    const result = spawnSync(process.execPath, [runnerPath], { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs network access to fetch canonical main/u);
    assert.match(result.stderr, /HEAD is not a descendant of the latest canonical main/u);
    assert.ok(result.stderr.includes("first rebase onto latest main"));
    assert.ok(result.stderr.includes("git rebase origin/main"));
    assert.ok(result.stderr.includes("then re-run"));
    assert.ok(result.stderr.includes("npm run check:local"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test("local line-budget does not accept a caller-selected base override", () => {
  const result = spawnSync(process.execPath, [runnerPath, "--base", "HEAD~1"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts no arguments/u);
  assert.match(result.stderr, /base must come from freshly fetched canonical main/u);
});
