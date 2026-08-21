// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { streamDaemonFacetAt } from "../../gui/src/main/agent-runtime-stream-client.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test("a caller that names a response deadline gets a classified failure instead of an open-ended silent socket", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "daemon-response-deadline-")), endpoint = localEndpoint(root, "quiet.sock");
  const server = net.createServer((socket) => { socket.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) { const request = JSON.parse(line) as { readonly id: number; readonly method: string };
    if (request.method === "protocol.hello") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`); } }); });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    const started = Date.now();
    await assert.rejects(() => requestDaemonJsonRpcAt(endpoint, "repo.task.run", {}, 2_000, 250), (error: unknown) => { assert.equal((error as { readonly code?: string }).code, "daemon_response_timeout"); return /did not answer repo\.task\.run within 0\.25s/u.test(String(error)); });
    assert.equal(Date.now() - started < 2_000, true, "the deadline must fire without waiting for the connect timeout");
    assert.deepEqual(await requestDaemonJsonRpcAt(endpoint, "protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000, 2_000), { ok: true });
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a silent protocol.hello is reported as a startup wedge, never as a long write holding the queue", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "daemon-hello-deadline-")), endpoint = path.join(root, "silent.sock");
  const server = net.createServer(() => { /* accepts connections but never answers */ });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    await assert.rejects(() => requestDaemonJsonRpcAt(endpoint, "repo.task.run", {}, 2_000, 250), (error: unknown) => {
      assert.equal((error as { readonly code?: string }).code, "daemon_response_timeout");
      assert.match(String(error), /did not answer protocol\.hello within 0\.25s/u);
      assert.match(String(error), /still starting \(repository attach\) or wedged during startup/u);
      assert.doesNotMatch(String(error), /long write is holding the workspace queue/u);
      return true;
    });
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("GUI S3 resident daemon bridge serves two RepoCells, catalog/runtime/control, secret rejection, and real PTY", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-s3-resident-")), userRoot = path.join(parent, "user"), alpha = path.join(parent, "alpha"), beta = path.join(parent, "beta"), endpoint = localEndpoint(parent, "daemon.sock"), executablePath = writeProviderExecutable(path.join(parent, "runtime-stub.mjs"), `if (process.argv[2] === "--version") console.log("resident-runtime-stub 1.0.0");\nprocess.exit(0);\n`), uid = process.getuid?.() ?? 0;
    initRepo(alpha, "alpha", uid); initRepo(beta, "beta", uid); registerDaemonRepo({ canonicalRoot: alpha, repoId: "alpha", userRoot, createConvenienceLinks: false }); registerDaemonRepo({ canonicalRoot: beta, repoId: "beta", userRoot, createConvenienceLinks: false });
    const locked = await openRepoCell({ repoId: workspaceId("beta"), rootDir: canonicalRoot(beta), ownerId: "other-daemon" });
    let launched: Record<string, unknown> | null = null; const host = await openDaemonHost({ daemonId: "gui-s3", userRoot, endpoint, runtimeDiscover: () => [{ installationId: "installation-codex", kindId: "codex", executablePath, version: "1.0.0", observedAt: "2026-08-14T00:00:00.000Z" }], runtimeLaunch: (prepared) => { launched = prepared as unknown as Record<string, unknown>; return { pid: 4242, onOutput: () => undefined, onErrorOutput: () => undefined, onExit: () => undefined, terminate: () => undefined }; } });
    await host.attachmentsSettled();
    const transport = createUnixSocketTransportServer({ daemonId: "gui-s3", socketPath: endpoint, createProtocolServer: (authContext, emit) => createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }) }); await transport.start();
    const rpc = (method: string, params: Record<string, unknown>) => requestDaemonJsonRpcAt(endpoint, method, params, 2_000);
    try {
      const initial = await rpc("daemon.gui.system.read", {}), rows = initial.repos as Array<Record<string, unknown>>, attached = rows.find((row) => row.repoId === "alpha");
      assert.equal(initial.schema, "gui-system-status/v1"); assert.equal(attached?.cellState, "attached"); assert.equal(attached?.queueDepth, 0); assert.equal(attached?.lockState, "held"); assert.equal(attached?.lastError, null);
      const unavailable = rows.find((row) => row.repoId === "beta"); assert.equal(unavailable?.cellState, "unavailable"); assert.equal(unavailable?.queueDepth, null); assert.equal(unavailable?.lockState, "unknown"); assert.equal(typeof unavailable?.unavailableReason, "string");
      const refresh = await rpc("daemon.gui.control.request", { payload: { kind: "refresh", authorityRepoId: "alpha", reason: "resident test" } }); assert.equal(refresh.outcome, "pending"); const firstSettled = await waitReceipt(rpc, String(refresh.operationId)); assert.equal(firstSettled.phase, "settled");
      const restart = await rpc("daemon.gui.control.request", { payload: { kind: "restart", authorityRepoId: "alpha" } }); assert.equal(restart.outcome, "op_rejected"); assert.equal((restart.error as Record<string, unknown>).code, "supervisor_required"); assert.equal(typeof restart.operationId, "string");
      await locked.close(); const retry = await rpc("daemon.gui.control.request", { payload: { kind: "refresh", authorityRepoId: "alpha" } }); await waitReceipt(rpc, String(retry.operationId)); const refreshed = await rpc("daemon.gui.system.read", {}); assert.equal((refreshed.repos as Array<Record<string, unknown>>).find((row) => row.repoId === "beta")?.cellState, "attached");

      const catalog = await rpc("repo.gui.catalog.snapshot", { repo: { repoId: "alpha" } }); assert.equal(catalog.schema, "gui-catalog-snapshot/v1"); assert.equal((catalog.presets as unknown[]).length, 12); const reread = await rpc("repo.gui.catalog.reread", { repo: { repoId: "alpha" }, payload: { expectedDigest: catalog.catalogDigest } }); assert.equal(reread.schema, "catalog-reread-receipt/v1"); assert.equal(reread.outcome, "applied"); assert.equal(reread.beforeDigest, catalog.catalogDigest); assert.equal(reread.afterDigest, catalog.catalogDigest);
      const created = await rpc("daemon.runtimeInstance.create", { payload: { instanceId: "resident-codex", name: "Resident Codex", kindId: "codex", installationId: "installation-codex", providerId: "openai", models: ["runtime-test-model"], authMode: "subscription" } }); assert.equal(created.outcome, "applied", JSON.stringify(created));
      const updated = await rpc("daemon.runtimeInstance.update", { payload: { instanceId: "resident-codex", models: ["runtime-test-model", "runtime-test-model-2"], defaultModel: "runtime-test-model-2" } }); assert.equal(updated.outcome, "applied", JSON.stringify(updated));
      const beforeSpawn = await rpc("repo.agentRuntime.overview", { repo: { repoId: "alpha" }, payload: {} }); assert.equal((beforeSpawn.instances as Array<Record<string, unknown>>)[0]?.instanceId, "resident-codex"); assert.deepEqual((beforeSpawn.instances as Array<Record<string, unknown>>)[0]?.models, ["runtime-test-model", "runtime-test-model-2"]); assert.doesNotMatch(JSON.stringify(beforeSpawn), /credentialRef|executablePath/iu);
      const spawnedRuntime = await rpc("repo.agentRuntime.spawn", { repo: { repoId: "alpha" }, payload: { runtimeInstanceId: "resident-codex", model: "runtime-test-model-2", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "resident-runtime" } }); assert.equal(spawnedRuntime.outcome, "applied"); const overview = await rpc("repo.agentRuntime.overview", { repo: { repoId: "alpha" }, payload: {} }), session = (overview.sessions as Array<Record<string, unknown>>).find((candidate) => candidate.runtimeSessionId === spawnedRuntime.runtimeSessionId); assert.equal(session?.instanceId, "resident-codex"); assert.equal((session?.definitionSnapshot as Record<string, unknown>).installationId, "installation-codex"); assert.equal((session?.definitionSnapshot as Record<string, unknown>).model, "runtime-test-model-2"); assert.equal(launched?.executablePath, executablePath); assert.deepEqual(launched?.args, ["exec", "--json", "--sandbox", "danger-full-access", "--model", "runtime-test-model-2", "-"]); assert.match(String((launched?.env as Record<string, unknown>).HOME), /runtime-instances\/resident-codex\/home$/u);
      const secretRejected = await rpc("repo.agentRuntime.spawn", { repo: { repoId: "alpha" }, payload: { runtimeInstanceId: "resident-codex", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "bad", nested: { apiToken: "must-not-cross" } } }); assert.equal(secretRejected.ok, false); assert.equal(secretRejected.code, "invalid_request"); assert.doesNotMatch(JSON.stringify(secretRejected), /must-not-cross/u);

      const terminal = await rpc("repo.terminal.spawn", { repo: { repoId: "alpha" }, payload: { idempotencyKey: "resident-pty", name: "Resident", cwd: { scope: "repo-root" }, shellProfileId: "default" } }); assert.equal(terminal.outcome, "applied", JSON.stringify(terminal)); const frames: Array<Record<string, unknown>> = []; let attachmentId = "";
      const detachStream = await streamDaemonFacetAt({ socketPath: endpoint, repoId: "alpha", method: "repo.terminal.attach", payload: { sessionId: terminal.sessionId as string, afterSeq: 0 }, timeoutMs: 2_000, onValue: (value) => { const frame = value as Record<string, unknown>; if (frame.schema === "terminal-attach/v1") attachmentId = String(frame.attachmentId); else frames.push(frame); } });
      assert.equal((await rpc("repo.terminal.resize", { repo: { repoId: "alpha" }, payload: { sessionId: terminal.sessionId, cols: 101, rows: 32 } })).state, "running");
      // `echo` is a shell builtin in both the POSIX profiles and PowerShell, so this
      // round-trip exercises the terminal bridge without depending on shell syntax.
      await rpc("repo.terminal.input", { repo: { repoId: "alpha" }, payload: { sessionId: terminal.sessionId, clientSeq: 1, utf8: "echo __S3_RESIDENT_PTY__\r" } }); await eventually(() => terminalOutput(frames).includes("__S3_RESIDENT_PTY__"));
      assert.equal((await rpc("repo.terminal.detach", { repo: { repoId: "alpha" }, payload: { sessionId: terminal.sessionId, attachmentId } })).state, "detached"); detachStream(); assert.equal((await rpc("repo.terminal.terminate", { repo: { repoId: "alpha" }, payload: { sessionId: terminal.sessionId, confirmed: true } })).state, "exited");
    } finally { await transport.stop(); await host.close(); await locked.close(); rmSync(parent, { recursive: true, force: true }); }
});

async function waitReceipt(rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, operationId: string): Promise<Record<string, unknown>> { for (let attempt = 0; attempt < 50; attempt += 1) { const receipt = await rpc("daemon.gui.control.receipt", { payload: { operationId } }); if (receipt.phase === "settled" || receipt.phase === "failed") return receipt; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`control receipt did not settle: ${operationId}`); }
async function eventually(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 50; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("resident PTY output did not arrive"); }
function terminalOutput(frames: readonly Record<string, unknown>[]): string { return frames.filter((frame) => frame.kind === "output" && typeof frame.utf8 === "string").map((frame) => frame.utf8).join(""); }
function localEndpoint(parent: string, name: string): string { return process.platform === "win32" ? `\\\\.\\pipe\\harness-anything-${process.pid}-${Date.now()}-${name}` : path.join(parent, name); }
function initRepo(root: string, repoId: string, uid: number): void { mkdirSync(path.join(root, "harness"), { recursive: true }); git(root, "init", "-q"); git(root, "config", "user.name", "S3 Resident"); git(root, "config", "user.email", "s3@example.invalid"); writeFileSync(path.join(root, "harness/harness.yaml"), `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`); writeFileSync(path.join(root, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write", "admin", "arbiter"] }] }, null, 2)}\n`); git(root, "add", "harness"); git(root, "commit", "-qm", "fixture"); }
function git(root: string, ...args: string[]): void { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); }
