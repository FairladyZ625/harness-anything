// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Linter } from "eslint";
import noPollSpin from "../eslint-rules/no-poll-spin.js";
import noSwallowedFailure from "../eslint-rules/no-swallowed-failure.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "syntax-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages/example/src"), { recursive: true });
  mkdirSync(path.join(root, "tools/gate-allowlists"), { recursive: true });
  return root;
}

function run(script, root, ...args) {
  return spawnSync(process.execPath, [path.join(repoRoot, script), ...args, root], { cwd: repoRoot, encoding: "utf8" });
}

test("G4 exact-sync rejects new consumeKnownError and online history scan functions", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "packages/example/src/clean.ts"), "export const clean = true;\n");
  assert.equal(run("tools/check-fallback-boundaries.mjs", root, "--update").status, 0);
  writeFileSync(
    path.join(root, "packages/example/src/fallback.ts"),
    "export function fallback(e) { consumeKnownError(e); return store.readPendingEvents('x', 0); }\n",
  );
  const result = run("tools/check-fallback-boundaries.mjs", root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fallback\.ts#fallback/u);
});

function lint(rule, source, options = {}) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    source,
    {
      languageOptions: { ecmaVersion: 2024, sourceType: "module" },
      plugins: { ha: { rules: { rule } } },
      rules: { "ha/rule": ["error", options] },
    },
    { filename: "packages/example/src/new.js" },
  );
}

test("G3 rejects short timers and loop waits while accepting event-driven waits", () => {
  assert.equal(lint(noPollSpin, "setInterval(tick, 20);").length, 1);
  assert.equal(lint(noPollSpin, "async function run() { while (ready()) await delay(25); }").length, 1);
  assert.equal(
    lint(
      noPollSpin,
      "import { setImmediate as yieldToEventLoop } from 'node:timers/promises'; async function run() { for (;;) await yieldToEventLoop(); }",
    ).length,
    1,
  );
  assert.equal(lint(noPollSpin, "await completionEvent;").length, 0);
});

test("G4 catch-and-substitute rejects another producer unless baselined", () => {
  const source =
    "async function load() { try { return await primary(); } catch (error) { consumeKnownError(error); return fallback(); } }";
  assert.match(lint(noSwallowedFailure, source)[0].message, /another producer/u);
  assert.equal(
    lint(noSwallowedFailure, source, { substitutionBaseline: ["packages/example/src/new.js#load"] }).length,
    0,
  );
});

// dec_4190D5EA63D9DD208CE946F133: precise source-process unavailability consumption.
test("G4 command witness registration authorizes only its named consumer and detects removal", (t) => {
  const root = fixture(t);
  try {
    const source = "packages/daemon/src/task-witness-runner.ts";
    const key = `${source}#runCompletionSources`;
    const production = JSON.parse(
      readFileSync(path.join(repoRoot, "tools/gate-allowlists/check-fallback-boundaries.json"), "utf8"),
    );
    assert.ok(production.entries.consumeKnownError.includes(key));
    assert.equal(production.rationales[key].errors, "witness_unavailable");
    mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
    const body =
      "export function runCompletionSources() { try { collect(); } catch(error) { if(error.code !== 'witness_unavailable') throw error; consumeKnownError(error); } }\n";
    writeFileSync(path.join(root, source), body);
    writeFileSync(
      path.join(root, "tools/gate-allowlists/check-fallback-boundaries.json"),
      JSON.stringify({
        schema: production.schema,
        gateId: production.gateId,
        entries: { consumeKnownError: [key], fullHistoryScans: [], catchSubstitutions: [] },
      }),
    );
    const accepted = run("tools/check-fallback-boundaries.mjs", root);
    assert.equal(accepted.status, 0, accepted.stderr);
    writeFileSync(path.join(root, source), body + "export function unrelated(error) { consumeKnownError(error); }\n");
    assert.match(run("tools/check-fallback-boundaries.mjs", root).stderr, /unlisted: .*#unrelated/u);
    writeFileSync(path.join(root, source), "export {};\n");
    assert.match(run("tools/check-fallback-boundaries.mjs", root).stderr, /stale: .*#runCompletionSources/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// dec_5EC2631352B17EE2BF4979E37E: same-generation corruption must surface unchanged.
test("G4 rejects restoring the retired physical worktree error consumer", (t) => {
  const root = fixture(t);
  const source = "packages/kernel/src/store/sqlite-task-event-publication.ts";
  const key = `${source}#physicalWorktreeRevision`;
  const production = JSON.parse(
    readFileSync(path.join(repoRoot, "tools/gate-allowlists/check-fallback-boundaries.json"), "utf8"),
  );
  assert.equal(production.entries.consumeKnownError.includes(key), false);
  mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  writeFileSync(path.join(root, source), "export function physicalWorktreeRevision() { return readManifest(); }\n");
  writeFileSync(
    path.join(root, "tools/gate-allowlists/check-fallback-boundaries.json"),
    JSON.stringify({
      schema: production.schema,
      gateId: production.gateId,
      entries: { consumeKnownError: [], fullHistoryScans: [], catchSubstitutions: [] },
    }),
  );
  const accepted = run("tools/check-fallback-boundaries.mjs", root);
  assert.equal(accepted.status, 0, accepted.stderr);
  writeFileSync(
    path.join(root, source),
    "export function physicalWorktreeRevision() { try { return readManifest(); } catch(error) { consumeKnownError(error); return 0; } }\n",
  );
  const rejected = run("tools/check-fallback-boundaries.mjs", root);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unlisted: .*#physicalWorktreeRevision/u);
});
