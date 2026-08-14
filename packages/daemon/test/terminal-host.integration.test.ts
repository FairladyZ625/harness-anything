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
