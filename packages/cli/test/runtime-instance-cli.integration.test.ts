// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("real CLI performs machine runtime instance CRUD through an isolated resident daemon", () => {
  // Runtime installations are witnessed by scanning PATH for `claude`/`codex`, so the
  // fixture puts its own on PATH: asserting that some runtime happens to be installed
  // would assert a property of the host, which is false on every clean machine.
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-cli-")), userRoot = path.join(root, "user"), binRoot = path.join(root, "bin"), fixtureVersion = "0.0.0-runtime-instance-fixture";
  mkdirSync(binRoot, { recursive: true }); for (const kind of ["claude", "codex"] as const) writeProviderExecutable(path.join(binRoot, kind), `console.log("${kind} ${fixtureVersion}");\n`);
  const env = { ...process.env, HOME: path.join(root, "home"), PATH: [binRoot, ...(process.env.PATH ?? "").split(path.delimiter).filter((entry) => ["codex", "codex.cmd", "codex.exe"].every((name) => !existsSync(path.join(entry, name))))].join(path.delimiter), HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "runtime-instance-test" };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const initial = run(root, env, ["runtime", "instance", "list"]), installations = initial.installations as Array<{ installationId: string; kindId: "claude" | "codex"; version: string }>;
    const installation = installations.find(({ kindId, version }) => kindId === "codex" && version === `codex ${fixtureVersion}`); assert.ok(installation, JSON.stringify(initial));
    const created = run(root, env, ["runtime", "instance", "create", "--id", "cli-isolated", "--name", "CLI Isolated", "--kind", installation.kindId, "--provider", "codex_local_access", "--model", "runtime-test-model", "--effort", "high", "--base-url", "http://127.0.0.1:1/v1", "--wire-api", "responses", "--requires-openai-auth", "--http-header", "X-Harness-Probe=present", "--auth", "api-key", "--credential-ref", "keychain:harness/cli-isolated"]);
    assert.equal((created.instance as Record<string, unknown>).isolationState, "enforced");
    const shown = run(root, env, ["runtime", "instance", "show", "cli-isolated"]), probed = run(root, env, ["runtime", "instance", "show", "cli-isolated", "--probe"]), listed = run(root, env, ["runtime", "instance", "list"]);
    assert.deepEqual(shown.instance, created.instance); assert.deepEqual((shown.instance as Record<string, unknown>).codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", baseUrlConfigured: true, wire_api: "responses", requires_openai_auth: true, http_headers: { "X-Harness-Probe": "present" } }); assert.equal((listed.instances as Array<Record<string, unknown>>).length, 1);
    assert.equal(((probed.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status, "not-ready"); assert.match(String(listed.summary), /INSTALLATION\tKIND\tVERSION\tOBSERVED AT/u); assert.match(String(listed.summary), new RegExp(String(installation.installationId), "u"));
    for (const receipt of [created, shown, probed, listed]) assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath/u);
    const target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", "cli-isolated"), codexConfig = path.join(stateRoot, "home", ".codex", "config.toml"); assert.equal(statSync(target).mode & 0o777, 0o600); for (const directory of [stateRoot, "home", "tmp", "run"].map((entry) => entry === stateRoot ? entry : path.join(stateRoot, entry))) assert.equal(statSync(directory).mode & 0o777, 0o700, directory); const persisted = readFileSync(codexConfig, "utf8"); assert.match(persisted, /wire_api = "responses"/u); assert.match(persisted, /requires_openai_auth = true/u); assert.match(persisted, /http_headers = \{ "X-Harness-Probe" = "present" \}/u); assert.doesNotMatch(`${readFileSync(target, "utf8")}\n${persisted}`, /Bearer |instance-secret|OPENAI_API_KEY/u);
    assert.equal(run(root, env, ["runtime", "instance", "delete", "cli-isolated"]).deletedInstanceId, "cli-isolated"); assert.equal(existsSync(stateRoot), false);
    const missing = runMaybe(root, env, ["runtime", "instance", "show", "cli-isolated"]); assert.notEqual(missing.status, 0); assert.equal((missing.receipt.error as Record<string, unknown>).code, "runtime_instance_not_found");
  } finally { runMaybe(root, env, ["daemon", "stop"]); rmSync(root, { recursive: true, force: true }); }
});

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> { const result = runMaybe(root, env, args); assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function runMaybe(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): { readonly status: number | null; readonly receipt: Record<string, unknown>; readonly stderr: string } { const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env }); return { status: result.status, receipt: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {}, stderr: result.stderr }; }
