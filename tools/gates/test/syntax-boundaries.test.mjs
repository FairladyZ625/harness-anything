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
  // The gate enumerates through git; the excludesFile pin keeps host-global ignores out.
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: root });
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

test("G4 exact-sync rejects unlisted catch substitutions", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "packages/example/src/clean.ts"), "export const clean = true;\n");
  assert.equal(run("tools/check-fallback-boundaries.mjs", root, "--update").status, 0);
  writeFileSync(
    path.join(root, "packages/example/src/fallback.ts"),
    "export async function load() { try { return await primary(); } catch { return fallback(); } }\n",
  );
  const missing = run("tools/check-fallback-boundaries.mjs", root);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /unlisted: packages\/example\/src\/fallback\.ts#load/u);

  assert.equal(run("tools/check-fallback-boundaries.mjs", root, "--update").status, 0);
  writeFileSync(
    path.join(root, "packages/example/src/unrelated.ts"),
    "export async function unrelated() { try { return await primary(); } catch { return fallback(); } }\n",
  );
  const unrelated = run("tools/check-fallback-boundaries.mjs", root);
  assert.notEqual(unrelated.status, 0);
  assert.match(unrelated.stderr, /unlisted: packages\/example\/src\/unrelated\.ts#unrelated/u);
});

// task_1992b2c005f6bb7ee214a265bc: runtimeQueryKeys.events is a React Query key builder sharing
// the ledger-read method name; only real events(...) reads count as history scans.
test("G4 history-scan detection ignores runtimeQueryKeys builders but flags ledger events reads", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "packages/example/src/clean.ts"), "export const clean = true;\n");
  assert.equal(run("tools/check-fallback-boundaries.mjs", root, "--update").status, 0);
  writeFileSync(
    path.join(root, "packages/example/src/query-keys.ts"),
    "export const runtimeQueryKeys = { events: (repoId, sessionId) => ['runtime-session-events', repoId, sessionId] };\n" +
      "export function timeline(queryClient, repoId, sessionId) {\n" +
      "  return queryClient.getQueryData(runtimeQueryKeys.events(repoId, sessionId));\n" +
      "}\n",
  );
  const accepted = run("tools/check-fallback-boundaries.mjs", root);
  assert.equal(accepted.status, 0, accepted.stderr);
  writeFileSync(
    path.join(root, "packages/example/src/ledger-read.ts"),
    "export function poll(repoId, sessionId) { return agentRuntimeClient.events(repoId, sessionId, 'lifecycle:0'); }\n",
  );
  const rejected = run("tools/check-fallback-boundaries.mjs", root);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unlisted: .*ledger-read\.ts#poll/u);
});

