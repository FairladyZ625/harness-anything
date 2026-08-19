// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWindowsFirstRun } from "../windows-first-run.mjs";
import { makeRepo } from "./helpers.mjs";

// The gate drives a real CLI over a real repository, so these fixtures stand in a scripted bin
// whose failure modes are the ones actually reported from Windows. A gate that cannot be made to
// fail on demand is not evidence, and this one had a first draft with exactly that problem.
const STUB = [
  "import { execFileSync } from 'node:child_process';",
  "import { mkdirSync, existsSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const repo = argv[argv.indexOf('--root') + 1];",
  "const rest = argv.filter((value, index) => !value.startsWith('--') && argv[index - 1] !== '--root');",
  "const ledger = path.join(repo, 'harness'), config = path.join(ledger, 'harness.yaml');",
  "const stopped = path.join(repo, '.stopped');",
  "const git = (...args) => execFileSync('git', args, { cwd: ledger, stdio: 'ignore' });",
  "const emit = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };",
  "if (rest[0] === 'init') {",
  "  mkdirSync(ledger, { recursive: true }); writeFileSync(config, 'name: firstrun\\n');",
  "  git('init', '-q'); git('config', 'user.email', 'g@h.invalid'); git('config', 'user.name', 'G');",
  "  git('add', '-A'); git('commit', '-qm', 'base');",
  "  if (process.env.STUB_CRLF_AFTER_COMMIT) writeFileSync(config, 'name: firstrun\\r\\n');",
  "  emit({ outcome: 'applied' });",
  "}",
  "if (rest[0] === 'daemon' && rest[1] === 'status') emit({ running: !existsSync(stopped) }, existsSync(stopped) && !process.env.STUB_STOP_NEVER_SETTLES ? 1 : 0);",
  "if (rest[0] === 'daemon' && rest[1] === 'stop') { writeFileSync(stopped, ''); emit({ outcome: 'applied' }, process.env.STUB_STOP_REPORTS_TIMEOUT ? 1 : 0); }",
  "if (rest[0] === 'task' && rest[1] === 'create') emit({ outcome: 'applied' });",
  "if (rest[0] === 'task' && rest[1] === 'show') emit({ id: 'first-task' });",
  "if (rest[0] === 'fact') emit({ outcome: 'applied' });",
  "emit({ code: 'unsupported_command' }, 1);"
].join("\n");

function fixture() {
  return makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/index.js" } }),
    "packages/cli/dist/index.js": STUB
  });
}

function evaluateWith(overrides) {
  const previous = { ...process.env };
  Object.assign(process.env, overrides);
  try { return evaluateWindowsFirstRun(fixture().rootDir, { stopSettleMs: 2_000 }); }
  finally { for (const key of Object.keys(overrides)) delete process.env[key]; Object.assign(process.env, previous); }
}

test("G34 passes when the first-run path initializes, publishes, clones faithfully, and stops", () => {
  const result = evaluateWith({});
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.checks.length, 11);
});

// #1565: stop did stop the daemon but reported daemon_stop_timeout. A stop that cannot say what
// it did is a failure, because the operator has no way to tell it from a stop that hung.
test("G34 fails a stop that succeeds but reports a timeout", () => {
  const result = evaluateWith({ STUB_STOP_REPORTS_TIMEOUT: "1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /stop reports the stop it performed/u);
});

test("G34 fails when the daemon keeps answering after a successful stop", () => {
  const result = evaluateWith({ STUB_STOP_NEVER_SETTLES: "1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /status reports the daemon gone after stop/u);
});

// #1588: byte loss happens in the clone, not in the write, so the comparison has to be against a
// clone. An earlier draft compared the written files and stayed green under global autocrlf.
test("G34 fails when a clone of the ledger is not byte-identical to the published bytes", () => {
  const result = evaluateWith({ STUB_CRLF_AFTER_COMMIT: "1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /byte-identical/u);
});

test("G34 fails when the declared CLI entrypoint is unresolved", () => {
  const { rootDir } = makeRepo({ "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/missing.js" } }) });
  const result = evaluateWindowsFirstRun(rootDir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not built/u);
});
