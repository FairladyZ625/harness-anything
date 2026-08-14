// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openTerminalHost } from "../src/terminal-host.ts";

test("daemon terminal host spawns, echoes, attaches, resizes, detaches, and terminates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-"));
    try {
    const host = openTerminalHost({ repoId: "repo-a", rootDir: root, daemonGeneration: 7 });
    const spawned = host.spawn({ idempotencyKey: "terminal-test", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Test" });
    assert.equal(spawned.ok, true);
    const attached = host.attach(spawned.sessionId!, 0);
    assert.match(String(attached.initial.status), /attached|gap/u);
    assert.equal(host.resize({ sessionId: spawned.sessionId!, cols: 100, rows: 31 }).state, "running");
    assert.equal(host.input({ sessionId: spawned.sessionId!, clientSeq: 1, utf8: "printf '__HA_PTY_OK__\\n'\n" }).acceptedThrough, 1);
    let output = "";
    for (let attempts = 0; attempts < 20 && !output.includes("__HA_PTY_OK__"); attempts += 1) {
      const frame = await Promise.race([attached.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (frame?.kind === "output") output += String(frame.utf8);
    }
    assert.match(output, /__HA_PTY_OK__/u);
    assert.equal(host.detach({ sessionId: spawned.sessionId!, attachmentId: attached.initial.attachmentId as string }).state, "detached");
    assert.equal(host.terminate({ sessionId: spawned.sessionId!, confirmed: true }).state, "exited");
    await host.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted runtime auth terminal executes an exact non-platform fixture without exposing its launch spec", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-terminal-"));
  try {
    let data: ((value: string) => void) | undefined, launch: { readonly file: string; readonly args: readonly string[]; readonly options: Record<string, unknown> } | undefined;
    const fakePty = { onData: (listener: (value: string) => void) => { data = listener; return { dispose: () => undefined }; }, onExit: () => ({ dispose: () => undefined }), write: () => undefined, resize: () => undefined, kill: () => undefined };
    const host = openTerminalHost({ repoId: "repo-a", rootDir: root, daemonGeneration: 8, spawnPty: ((file: string, args: readonly string[], options: Record<string, unknown>) => { launch = { file, args, options }; return fakePty; }) as never });
    const spawned = host.spawnTrusted({ idempotencyKey: "runtime-auth", name: "Codex Review · Sign in", executablePath: process.execPath, args: ["-e", "process.stdout.write(process.env.RUNTIME_AUTH_MARKER ?? 'missing')"], env: { PATH: process.env.PATH ?? "", RUNTIME_AUTH_MARKER: "AUTH_STUB_OK" }, cwd: root, publicCwd: "runtime-instance:codex-review", profile: "runtime-auth" });
    assert.equal(spawned.ok, true); assert.deepEqual(launch, { file: process.execPath, args: ["-e", "process.stdout.write(process.env.RUNTIME_AUTH_MARKER ?? 'missing')"], options: { name: "xterm-256color", cols: 80, rows: 24, cwd: root, env: { PATH: process.env.PATH ?? "", RUNTIME_AUTH_MARKER: "AUTH_STUB_OK", TERM: "xterm-256color" } } }); const attached = host.attach(spawned.sessionId!, 0); data?.("AUTH_STUB_OK"); const frame = await attached.next(); assert.equal(frame?.utf8, "AUTH_STUB_OK");
    const listed = JSON.stringify(host.list()); assert.match(listed, /runtime-instance:codex-review/u); assert.doesNotMatch(listed, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")); assert.doesNotMatch(listed, /RUNTIME_AUTH_MARKER/u); await host.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
