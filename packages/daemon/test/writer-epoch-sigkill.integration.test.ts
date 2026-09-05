// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test(
  "writer epoch acquisition recovers when its prior holder dies before publishing",
  { skip: process.platform === "win32" ? "requires POSIX SIGKILL semantics" : false },
  (context) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-writer-epoch-sigkill-")),
      fixture = path.resolve("packages/daemon/test/writer-epoch-process.fixture.mjs"),
      source = path.resolve("packages/daemon/src/writer-epoch.ts"),
      run = (arm: string) =>
        spawnSync(process.execPath, [fixture, source, root, arm], {
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
        });
    try {
      const killed = run("kill-before-publish");
      assert.equal(killed.error, undefined, killed.stderr);
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      assert.match(killed.stdout, /exclusive-acquired-before-publish/u);

      const startedAt = performance.now(),
        recovered = run("acquire"),
        elapsedMs = performance.now() - startedAt;
      context.diagnostic(
        JSON.stringify({
          schema: "writer-epoch-sigkill-result/v1",
          killedSignal: killed.signal,
          recoveryStatus: recovered.status,
          recoverySignal: recovered.signal,
          recoveryError: recovered.error?.code ?? null,
          elapsedMs: Number(elapsedMs.toFixed(1)),
        }),
      );
      assert.equal(recovered.error, undefined, recovered.stderr);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(JSON.parse(recovered.stdout.trim()), { epoch: 1, holderId: "recovery" });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
