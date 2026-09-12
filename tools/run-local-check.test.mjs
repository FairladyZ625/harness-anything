// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildSteps,
  localChangedPaths,
  parseLocalCheckArgs,
  excludedBoundaryGateIds,
  selectQosPrefix,
} from "./run-local-check.mjs";

test("parseLocalCheckArgs defaults to the waiting fast tier", () => {
  assert.deepEqual(parseLocalCheckArgs([]), { full: false, wait: true, pollMs: 2000 });
});

test("parseLocalCheckArgs recognizes --full, --fast and --no-wait", () => {
  assert.equal(parseLocalCheckArgs(["--full"]).full, true);
  assert.equal(parseLocalCheckArgs(["--fast"]).full, false);
  assert.equal(parseLocalCheckArgs(["--no-wait"]).wait, false);
  // last tier flag wins
  assert.equal(parseLocalCheckArgs(["--full", "--fast"]).full, false);
});

test("parseLocalCheckArgs rejects unknown options", () => {
  assert.throws(() => parseLocalCheckArgs(["--bogus"]), /unknown run-local-check option/u);
});

test("buildSteps keeps unchanged work fast and forces all extra lanes with full", () => {
  const fastScripts = buildSteps(false).map(([, script]) => script);
  const fullScripts = buildSteps(true).map(([, script]) => script);

  assert.ok(!fastScripts.includes("test:integration"));
  assert.ok(!fastScripts.includes("test:gui"));
  assert.ok(!fastScripts.includes("test:gui:e2e"));
  assert.ok(fullScripts.includes("test:integration"));
  assert.ok(fullScripts.includes("test:gui"));
  assert.ok(fullScripts.includes("test:gui:e2e"));
  assert.equal(fullScripts.length, fastScripts.length + 3);

  // Fast tier derives the CI boundaries + package-policy surface from the gate
  // manifest, so every deterministic checkPr gate in those jobs must be present.
  const manifest = JSON.parse(readFileSync(new URL("./gate-manifest.json", import.meta.url), "utf8"));
  const excluded = excludedBoundaryGateIds();
  const expectedScripts = manifest.gates
    .filter((gate) => {
      const surfaces = gate.executionSurfaces ?? {};
      const jobs = surfaces.rewriteCi?.pullRequestJobs ?? [];
      const pkg = surfaces.packageJson ?? {};
      return (
        jobs.some((job) => job === "boundaries" || job === "package-policy") &&
        !excluded.has(gate.id) &&
        typeof pkg.script === "string" &&
        pkg.checkPr === true &&
        gate.deterministic === true
      );
    })
    .map((gate) => gate.executionSurfaces.packageJson.script);
  for (const script of expectedScripts) {
    assert.ok(fastScripts.includes(script), `missing manifest gate script: ${script}`);
  }
  assert.ok(fastScripts.includes("lint"));
  assert.ok(fastScripts.includes("check:local:line-budget"));
  // Positive control: the gate PR #1358 slipped through on must be present.
  assert.ok(fastScripts.includes("harness:check-cli-help-contract"));
  // CI's boundaries exclusions must be honored locally too — and only those. The
  // rebuild lane used to exclude check-duplicate-definitions here; with all 50 groups
  // cleared the gate is back in CI, so it has to be back in the local set as well.
  assert.deepEqual([...excluded], []);
  assert.ok(fastScripts.includes("harness:check-duplicate-definitions"));
  assert.deepEqual(fastScripts.slice(-2), ["check:local:derived-contracts", "check:local:schema-closure"]);
});

test("the local line-budget step resolves to an executable package script", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["check:local:line-budget"], "node tools/run-local-line-budget.mjs");
});

test("selectQosPrefix wraps with taskpolicy on darwin when available", () => {
  assert.deepEqual(selectQosPrefix({ platform: "darwin", hasTaskpolicy: true, hasNice: true }), [
    "taskpolicy",
    "-c",
    "utility",
  ]);
});

test("selectQosPrefix falls back to nice off darwin or without taskpolicy", () => {
  assert.deepEqual(selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: true }), ["nice", "-n", "10"]);
  assert.deepEqual(selectQosPrefix({ platform: "darwin", hasTaskpolicy: false, hasNice: true }), ["nice", "-n", "10"]);
});

test("selectQosPrefix runs bare when no QoS tool is available", () => {
  assert.deepEqual(selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: false }), []);
});

for (const file of [
  "packages/cli/src/index.ts",
  "packages/kernel/src/store/task-store.ts",
  "packages/daemon/src/runtime.ts",
]) {
  test(`default local steps include integration for ${file}`, () => {
    assert.ok(buildSteps(false, [file]).some(([, script]) => script === "test:integration"));
  });
}

test("changed test selection reads its marker, regardless of its filename", () => {
  const file = "tools/custom.test.mjs";
  const readSource = () => "// harness-test-tier: integration\n";
  assert.ok(buildSteps(false, [file], readSource).some(([, script]) => script === "test:integration"));
  assert.ok(!buildSteps(false, [file], () => "// harness-test-tier: fast\n").some(([, s]) => s === "test:integration"));
  assert.equal(buildSteps(true, [file], readSource).filter(([, s]) => s === "test:integration").length, 1);
  assert.ok(!buildSteps(false, ["README.md"]).some(([, s]) => s === "test:integration"));
});

test("local changed paths include committed, staged, unstaged, deleted and untracked files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "local-changes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  const write = (file, text) => writeFileSync(path.join(root, file), text);
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  for (const file of ["committed", "staged", "unstaged", "deleted"]) write(file, "base");
  git("add", ".");
  git("commit", "-m", "test: base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  write("committed", "changed");
  git("add", "committed");
  git("commit", "-m", "test: branch change");
  write("staged", "changed");
  git("add", "staged");
  write("unstaged", "changed");
  rmSync(path.join(root, "deleted"));
  write("untracked", "changed");
  assert.deepEqual(localChangedPaths(root).sort(), ["committed", "deleted", "staged", "unstaged", "untracked"]);
});

test("deleted tests select integration and malformed markers cannot silently omit it", () => {
  assert.ok(buildSteps(false, ["tools/deleted.test.mjs"], () => null).some(([, s]) => s === "test:integration"));
  assert.throws(() => buildSteps(false, ["tools/broken.test.mjs"], () => ""), /test tier marker missing/u);
});

test("test helpers and data fixtures select all tiers without requiring test markers", () => {
  for (const file of ["packages/cli/test/helpers.ts", "packages/kernel/test/fixtures/input.json"]) {
    assert.ok(buildSteps(false, [file], () => "{}").some(([, s]) => s === "test:integration"));
  }
});
