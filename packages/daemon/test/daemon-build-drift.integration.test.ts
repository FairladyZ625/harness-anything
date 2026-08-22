// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" } } as const;

test("a dist rebuild is observable while the daemon keeps serving and its runtime stays alive", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-build-drift-status-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), runtimeRoot = path.join(parent, "runtime"), runtimeFile = builtRuntime(runtimeRoot, "build-a"), buildId = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"), repoId = "build-drift-status";
  const installation = { installationId: "installation-build-drift", kindId: "codex" as const, executablePath: writeProviderExecutable(path.join(parent, "codex-build-drift"), "process.exit(0);\n"), version: "1.0.0", observedAt: "2026-08-22T00:00:00.000Z" };
  rosterRepo(rootDir, repoId); registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  let terminations = 0;
  const host = await openDaemonHost({ daemonId: repoId, userRoot, runtimeFile, runtimeDiscover: () => [installation], runtimeLaunch: () => ({ pid: 4242, onOutput: () => undefined, onErrorOutput: () => undefined, onExit: () => undefined, terminate: () => { terminations += 1; } }) }); await host.attachmentsSettled();
  try {
    host.runtimeInstance("daemon.runtimeInstance.create", { instanceId: "build-drift-worker", name: "Build drift worker", kindId: "codex", installationId: installation.installationId, providerId: "openai", models: ["test-model"], authMode: "subscription" }, auth);
    const worker = await host.spawnRuntime(repoId, { runtimeInstanceId: "build-drift-worker", cwd: { scope: "repo-root" }, prompt: "Keep running across the dist rebuild.", taskId: null, idempotencyKey: "build-drift-worker" }, auth);
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const matched = host.status();
    assert.deepEqual(matched.build, { ...matched.build, loadedBuildId: "build-a", diskBuildId: "build-a", drifted: false });
    assert.doesNotMatch(matched.summary, /build drift/u);

    writeFileSync(buildId, "build-b\n");
    const drifted = host.status();
    assert.equal(drifted.pid, matched.pid, "observing a rebuild must not replace the daemon process");
    assert.deepEqual(drifted.build, { ...drifted.build, loadedBuildId: "build-a", diskBuildId: "build-b", drifted: true });
    assert.match(drifted.summary, /build drift.*build-a.*build-b.*ha daemon stop.*next command.*autostart/iu);
    assert.equal((await host.run(repoId, { kind: "task-create", taskId: "task_after_rebuild", title: "Still served" }, auth)).outcome, "applied");
    assert.equal(terminations, 0, "a rebuild must not terminate an in-flight runtime");

    writeFileSync(buildId, "build-a\n");
    const restored = host.status();
    assert.deepEqual(restored.build, { ...restored.build, loadedBuildId: "build-a", diskBuildId: "build-a", drifted: false });
    assert.doesNotMatch(restored.summary, /build drift/u);
  } finally { await host.close(); rmSync(parent, { recursive: true, force: true }); }
});

function builtRuntime(runtimeRoot: string, buildId: string): string {
  const runtimeFile = path.join(runtimeRoot, "packages/cli/dist/daemon/src/runtime.js"), marker = path.join(runtimeRoot, "packages/cli/dist/build-id.txt");
  for (const [file, body] of [[runtimeFile, "runtime\n"], [marker, `${buildId}\n`]] as const) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
  return runtimeFile;
}
function rosterRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true }); git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Build Drift Test"); git(rootDir, "config", "user.email", "build-drift@example.invalid"); git(rootDir, "config", "gc.auto", "0"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base"); mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`);
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "writer", displayName: "writer", roles: ["writer"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(process.getuid?.() ?? 0) }] }], roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }] }, null, 2)}\n`);
  git(rootDir, "add", "harness"); git(rootDir, "commit", "--quiet", "-m", "add roster fixture");
}
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
