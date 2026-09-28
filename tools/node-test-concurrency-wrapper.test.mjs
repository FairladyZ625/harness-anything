// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const wrapperDir = path.resolve(import.meta.dirname, "git-hooks");
const posixOnly = process.platform === "win32" ? "the node wrapper is a POSIX shell script" : false;
// The outer runner's NODE_TEST_CONTEXT would turn the nested run into a subtest reporter.
const { NODE_TEST_CONTEXT: _outerRunner, ...baseEnv } = process.env;
const wrappedEnv = { ...baseEnv, PATH: `${wrapperDir}${path.delimiter}${process.env.PATH ?? ""}` };

// Each file logs its start and end around a pause, so the log shows how many ran at once.
function peakConcurrency(context, args) {
  const root = mkdtempSync(path.join(os.tmpdir(), "node-wrapper-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "log");
  for (let index = 0; index < 5; index += 1)
    writeFileSync(
      path.join(root, `f${index}.test.mjs`),
      `import test from "node:test";\nimport { appendFileSync } from "node:fs";\n` +
        `test("t", async () => { appendFileSync(${JSON.stringify(log)}, "s\\n"); ` +
        `await new Promise((resolve) => setTimeout(resolve, 600)); appendFileSync(${JSON.stringify(log)}, "e\\n"); });\n`,
    );
  const run = spawnSync(
    "node",
    [...args, "--test", "f0.test.mjs", "f1.test.mjs", "f2.test.mjs", "f3.test.mjs", "f4.test.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: wrappedEnv,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  let running = 0,
    peak = 0;
  for (const line of readFileSync(log, "utf8").trim().split("\n")) {
    running += line === "s" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

test("node --test through the dispatch PATH runs at most two test files at once", { skip: posixOnly }, (context) => {
  assert.ok(peakConcurrency(context, []) <= 2);
});

test("an explicit --test-concurrency passes through unchanged", { skip: posixOnly }, (context) => {
  assert.ok(peakConcurrency(context, ["--test-concurrency=4"]) > 2);
});

test("a node command without --test passes through unchanged", { skip: posixOnly }, () => {
  const run = spawnSync("node", ["-e", "process.stdout.write(process.execArgv.join(' '))"], {
    encoding: "utf8",
    env: wrappedEnv,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /--test-concurrency/u);
});
