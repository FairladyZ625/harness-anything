// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { defaultDaemonUserRoot, runDaemonCommand, runRawJson, withTempRootAsync } from "./helpers/daemon-cli.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("daemon logs out-of-range limit reports a parse error, not a journal failure", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_USER_ROOT: userRoot });
    runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
    try {
      const result = runCliMaybeFail(rootDir, ["daemon", "logs", "--limit", "500", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      assert.equal(result.status, 1);
      assert.equal(result.receipt.ok, false);
      const error = (result.receipt as { readonly error?: { readonly code: string; readonly hint: string } }).error;
      assert.equal(error?.code, "invalid_daemon_log_input");
      assert.match(error?.hint ?? "", /limit must be an integer from 1 through 200/u);
      assert.doesNotMatch(error?.code ?? "", /journal/u);
    } finally {
      runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "5000", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
    }
  });
});

function runCliMaybeFail(rootDir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>>): {
  readonly status: number | null;
  readonly receipt: Record<string, unknown>;
} {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: cliTestEnv({ ...env })
  });
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as Record<string, unknown>
  };
}
