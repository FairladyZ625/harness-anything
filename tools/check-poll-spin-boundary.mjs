/**
 * check-poll-spin-boundary — the one ratchet gate for polling and wall-clock waits.
 *
 * Lanes. One ESLint rule (tools/gates/eslint-rules/no-poll-spin.js), one baseline file and one
 * exact-sync check cover two lanes:
 *   - production: packages/*\/src and tools/gates (dec_EF5F3820E81FB8A5266F1F3342 CH3);
 *   - integration tests: every `*.integration.test.{ts,tsx,mjs,js}` under packages/ and tools/
 *     (dec_25B3C380F6FB9D4D4A1E27921E CH1). A test joins the lane by its file name, the same name
 *     the integration tier and its CI shards select; helpers it imports are covered through the
 *     `poll-helper` kind at the call site.
 *
 * Integration kinds (AST, reported as file#enclosing-symbol#kind):
 *   clock-deadline   a comparison against Date.now()/performance.now(), or `deadline - now()`;
 *   clock-loop       a while/do-while whose test reads the clock;
 *   await-in-loop    awaiting sleep/delay/setTimeout/setImmediate inside a loop;
 *   scheduled-timer  setTimeout/setInterval whose callback does anything but fail the test
 *                    (resolve a sleep, message the child, destroy a socket, a scripted kill);
 *   short-watchdog   a fail-only timer whose delay resolves below 20 s: a speed assertion;
 *   self-poll        a function named waitFor*, waitUntil*, poll*, eventually*, until*, retry*
 *                    whose body loops;
 *   poll-helper      a call to tools/fixtures/wait-for-condition.ts or an imported eventually*.
 *
 * Correctness wait vs hang guard. A correctness wait decides when the test may look again; it must
 * be an event the process under test publishes: waitForArrival(read, subscribe) from
 * tools/fixtures/event-arrival.ts, a child "message"/"exit" event, a stream line. A hang guard only
 * ends a stuck test as failed and never asserts speed: the node:test `timeout` option, or a timer
 * whose callback only rejects/throws/assert.fail()s and whose delay is a parameter or at
 * least 20 s. Hang guards are not reported.
 *
 * Baseline. tools/gate-allowlists/check-poll-spin-boundary.json lists every reported key with
 * event, ref and reason. The check is exact: a new key fails as `unlisted`, a key whose site was
 * converted fails as `stale` until its entry is deleted, so the list only shrinks. `--update`
 * rewrites it and is for intentional removals only.
 *
 * Fixtures. tools/gates/test/syntax-boundaries.test.mjs holds the positive fixtures (each kind is
 * reported, a new now()+N deadline loop fails the gate) and the negative ones (waitForArrival,
 * node:test timeout, fail-only watchdogs pass).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import noPollSpin from "./gates/eslint-rules/no-poll-spin.js";

const gateId = "check-poll-spin-boundary";
const allowlistPath = `tools/gate-allowlists/${gateId}.json`;
const update = process.argv.includes("--update");
const rootArg = process.argv.slice(2).find((argument) => argument !== "--update");
const root = path.resolve(rootArg ?? process.cwd());
// Production sources (dec_EF5F3820E81FB8A5266F1F3342 CH3) and integration tests
// (dec_25B3C380F6FB9D4D4A1E27921E CH1) share one rule, one baseline and one exact-sync ratchet; the
// integration flag adds the wall-clock-as-correctness kinds only to test files.
const integrationPatterns = [
  "packages/**/*.integration.test.{ts,tsx,mjs,js}",
  "tools/**/*.integration.test.{ts,mjs,js}",
];
const lanes = [
  { patterns: ["packages/*/src/**/*.{ts,tsx,js,mjs}", "tools/gates/**/*.{js,mjs}"], integration: false },
  { patterns: integrationPatterns, integration: true },
];
const keys = new Set();
for (const lane of lanes) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ["**/*.{js,mjs,ts,tsx}"],
        languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2024, sourceType: "module" } },
        plugins: { ha: { rules: { "no-poll-spin": noPollSpin } } },
        rules: { "ha/no-poll-spin": ["error", { baseline: [], root, integration: lane.integration }] },
      },
    ],
  });
  for (const result of await eslint.lintFiles(lane.patterns)) {
    if (result.filePath.endsWith("no-poll-spin.js")) continue;
    for (const message of result.messages) {
      const key = /Baseline key: (\S+)/u.exec(message.message)?.[1];
      if (key) keys.add(key);
    }
  }
}
if (update) {
  const exceptions = [...keys].sort().map((key) =>
    /\.integration\.test\./u.test(key)
      ? {
          key,
          event: "baseline-2026-11-08: integration test judges correctness by the wall clock",
          ref: "dec_25B3C380F6FB9D4D4A1E27921E",
          reason: "Existing wall-clock wait at the CH1 baseline; convert to waitForArrival and delete this entry.",
        }
      : {
          key,
          event: "baseline-2026-09-10: no awaitable completion event is exposed by the current API",
          ref: "dec_EF5F3820E81FB8A5266F1F3342",
          reason: "Existing polling or synchronous bridge at the CH3 baseline.",
        },
  );
  const document = { schema: "harness-anything/gate-allowlist/v1", gateId, entries: { exceptions } };
  await writeFile(path.join(root, allowlistPath), `${JSON.stringify(document, null, 2)}\n`);
}
const document = JSON.parse(await readFile(path.join(root, allowlistPath), "utf8"));
const entries = document.entries.exceptions;
for (const field of ["key", "event", "ref", "reason"]) {
  if (entries.some((entry) => typeof entry[field] !== "string" || !entry[field]))
    throw new Error(`poll-spin allowlist entry missing ${field}`);
}
const expected = new Set(entries.map((entry) => entry.key));
const missing = [...keys].filter((key) => !expected.has(key));
const stale = [...expected].filter((key) => !keys.has(key));
if (missing.length || stale.length)
  throw new Error(
    [
      ...missing.map((key) => `unlisted: ${key}`),
      ...stale.map((key) => `stale: ${key}`),
      `update ${allowlistPath} with event, ref, and reason`,
    ].join("\n"),
  );
console.log(`${gateId}: ${keys.size} allowed sites`);
