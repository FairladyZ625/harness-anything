// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Linter } from "eslint";
import noPollSpin from "../eslint-rules/no-poll-spin.js";
import noSwallowedFailure from "../eslint-rules/no-swallowed-failure.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "syntax-boundary-"));
  mkdirSync(path.join(root, "packages/example/src"), { recursive: true });
  mkdirSync(path.join(root, "tools/gate-allowlists"), { recursive: true });
  return root;
}

function run(script, root, ...args) {
  return spawnSync(process.execPath, [path.join(repoRoot, script), ...args, root], { cwd: repoRoot, encoding: "utf8" });
}

test("G4 exact-sync rejects new consumeKnownError and online history scan functions", () => {
  const root = fixture();
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
