// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("unknown daemon product commands use parse errors with focused next steps", () => {
  const command = runDaemonFailure(["daemon", "project"]);
  assert.equal(command.status, 2);
  assert.equal(command.receipt.error.code, "unknown_command");
  assert.match(command.receipt.error.hint, /ha daemon --help/u);
  assert.doesNotMatch(command.receipt.error.hint, /journal/u);

  const repoCommand = runDaemonFailure(["daemon", "repo", "project"]);
  assert.equal(repoCommand.status, 2);
  assert.equal(repoCommand.receipt.error.code, "unknown_command");
  assert.match(repoCommand.receipt.error.hint, /ha daemon repo --help/u);
});

function runDaemonFailure(args: ReadonlyArray<string>): {
  readonly status: number | null;
  readonly receipt: { readonly error: { readonly code: string; readonly hint: string } };
} {
  const result = spawnSync(process.execPath, [cliEntry, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_DAEMON_MODE: "fixture" }
  });
  assert.equal(result.stderr, "");
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as { readonly error: { readonly code: string; readonly hint: string } }
  };
}
