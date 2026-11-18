// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceHooksDir = path.resolve(import.meta.dirname, "git-hooks");
// The outer runner's NODE_TEST_CONTEXT would turn the nested run into a subtest reporter.
const { NODE_TEST_CONTEXT: _outerRunner, ...baseEnv } = process.env;
const pathKey =
  process.platform === "win32" ? (Object.keys(baseEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH") : "PATH";
const cmdShell = process.env.ComSpec ?? "cmd.exe";
const spawnOptions = { encoding: "utf8", timeout: 30_000, windowsHide: true };

function quoteWindowsArgument(value) {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

// Windows source tar syncs do not preserve POSIX +x on extensionless scripts, so copy the
// wrappers into a test-owned directory and set +x there just as the sibling hook tests do.
function installWrapperDir(context) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "node wrapper bin "));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const nodeWrapper = path.join(dir, "node");
  copyFileSync(path.join(sourceHooksDir, "node"), nodeWrapper);
  chmodSync(nodeWrapper, 0o755);
  const cmdSource = path.join(sourceHooksDir, "node.cmd");
  assert.equal(existsSync(cmdSource), true, "tools/git-hooks/node.cmd must exist beside tools/git-hooks/node");
  copyFileSync(cmdSource, path.join(dir, "node.cmd"));
  return {
    dir,
    env: { ...baseEnv, [pathKey]: `${dir}${path.delimiter}${baseEnv[pathKey] ?? ""}` },
  };
}

function runCmd(command, options) {
  return spawnSync(cmdShell, ["/d", "/s", "/c", command], {
    ...spawnOptions,
    ...options,
    windowsVerbatimArguments: true,
  });
}

function runWrappedNode(args, options) {
  if (process.platform !== "win32") return spawnSync("node", args, { ...spawnOptions, ...options });
  return runCmd(["node", ...args].map(quoteWindowsArgument).join(" "), options);
}

// Node's test runner forwards its effective option to the test process.
function assertConcurrency(context, args, expected) {
  const { env } = installWrapperDir(context);
  const root = mkdtempSync(path.join(os.tmpdir(), "node-wrapper-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "argv.test.mjs"),
    `import assert from "node:assert/strict";\n` +
      `const concurrency = process.execArgv.filter((arg) => arg.startsWith("--test-concurrency="));\n` +
      `assert.deepEqual(concurrency, ["--test-concurrency=${expected}"]);\n`,
  );
  const run = runWrappedNode([...args, "--test", "argv.test.mjs"], { cwd: root, env });
  assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
}

test("node --test through the dispatch PATH sets the runner's concurrency to two", (context) => {
  assertConcurrency(context, [], 2);
});

test("an explicit --test-concurrency passes through unchanged", (context) => {
  assertConcurrency(context, ["--test-concurrency=4"], 4);
  assertConcurrency(context, ["--test-concurrency", "4"], 4);
});

test("a node command without --test passes through unchanged", (context) => {
  const { env } = installWrapperDir(context);
  const run = runWrappedNode(["-e", "process.stdout.write(process.execArgv.join(' '))"], {
    env,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /--test-concurrency/u);
});

test("dispatch PATH resolves the node wrapper and forwards = and whitespace arguments losslessly", (context) => {
  const { dir, env } = installWrapperDir(context);
  if (process.platform !== "win32") {
    const resolved = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", env });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), path.join(dir, "node"));
    const run = runWrappedNode(
      ["--test-concurrency=4", "-e", "process.stdout.write(['a=b c', ...process.execArgv].join('|'))"],
      { env },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^a=b c\|--test-concurrency=4\b/u);
    return;
  }

  const expectedCmd = path.join(dir, "node.cmd");
  const whereRun = runCmd("where.exe node.cmd", { env });
  assert.equal(whereRun.status, 0, whereRun.stderr);
  assert.equal(whereRun.stdout.split(/\r?\n/u)[0].toLowerCase(), expectedCmd.toLowerCase());

  const cmdArgRun = runWrappedNode(
    ["--test-concurrency=4", "-e", "process.stdout.write(['a=b c', ...process.execArgv].join('|'))"],
    { env },
  );
  assert.equal(cmdArgRun.status, 0, cmdArgRun.stderr);
  assert.match(cmdArgRun.stdout, /^a=b c\|--test-concurrency=4\b/u);

  const cmdNoSpaceRun = runWrappedNode(["-e", "console.log('a=b')"], { env });
  assert.equal(cmdNoSpaceRun.status, 0, cmdNoSpaceRun.stderr);
  assert.equal(cmdNoSpaceRun.stdout.trim(), "a=b");

  const cmdQuotedRun = runWrappedNode(["-e", 'console.log("a=b c", process.argv[1])', "/foo=d:/abc"], {
    env,
  });
  assert.equal(cmdQuotedRun.status, 0, `${cmdQuotedRun.stdout}\n${cmdQuotedRun.stderr}`);
  assert.equal(cmdQuotedRun.stdout.trim(), "a=b c /foo=d:/abc");

  const psScript = [
    "$src = (Get-Command node).Source",
    'Write-Output "SRC=$src"',
    `if ($src -ne '${expectedCmd.replaceAll("'", "''")}') { exit 2 }`,
    "node -e \"console.log('a=b')\"",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "node --test-concurrency=4 -e \"process.stdout.write(['a=b c', ...process.execArgv].join('|'))\"",
    "exit $LASTEXITCODE",
  ].join("\n");
  const psEncoded = Buffer.from(psScript, "utf16le").toString("base64");
  const psRun = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded], {
    ...spawnOptions,
    env,
  });
  assert.equal(psRun.status, 0, psRun.stderr);
  const psLines = psRun.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(psLines[0]?.toLowerCase(), `src=${expectedCmd.toLowerCase()}`);
  assert.equal(psLines[1] ?? "", "a=b");
  assert.match(psLines[2] ?? "", /^a=b c\|--test-concurrency=4\b/u);
});