function lint(rule, source, options = {}, filename = "packages/example/src/new.js") {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    source,
    {
      languageOptions: { ecmaVersion: 2024, sourceType: "module" },
      plugins: { ha: { rules: { rule } } },
      rules: { "ha/rule": ["error", options] },
    },
    { filename },
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

// dec_25B3C380F6FB9D4D4A1E27921E CH1: integration tests may not judge correctness by the wall clock.
test("G3 integration lane rejects wall-clock deadlines, scheduled timers and self-written polls", () => {
  const integration = { integration: true },
    filename = "packages/example/test/new.integration.test.mjs",
    kinds = (source, options = integration, name = filename) =>
      lint(noPollSpin, source, options, name).map((message) => /#([a-z-]+)$/u.exec(message.message)?.[1]);
  assert.deepEqual(
    kinds(
      "async function run() { const deadline = performance.now() + 5000; while (!ready() && performance.now() < deadline) await next(); }",
    ),
    ["clock-loop", "clock-deadline"],
  );
  assert.deepEqual(kinds("test('x', async () => { setTimeout(() => child.send('stop'), 2000); });"), [
    "scheduled-timer",
  ]);
  assert.deepEqual(kinds("const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));"), [
    "scheduled-timer",
  ]);
  // Negative fixtures: a watchdog that only fails the test bounds a hang and is not a correctness wait.
  assert.deepEqual(
    kinds(
      "function guard(child, ms) { return new Promise((_resolve, reject) => { setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hung')); }, ms); }); }",
    ),
    [],
  );
  assert.deepEqual(kinds("setTimeout(() => { throw new Error('hung'); }, 60_000);"), []);
  // A fail-only timer with a short resolved delay asserts speed: it is reported, not exempted.
  assert.deepEqual(kinds("setTimeout(() => reject(new Error('write was blocked')), 5_000);"), ["short-watchdog"]);
  assert.deepEqual(kinds("const guardMs = 3_000; setTimeout(() => reject(new Error('slow')), guardMs);"), [
    "short-watchdog",
  ]);
  assert.deepEqual(kinds("setTimeout(() => controller.abort(), 60_000);"), []);
  assert.deepEqual(kinds("test('x', { timeout: 30_000 }, async () => { await child.exited; });"), []);
  assert.deepEqual(
    kinds(
      "test('x', { timeout: 30_000 }, async () => { await child.exited; });",
      { ...integration },
      "packages/daemon/test/task-squad-orchestration.integration.test.mjs",
    ),
    ["contention-watchdog"],
  );
  assert.deepEqual(
    kinds(
      "test('x', { timeout: 60_000 }, async () => { await child.exited; });",
      { ...integration },
      "packages/daemon/test/task-squad-orchestration.integration.test.mjs",
    ),
    [],
  );
  assert.deepEqual(kinds("async function waitForReady() { for (;;) { if (await ready()) return; } }"), ["self-poll"]);
  assert.deepEqual(
    kinds(
      "import { waitForCondition } from '../../tools/fixtures/wait-for-condition.ts'; await waitForCondition(ready, 'ready');",
    ),
    ["poll-helper"],
  );
  assert.deepEqual(
    kinds("import { eventuallyValue } from './fixtures/runtime-ingress.ts'; await eventuallyValue(read);"),
    ["poll-helper"],
  );
  const eventDriven =
    "import { waitForArrival } from '../../tools/fixtures/event-arrival.ts';\n" +
    "test('x', async () => { const value = await waitForArrival(() => store.read(), (arrive) => store.subscribe(arrive)); });";
  assert.deepEqual(kinds(eventDriven), []);
  // The production lane keeps its narrower CH3 kinds: an elapsed-time read or a long timer is not a poll there.
  assert.equal(
    lint(noPollSpin, "const deadline = Date.now() + 5000; if (Date.now() > deadline) stop(); setTimeout(stop, 2000);")
      .length,
    0,
  );
});

test("G3 integration exact-sync: a new now()+N deadline loop fails and its waitForArrival rewrite passes", (t) => {
  const root = fixture(t),
    file = path.join(root, "packages/example/test/flow.integration.test.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(path.join(root, "packages/example/src/clean.ts"), "export const clean = true;\n");
  assert.equal(run("tools/check-poll-spin-boundary.mjs", root, "--update").status, 0);
  writeFileSync(
    file,
    "test('flow', async () => {\n" +
      "  const deadline = Date.now() + 10_000;\n" +
      "  while (!(await child.ready()) && Date.now() < deadline) await delay(20);\n" +
      "});\n",
  );
  const rejected = run("tools/check-poll-spin-boundary.mjs", root);
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /unlisted: packages\/example\/test\/flow\.integration\.test\.ts#<module>#clock-deadline/u,
  );
  writeFileSync(
    file,
    "import { waitForArrival } from '../../../tools/fixtures/event-arrival.ts';\n" +
      "test('flow', async () => {\n" +
      "  await waitForArrival(() => (child.readyNow() ? true : null), (arrive) => child.onMessage(arrive));\n" +
      "});\n",
  );
  const accepted = run("tools/check-poll-spin-boundary.mjs", root);
  assert.equal(accepted.status, 0, accepted.stderr);
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
  const source = "packages/storage/src/store/sqlite-task-event-publication.ts";
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
