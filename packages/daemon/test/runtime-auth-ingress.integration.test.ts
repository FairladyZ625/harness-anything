// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// The provider stub models an interactive CLI: `login` prompts on the terminal, waits for the
// person to type a token, and only then writes credentials into the isolated CODEX_HOME; the
// readiness probe (`login status`) answers from that same state root. No credential ever exists
// outside the stub's own prompted flow and its isolated state root.
const stubBody = `const fs = require("node:fs");
const args = process.argv.slice(2);
const authFile = (process.env.CODEX_HOME ?? "") + "/auth.json";
if (args[0] === "login" && args[1] === "status") process.exit(fs.existsSync(authFile) ? 0 : 1);
if (args[0] === "logout") { if (fs.existsSync(authFile)) fs.unlinkSync(authFile); console.log("Signed out."); process.exit(0); }
if (args[0] === "login") {
  console.log("Paste the operator sign-in token:");
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { buffer += chunk; if (!buffer.includes("\\n")) return; const token = buffer.trim(); fs.mkdirSync(process.env.CODEX_HOME ?? "", { recursive: true }); fs.writeFileSync(authFile, JSON.stringify({ token })); console.log("Signed in as " + token + "."); process.exit(0); });
  process.stdin.resume();
  return;
}
process.exit(9);
`;
test("daemon ingress spawns interactive sign-in terminals on the isolated state root", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-ingress-")), root = path.join(parent, "repo"), userRoot = path.join(parent, "user"), executablePath = writeProviderExecutable(path.join(parent, "codex-signin-stub"), stubBody), repoId = "runtime-auth-ingress", uid = 4321;
  const installation: RuntimeInstallationWitness = { installationId: "installation-codex-signin", kindId: "codex", executablePath, version: "1.0.0", observedAt: "2026-08-19T00:00:00.000Z" };
  initIngressRepo(root, uid); registerDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" } } as const;
  const host = await openDaemonHost({ daemonId: "runtime-auth-ingress", userRoot, runtimeDiscover: () => [installation], runtimeEnv: { HOME: path.join(parent, "operator-home"), PATH: process.env.PATH ?? "" } });
  const stateRoot = path.join(userRoot, "runtime-instances", "codex-signin"), authFile = path.join(stateRoot, "home", ".codex", "auth.json");
  try {
    host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: "codex-signin", name: "Codex Sign-in", kindId: "codex", installationId: installation.installationId, providerId: "openai", models: ["gpt-5.6-sol"], authMode: "subscription" }, auth);
    host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: "codex-keyed", name: "Codex Keyed", kindId: "codex", installationId: installation.installationId, providerId: "openai", models: ["gpt-5.6-sol"], authMode: "api-key", credentialRef: "credential:v1:codex-keyed" }, auth);
    await t.test("before sign-in the readiness probe reports the subscription gap", async () => {
      const shown = await rpc(host, auth, "daemon.runtimeInstance.show", { payload: { instanceId: "codex-signin", probe: true } });
      assert.deepEqual((shown.instance as Record<string, unknown>).authReadiness, { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." });
    });
    await t.test("api-key instances cannot use provider-native sign-in and unknown operations are refused", async () => {
      const mismatch = await rpc(host, auth, "repo.runtimeInstance.auth.login", { repo: { repoId }, payload: { instanceId: "codex-keyed", idempotencyKey: "keyed-login-once" } });
      assert.equal(mismatch.ok, false); assert.equal(mismatch.code, "runtime_auth_mode_mismatch");
      await assert.rejects(host.runtimeInstanceAuth(repoId, "repo.runtimeInstance.auth.reauth", { instanceId: "codex-signin", idempotencyKey: "reauth-once" }, auth), (error: unknown) => error instanceof Error && "code" in error && error.code === "unsupported_command");
    });
    for (const [idempotencyKey, token] of [["login-first-once", "first-operator-token"], ["login-refresh-once", "second-operator-token"]] as const) {
      await t.test("login runs the prompted flow on a daemon-owned PTY", async () => {
        const spawned = await rpc(host, auth, "repo.runtimeInstance.auth.login", { repo: { repoId }, payload: { instanceId: "codex-signin", idempotencyKey } });
        assert.equal(spawned.ok, true, JSON.stringify(spawned)); assert.equal(spawned.outcome, "applied"); assert.match(String(spawned.sessionId), /^terminal_/u); assert.equal(spawned.state, "running");
        assert.equal(JSON.stringify(spawned).includes(token), false);
        const replay = await rpc(host, auth, "repo.runtimeInstance.auth.login", { repo: { repoId }, payload: { instanceId: "codex-signin", idempotencyKey } });
        assert.equal(replay.sessionId, spawned.sessionId);
        const frames: Record<string, unknown>[] = [], attached = await rpcTerminalAttach(host, auth, repoId, String(spawned.sessionId), frames);
        try { await eventually(async () => terminalOutput(frames).includes("Paste the operator sign-in token:"));
          const ack = await rpc(host, auth, "repo.terminal.input", { repo: { repoId }, payload: { sessionId: spawned.sessionId, clientSeq: 1, utf8: `${token}\n` } });
          assert.equal(ack.ok, true);
          await eventually(async () => terminalOutput(frames).includes(`Signed in as ${token}.`));
          await eventually(async () => frames.some((frame) => frame.kind === "exit"));
        } finally { attached.close(); }
        assert.equal(JSON.parse(readFileSync(authFile, "utf8")).token, token);
        const shown = await rpc(host, auth, "daemon.runtimeInstance.show", { payload: { instanceId: "codex-signin", probe: true } });
        assert.deepEqual((shown.instance as Record<string, unknown>).authReadiness, { status: "ready", code: null, hint: null });
      });
    }
    await t.test("logout clears the isolated credentials and readiness reverts", async () => {
      const spawned = await rpc(host, auth, "repo.runtimeInstance.auth.logout", { repo: { repoId }, payload: { instanceId: "codex-signin", idempotencyKey: "logout-once" } });
      assert.equal(spawned.ok, true, JSON.stringify(spawned));
      const frames: Record<string, unknown>[] = [], attached = await rpcTerminalAttach(host, auth, repoId, String(spawned.sessionId), frames);
      try { await eventually(async () => frames.some((frame) => frame.kind === "exit")); } finally { attached.close(); }
      assert.equal(terminalOutput(frames).includes("Signed out."), true);
      const shown = await rpc(host, auth, "daemon.runtimeInstance.show", { payload: { instanceId: "codex-signin", probe: true } });
      assert.equal(((shown.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).code, "runtime_subscription_required");
    });
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});
function initIngressRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true }); git(root, "init", "-q"); git(root, "config", "user.name", "Sign-in Test"); git(root, "config", "user.email", "signin@example.invalid");
  writeFileSync(path.join(root, "harness/harness.yaml"), "schema: harness-anything/v1\nname: runtime-auth-ingress\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  writeFileSync(path.join(root, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`);
  git(root, "add", "harness"); git(root, "commit", "-qm", "fixture");
}
async function rpc(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: auth, emit: async () => undefined });
  try { await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method, params }); assert.ok(response && !Array.isArray(response) && "result" in response); return (response as { result: Record<string, unknown> }).result; }
  finally { server.close(); }
}
async function rpcTerminalAttach(host: Awaited<ReturnType<typeof openDaemonHost>>, auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2], repoId: string, sessionId: string, frames: Record<string, unknown>[]): Promise<{ readonly close: () => void }> {
  const server = createJsonRpcProtocolServer({ host, build: { commit: null }, authContext: auth, emit: async (_method, params) => { frames.push(params); } });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } }); const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.terminal.attach", params: { repo: { repoId }, payload: { sessionId, afterSeq: 0 } } }); assert.ok(response && !Array.isArray(response) && "result" in response); assert.equal((response as { result: { ok: boolean } }).result.ok, true, JSON.stringify(response)); return { close: server.close };
}
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> { for (let attempt = 0; attempt < 300; attempt += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("terminal frame did not arrive"); }
function terminalOutput(frames: readonly Record<string, unknown>[]): string { return frames.filter((frame) => frame.kind === "output" && typeof frame.utf8 === "string").map((frame) => frame.utf8).join(""); }
function git(root: string, ...args: readonly string[]): void { execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"] }); }
