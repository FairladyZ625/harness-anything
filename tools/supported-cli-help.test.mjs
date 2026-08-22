// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { daemonProtocolCommands } from "../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { parseDispatchArgs as parseIsolatedDispatchArgs } from "./dispatch-isolated-test.mjs";
import { parseRunnerArgs } from "./node-test-runner-lib.mjs";
import { dispatchIsolatedTestCommand, parseToolOptions, renderToolHelp, runNodeTestsCommand, supportedToolCommands } from "./tool-command-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("every supported CLI and tool entrypoint exposes non-empty --help", { timeout: 30_000 }, () => {
  for (const descriptor of daemonProtocolCommands) {
    assertHelp(["packages/cli/src/index.ts", ...descriptor.path, "--help"], descriptor.id);
  }
  for (const descriptor of supportedToolCommands) {
    assertHelp([descriptor.entry, "--help"], descriptor.id);
  }
});

test("sample tool parsers accept every documented flag and reject an undocumented flag", () => {
  assert.deepEqual(parseIsolatedDispatchArgs(["--target", "docker", "--tier", "fast"]), {
    target: "docker", tier: "fast", file: undefined,
  });
  assert.equal(parseRunnerArgs(["--tier=integration", "--prefix", "tools", "--slow-limit=3"]).tier, "integration");
  for (const [descriptor, parse, invocations] of [
    [dispatchIsolatedTestCommand, parseIsolatedDispatchArgs, [["--target", "docker", "--tier", "fast"], ["--file", "tools/run-node-tests.test.mjs"]]],
    [runNodeTestsCommand, parseRunnerArgs, [["--tier=integration", "--list", "--slow-threshold-ms", "0", "--slow-limit=3", "--concurrency", "2", "--prefix", "tools", "--shard", "1"], ["--file=tools/run-node-tests.test.mjs"]]],
  ]) {
    const help = renderToolHelp(descriptor);
    for (const option of descriptor.options) assert.match(help, new RegExp(option.name, "u"));
    for (const argv of invocations) assert.doesNotThrow(() => parse(argv));
    assert.deepEqual(descriptor.options.map(({ name }) => name).sort(), descriptor.options.map(({ name }) => name).filter((name) => invocations.some((argv) => argv.some((arg) => arg === name || arg.startsWith(`${name}=`)))).sort());
    assert.throws(() => parse(["--not-documented"]), /--not-documented|Usage:/u);
  }
});

test("shared tool option rejections point to descriptor-derived help", () => {
  for (const descriptor of supportedToolCommands.filter(({ invalidInputShowsHelp }) => invalidInputShowsHelp !== true)) {
    assert.throws(() => parseToolOptions(descriptor, ["--policy-conformance-probe"]), new RegExp(`Run node ${descriptor.entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} --help\\.`, "u"));
  }
});

function assertHelp(args, id) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${id}: ${result.stderr || result.stdout}`);
  assert.ok(`${result.stdout}${result.stderr}`.trim().length > 0, `${id}: help output was empty`);
}
