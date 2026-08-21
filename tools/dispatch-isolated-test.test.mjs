// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDispatchArgs, posixTestScript, powerShellTestScript, sourceArchiveArgs, testRunnerArgs } from "./dispatch-isolated-test.mjs";

test("dispatcher defaults to Ubuntu and requires exactly one test selector", () => {
  assert.deepEqual(parseDispatchArgs(["--tier", "integration"]), { target: "ubuntu", tier: "integration", file: undefined });
  assert.throws(() => parseDispatchArgs([]), /choose exactly one/u);
  assert.throws(() => parseDispatchArgs(["--tier", "fast", "--file", "tools/a.test.mjs"]), /choose exactly one/u);
});

test("dispatcher accepts all isolated targets and validates exact file paths", () => {
  for (const target of ["ubuntu", "docker", "windows"]) {
    assert.deepEqual(parseDispatchArgs(["--target", target, "--file", "packages/cli/test/daemon-autostart-cli.test.ts"]), {
      target,
      tier: undefined,
      file: "packages/cli/test/daemon-autostart-cli.test.ts"
    });
  }
  assert.throws(() => parseDispatchArgs(["--target", "windows-vm", "--tier", "integration"]), /unknown target/u);
  assert.throws(() => parseDispatchArgs(["--file", "../outside.test.mjs"]), /repository-relative/u);
});

test("dispatcher builds runner commands for either supported selector", () => {
  assert.deepEqual(testRunnerArgs({ tier: "integration", file: undefined }), ["node", "tools/run-node-tests.mjs", "--tier", "integration"]);
  assert.deepEqual(testRunnerArgs({ tier: undefined, file: "tools/a.test.mjs" }), ["node", "tools/run-node-tests.mjs", "--file", "tools/a.test.mjs"]);
});

test("macOS source archives omit extended attributes while other hosts keep portable tar arguments", () => {
  assert.deepEqual(sourceArchiveArgs("darwin").slice(0, 2), ["--no-xattrs", "--exclude=.git"]);
  assert.equal(sourceArchiveArgs("linux").includes("--no-xattrs"), false);
});

test("remote scripts preflight before executing tests with a dedicated root and id", () => {
  const options = { tier: "integration", file: undefined };
  const posix = posixTestScript("/tmp/run", "/tmp/run/.test-isolation-state", options);
  assert.match(posix, /npm ci --no-audit --no-fund/u);
  assert.match(posix, /test-hermetic-preflight\.mjs --user-root '\/tmp\/run\/.test-isolation-state'/u);
  assert.match(posix, /HARNESS_DAEMON_USER_ROOT='\/tmp\/run\/.test-isolation-state'/u);

  const powerShell = powerShellTestScript("C:\\Temp\\run", "C:\\Temp\\run\\.test-isolation-state", options);
  assert.match(powerShell, /\$ProgressPreference = 'SilentlyContinue'/u);
  assert.match(powerShell, /test-hermetic-preflight\.mjs --user-root 'C:\\Temp\\run\\\.test-isolation-state'/u);
  assert.match(powerShell, /\$env:HARNESS_DAEMON_USER_ROOT = 'C:\\Temp\\run\\\.test-isolation-state'/u);
});
