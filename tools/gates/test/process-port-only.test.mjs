// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import rule from "../eslint-rules/process-port-only.js";

function lint(source, options = {}, filename = "packages/example/src/run.ts") {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(source, {
    files: ["**/*.ts"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { ha: { rules: { "process-port-only": rule } } },
    rules: { "ha/process-port-only": ["error", options] }
  }, { filename });
}

test("G19 accepts argv process calls and dedicated process ports", () => {
  assert.deepEqual(lint("import { spawn } from 'node:child_process'; spawn('git', ['status'], { windowsHide: true });"), []);
  assert.deepEqual(lint("import { exec } from 'node:child_process'; exec('git status');", {}, "packages/example/src/process-port.ts"), []);
});

test("G19 rejects string exec, shell:true, POSIX shell literals, and entry regex", () => {
  const source = [
    "import { exec } from 'node:child_process';",
    "exec('git status');",
    "spawn('git status', { shell: true });",
    "const shell = '/bin/sh';",
    "const entry = /dist\\/cli\\/src\\/index\\.js$/u;"
  ].join("\n");
  const messages = lint(source);
  assert.equal(messages.length, 4);
  assert.match(messages.map((entry) => entry.message).join("\n"), /exec\(string\).*shell: true.*\/bin\/sh.*entrypoints/su);
});

test("G19 baseline exemptions are exact and do not cover modified code", () => {
  const source = "spawn('git status', { shell: true });";
  const first = lint(source);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.deepEqual(lint(source, { baseline: [fingerprint] }), []);
  assert.equal(lint("spawn('git diff', { shell: true });", { baseline: [fingerprint] }).length, 1);
});

test("G19 requires windowsHide where the console-less daemon spawns children", () => {
  const source = "import { execFileSync } from 'node:child_process'; execFileSync('git', ['status'], { encoding: 'utf8' });";
  const messages = lint(source);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "windowsHide");
  // An omitted options object is the same defect, and namespace calls are reached too.
  assert.equal(lint("import { spawnSync } from 'node:child_process'; spawnSync('git', ['status']);").length, 1);
  assert.equal(lint("import cp from 'node:child_process'; cp.execFile('git', ['status'], () => {});").length, 1);
  // Gate and tool scripts run from a terminal their children inherit, so no window is allocated there.
  assert.deepEqual(lint(source, {}, "tools/gates/example.mjs"), []);
});
