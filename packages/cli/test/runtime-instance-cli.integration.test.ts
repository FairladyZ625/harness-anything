// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");

test("real CLI performs machine runtime instance CRUD through an isolated resident daemon", () => {
  // Runtime installations are witnessed by scanning PATH for `claude`/`codex`, so the
  // fixture puts its own on PATH: asserting that some runtime happens to be installed
  // would assert a property of the host, which is false on every clean machine.
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-cli-")), userRoot = path.join(root, "user"), binRoot = path.join(root, "bin"), fixtureVersion = "0.0.0-runtime-instance-fixture";
  mkdirSync(binRoot, { recursive: true }); for (const kind of ["claude", "codex"] as const) writeFileSync(path.join(binRoot, kind), `#!/bin/sh\necho "${kind} ${fixtureVersion}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(root, "home"), PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "runtime-instance-test" };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const initial = run(root, env, ["runtime", "instance", "list"]), installations = initial.installations as Array<{ installationId: string; kindId: "claude" | "codex"; version: string }>;
    const installation = installations.find(({ kindId, version }) => kindId === "codex" && version === `codex ${fixtureVersion}`); assert.ok(installation, JSON.stringify(initial));
    const created = run(root, env, ["runtime", "instance", "create", "--id", "cli-isolated", "--name", "CLI Isolated", "--kind", installation.kindId, "--installation", installation.installationId, "--provider", installation.kindId === "codex" ? "openai" : "anthropic", "--model", "runtime-test-model", "--base-url", "https://gateway.example.test/v1", "--auth", "api-key", "--credential-ref", "keychain:harness/cli-isolated"]);
    assert.equal((created.instance as Record<string, unknown>).isolationState, "enforced");
    const shown = run(root, env, ["runtime", "instance", "show", "cli-isolated"]), probed = run(root, env, ["runtime", "instance", "show", "cli-isolated", "--probe"]), listed = run(root, env, ["runtime", "instance", "list"]);
    assert.deepEqual(shown.instance, created.instance); assert.equal((listed.instances as Array<Record<string, unknown>>).length, 1);
    assert.equal(((probed.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status, "not-ready"); assert.equal(listed.summary, "ID\tNAME\tKIND\tMODEL\tAUTH MODE\tLOGIN STATUS\ncli-isolated\tCLI Isolated\tcodex\truntime-test-model\tapi-key\tnot-ready");
    for (const receipt of [created, shown, probed, listed]) assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath/u);
    const target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", "cli-isolated"); assert.equal(statSync(target).mode & 0o777, 0o600); for (const directory of [stateRoot, "home", "tmp", "run"].map((entry) => entry === stateRoot ? entry : path.join(stateRoot, entry))) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    assert.equal(run(root, env, ["runtime", "instance", "delete", "cli-isolated"]).deletedInstanceId, "cli-isolated"); assert.equal(existsSync(stateRoot), false);
    const missing = runMaybe(root, env, ["runtime", "instance", "show", "cli-isolated"]); assert.notEqual(missing.status, 0); assert.equal((missing.receipt.error as Record<string, unknown>).code, "runtime_instance_not_found");
  } finally { runMaybe(root, env, ["daemon", "stop"]); rmSync(root, { recursive: true, force: true }); }
});

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> { const result = runMaybe(root, env, args); assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function runMaybe(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): { readonly status: number | null; readonly receipt: Record<string, unknown>; readonly stderr: string } { const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env }); return { status: result.status, receipt: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {}, stderr: result.stderr }; }
