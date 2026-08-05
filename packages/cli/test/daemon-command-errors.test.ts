// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

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

test("missing --repo-id on daemon repo unregister reports a parse error, not a journal failure", () => {
  const result = runDaemonFailure(["daemon", "repo", "unregister"]);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.error.code, "missing_required_option");
  assert.equal(result.receipt.error.hint, "Use --repo-id <value>.");
  assert.doesNotMatch(result.receipt.error.code, /journal/u);
});

test("missing --out on daemon install-templates reports a parse error, not a journal failure", () => {
  const result = runDaemonFailure(["daemon", "install-templates"]);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.error.code, "missing_required_option");
  assert.match(result.receipt.error.hint, /Use ha daemon install-templates --out/u);
  assert.doesNotMatch(result.receipt.error.code, /journal/u);
});

test("unregistering an unknown repo id reports an honest unclassified failure, not a journal failure", () => {
  const result = runDaemonFailure(["daemon", "repo", "unregister", "--repo-id", "nonexistent-repo"]);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.error.code, "unclassified_command_failure");
  assert.match(result.receipt.error.hint, /not registered/u);
  assert.doesNotMatch(result.receipt.error.code, /journal/u);
});

function runDaemonFailure(args: ReadonlyArray<string>): {
  readonly status: number | null;
  readonly receipt: { readonly error: { readonly code: string; readonly hint: string } };
} {
  const result = spawnSync(process.execPath, [cliEntry, "--json", ...args], {
    encoding: "utf8",
    env: cliTestEnv({ HARNESS_DAEMON_MODE: "fixture" })
  });
  assert.equal(result.stderr, "");
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout) as { readonly error: { readonly code: string; readonly hint: string } }
  };
}
