// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDurableActionAuthorization, loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";
import { replaceSourceOnce, runGit } from "./helpers.mjs";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../.."),
  inputs = await loadAuthorizationInputs(repoRoot),
  owners = ["settings-update", "task-rework"],
  effects = owners.map((kind) =>
    inputs.constants.actionDeclarations
      .find((action) => action.kind === kind)
      .ontology.sources.find((source) => source.role === "effect" && source.route === kind),
  );

let testOrdinal = 0;
function partitionedTest(name, fn) {
  if (testOrdinalInPartition(testOrdinal++, process.env.HARNESS_TEST_PARTITION)) test(name, fn);
}

function audit(sourceRoot = repoRoot, only = owners) {
  return auditDurableActionAuthorization(repoRoot, inputs, { sourceRoot, only });
}

function detachedSource(t, file, from, to) {
  const dir = mkdtempSync(path.join(tmpdir(), "daemon-domain-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Copy the mutated package; every other import remains read-only in the real checkout.
  mkdirSync(path.join(dir, "packages"));
  for (const entry of readdirSync(path.join(repoRoot, "packages")))
    if (entry !== "daemon")
      symlinkSync(path.join(repoRoot, "packages", entry), path.join(dir, "packages", entry), "dir");
  cpSync(path.join(repoRoot, "packages/daemon/src"), path.join(dir, "packages/daemon/src"), { recursive: true });
  cpSync(path.join(repoRoot, "packages/daemon/package.json"), path.join(dir, "packages/daemon/package.json"));
  cpSync(path.join(repoRoot, "packages/daemon/scripts"), path.join(dir, "packages/daemon/scripts"), {
    recursive: true,
  });
  cpSync(
    path.join(repoRoot, "packages/daemon/tsconfig.build.json"),
    path.join(dir, "packages/daemon/tsconfig.build.json"),
  );
  for (const entry of ["tools", "node_modules"]) symlinkSync(path.join(repoRoot, entry), path.join(dir, entry), "dir");
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "core.excludesFile", "/dev/null"]);
  const target = path.join(dir, file);
  writeFileSync(target, replaceSourceOnce(readFileSync(target, "utf8"), from, to, file));
  return dir;
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: a green owner row cannot substitute for the
// real settings publisher or rework service. Both must be reached through their caller frames.
test("domain-service proofs retain both canonical effect owners", () => {
  assert.deepEqual(
    effects.map((source) => source.route),
    owners,
  );
  assert.equal(new Set(effects.map((source) => source.candidateId)).size, owners.length);
});

for (const kind of owners)
  partitionedTest(`${kind} reaches its canonical business source`, () => {
    const result = audit(repoRoot, [kind]),
      source = effects.find((entry) => entry.route === kind),
      row = result.sourceRows.find((entry) => entry.id === source.candidateId),
      owner = result.rows.find((entry) => entry.id === kind);
    assert.equal(owner?.ok, true, JSON.stringify({ owner, source: row }));
    assert.equal(row?.ok, true, JSON.stringify(row));
    assert.deepEqual(result.findings, []);
  });

for (const [kind, file, from, to] of [
  [
    "settings-update",
    "packages/daemon/src/repo-cell-action-dispatch.ts",
    "settings: makeSettingsActionRuntime(cell, cell.settings)",
    'settings: () => { throw new Error("detached settings runtime"); }',
  ],
  [
    "task-rework",
    "packages/daemon/src/repo-cell-command-run.ts",
    "if (event)\n              return (await continueReviewRework(",
    "if (false && event)\n              return (await continueReviewRework(",
  ],
])
  partitionedTest(`detaching ${kind} keeps owner authority but rejects its unreachable source`, (t) => {
    const result = audit(detachedSource(t, file, from, to), [kind]),
      source = effects.find((entry) => entry.route === kind),
      row = result.sourceRows.find((entry) => entry.id === source.candidateId);
    assert.equal(result.rows.find((entry) => entry.id === kind)?.ok, true);
    assert.equal(row?.ok, false, JSON.stringify(row));
    assert.ok(result.findings.some((finding) => finding.includes(source.candidateId)));
  });
