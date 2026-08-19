// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("packages/cli/src/index.ts");

// The provider fixture models the real interactive shape: `login` prompts on the terminal and
// waits for the person to type a token before writing credentials into the isolated CODEX_HOME,
// `login status` answers readiness from that state root, and `exec` produces provider output.
// The test only ever types a fixture token through the same relay a human operator would use.
test("real CLI signs in interactively, refreshes through login, runs real provider work, signs out, and rejects mode mismatches", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-cli-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), binRoot = path.join(parent, "bin"), version = "0.0.0-runtime-auth-cli-fixture";
  mkdirSync(root, { recursive: true }); mkdirSync(binRoot, { recursive: true }); writeProvider(path.join(binRoot, "codex"), version);
  const env = { ...process.env, HOME: path.join(parent, "home"), PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "runtime-auth-cli-test" }, authFile = path.join(userRoot, "runtime-instances", "cli-worker", "home", ".codex", "auth.json");
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true); run(root, env, ["init", "--repo-id", "runtime-auth-cli", "--person-id", "owner", "--display-name", "Owner"]);
    const inventory = run(root, env, ["runtime", "instance", "list"]), installation = (inventory.installations as Array<Record<string, unknown>>).find((row) => row.kindId === "codex" && row.version === `codex ${version}`); assert.ok(installation, JSON.stringify(inventory));
    const create = ["runtime", "instance", "create", "--id", "cli-worker", "--name", "CLI Worker", "--kind", "codex", "--installation", String(installation.installationId), "--provider", "openai", "--model", "runtime-test-model", "--auth"], apiCreate = ["runtime", "instance", "create", "--id", "cli-keyed", "--name", "CLI Keyed", "--kind", "codex", "--installation", String(installation.installationId), "--provider", "openai", "--model", "runtime-test-model", "--auth"];
    run(root, env, [...create, "subscription"]); run(root, env, [...apiCreate, "api-key", "--credential-ref", "keychain:harness/cli-keyed"]);
    const blocked = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "too early", "--no-stream"]); assert.notEqual(blocked.status, 0); assert.equal((blocked.receipt.error as Record<string, unknown>).code, "runtime_subscription_required");
    const login = await runInteractive(root, env, ["runtime", "instance", "login", "cli-worker"], "first-operator-token\n"); assert.equal(login.status, 0, login.stderr); assert.equal((login.receipt as Record<string, unknown>).exitCode, 0); assert.match(String((login.receipt as Record<string, unknown>).sessionId), /^terminal_/u); assert.match(login.stderr, /Paste the operator sign-in token:[\s\S]*Signed in as first-operator-token\./u); assert.equal(JSON.stringify(login.receipt).includes("first-operator-token"), false);
    assert.equal(JSON.parse(readFileSync(authFile, "utf8")).token, "first-operator-token");
    const first = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "hello provider", "--no-stream"]); assert.equal((first.result as Record<string, unknown>).text, "final:hello provider");
    const refreshed = await runInteractive(root, env, ["runtime", "instance", "login", "cli-worker", "--idempotency-key", "login-refresh-once"], "second-operator-token\n"); assert.equal(refreshed.status, 0, refreshed.stderr); assert.equal(JSON.parse(readFileSync(authFile, "utf8")).token, "second-operator-token");
    const second = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "after login refresh", "--no-stream"]); assert.equal((second.result as Record<string, unknown>).text, "final:after login refresh");
    const mismatch = runMaybe(root, env, ["runtime", "instance", "login", "cli-keyed"]); assert.notEqual(mismatch.status, 0); assert.equal((mismatch.receipt.error as Record<string, unknown>).code, "runtime_auth_mode_mismatch");
    const logout = await runInteractive(root, env, ["runtime", "instance", "logout", "cli-worker"], ""); assert.equal(logout.status, 0, logout.stderr); assert.equal((logout.receipt as Record<string, unknown>).exitCode, 0); assert.match(logout.stderr, /Signed out\./u);
    const blockedAgain = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "after logout", "--no-stream"]); assert.notEqual(blockedAgain.status, 0); assert.equal((blockedAgain.receipt.error as Record<string, unknown>).code, "runtime_subscription_required");
    for (const receipt of [run(root, env, ["runtime", "instance", "list"]), run(root, env, ["runtime", "instance", "show", "cli-worker"])]) assert.equal(JSON.stringify(receipt).includes("operator-token"), false);
  } finally { runMaybe(root, env, ["daemon", "stop"]); rmSync(parent, { recursive: true, force: true }); }
});

async function runInteractive(root: string, env: NodeJS.ProcessEnv, args: readonly string[], input: string): Promise<{ readonly status: number | null; readonly receipt: Record<string, unknown>; readonly stderr: string }> {
  const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  if (input) child.stdin.write(input);
  const [status] = await new Promise<[number | null]>((resolve) => child.once("close", (code) => resolve([code])));
  return { status, receipt: stdout.trim() ? JSON.parse(stdout) as Record<string, unknown> : {}, stderr };
}
function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> { const result = runMaybe(root, env, args); assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`); return result.receipt; }
function runMaybe(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): { readonly status: number | null; receipt: Record<string, unknown>; readonly stderr: string } { const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env }); return { status: result.status, receipt: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {}, stderr: result.stderr }; }
function writeProvider(target: string, version: string): void { writeFileSync(target, `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst authFile = (process.env.CODEX_HOME ?? "") + "/auth.json";\nif (args[0] === "--version") { console.log("codex ${version}"); process.exit(0); }\nif (args[0] === "login" && args[1] === "status") process.exit(fs.existsSync(authFile) ? 0 : 1);\nif (args[0] === "logout") { if (fs.existsSync(authFile)) fs.unlinkSync(authFile); console.log("Signed out."); process.exit(0); }\nif (args[0] === "login") { console.log("Paste the operator sign-in token:"); let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; if (!buffer.includes("\\n")) return; const token = buffer.trim(); fs.mkdirSync(process.env.CODEX_HOME ?? "", { recursive: true }); fs.writeFileSync(authFile, JSON.stringify({ token })); console.log("Signed in as " + token + "."); process.exit(0); }); process.stdin.resume(); return; }\nconst prompt = fs.readFileSync(0, "utf8");\nconst session = "provider-cli-session";\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: session }));\nconsole.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "live:" + prompt } }));\nconsole.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } }));\nconsole.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "final:" + prompt } }));\nconsole.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));\n`, { mode: 0o755 }); }
