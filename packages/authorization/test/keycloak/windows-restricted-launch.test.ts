// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ManagedRbacHost } from "../../src/keycloak/managed-host.ts";
import {
  buildWindowsRestrictedLaunchArgs,
  quoteWindowsArg,
  windowsPostgresLaunch,
} from "../../src/keycloak/windows-restricted-launch.ts";

const unusedHost: ManagedRbacHost = {
  runProcessText: () => "",
  runProcessTextAsync: async () => "",
  runProcessExitAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  validateCertificateNames: () => undefined,
  mapListenerBindError: (error) => (error instanceof Error ? error : new Error(String(error))),
};

test("quoteWindowsArg follows Windows CommandLineToArgvW escaping rules", () => {
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("simple"), "simple");
  assert.equal(quoteWindowsArg("C:\\Program Files\\pg\\postgres.exe"), '"C:\\Program Files\\pg\\postgres.exe"');
  assert.equal(quoteWindowsArg('say "hi"\\'), '"say \\"hi\\"\\\\"');
});

test("windowsPostgresLaunch wraps only elevated win32 launches in the restricted-token launcher", async () => {
  const args = ["-D", "C:\\data dir\\postgres", "-p", "5432"];
  assert.deepEqual(await windowsPostgresLaunch("/bin/postgres", args, "linux", unusedHost, () => true), [
    "/bin/postgres",
    args,
  ]);
  assert.deepEqual(await windowsPostgresLaunch("C:\\pg\\postgres.exe", args, "win32", unusedHost, () => false), [
    "C:\\pg\\postgres.exe",
    args,
  ]);

  const [cmd, launchArgs] = await windowsPostgresLaunch("C:\\pg\\postgres.exe", args, "win32", unusedHost, () => true);
  assert.equal(cmd, "powershell.exe");
  assert.equal(launchArgs.includes("-EncodedCommand"), true);
  const decoded = Buffer.from(launchArgs.at(-1)!, "base64").toString("utf16le");
  assert.match(decoded, /CreateRestrictedToken/u);
  assert.match(decoded, /CreateProcessAsUser/u);
  assert.match(decoded, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|0x2000u/u);
});

test("buildWindowsRestrictedLaunchArgs propagates stdout, stderr, quoted arguments, and exit code on Windows", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only Win32 CreateRestrictedToken execution check");
    return;
  }
  const [cmd, args] = buildWindowsRestrictedLaunchArgs(process.execPath, [
    "-e",
    'process.stdout.write("OUT:" + process.argv[1] + "\\n"); process.stderr.write("ERR\\n"); process.exit(7);',
    'space and "quote"',
  ]);
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'OUT:space and "quote"\n');
  assert.equal(result.stderr, "ERR\n");
});
