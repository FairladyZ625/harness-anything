// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");

test("real CLI performs machine runtime instance CRUD through an isolated resident daemon", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-cli-")), userRoot = path.join(root, "user"), env = { ...process.env, HOME: path.join(root, "home"), HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "runtime-instance-test" };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const initial = run(root, env, ["runtime", "instance", "list"]), installations = initial.installations as Array<{ installationId: string; kindId: "claude" | "codex"; version: string }>;
    assert.equal(installations.length > 0, true, JSON.stringify(initial)); const installation = installations.find(({ kindId }) => kindId === "codex") ?? installations[0]!;
    const created = run(root, env, ["runtime", "instance", "create", "--id", "cli-isolated", "--name", "CLI Isolated", "--kind", installation.kindId, "--installation", installation.installationId, "--provider", installation.kindId === "codex" ? "openai" : "anthropic", "--model", "runtime-test-model", "--base-url", "https://gateway.example.test/v1", "--auth", "api-key", "--credential-ref", "keychain:harness/cli-isolated"]);
    assert.equal((created.instance as Record<string, unknown>).isolationState, "enforced");
    const shown = run(root, env, ["runtime", "instance", "show", "cli-isolated"]), listed = run(root, env, ["runtime", "instance", "list"]);
    assert.deepEqual(shown.instance, created.instance); assert.equal((listed.instances as Array<Record<string, unknown>>).length, 1);
    for (const receipt of [created, shown, listed]) assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath/u);
    const target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", "cli-isolated"); assert.equal(statSync(target).mode & 0o777, 0o600); for (const directory of [stateRoot, "home", "tmp", "run"].map((entry) => entry === stateRoot ? entry : path.join(stateRoot, entry))) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    assert.equal(run(root, env, ["runtime", "instance", "delete", "cli-isolated"]).deletedInstanceId, "cli-isolated"); assert.equal(existsSync(stateRoot), false);
    const missing = runMaybe(root, env, ["runtime", "instance", "show", "cli-isolated"]); assert.notEqual(missing.status, 0); assert.equal((missing.receipt.error as Record<string, unknown>).code, "runtime_instance_not_found");
  } finally { runMaybe(root, env, ["daemon", "stop"]); rmSync(root, { recursive: true, force: true }); }
});

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> { const result = runMaybe(root, env, args); assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function runMaybe(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): { readonly status: number | null; readonly receipt: Record<string, unknown>; readonly stderr: string } { const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env }); return { status: result.status, receipt: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {}, stderr: result.stderr }; }
