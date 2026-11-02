// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, ownedByRuntimeSpawner } from "../src/runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeBinding } from "../src/runtime-spawn-types.ts";

const owner = { nodeId: "node-one" };
const binding = (source: RuntimeBinding["source"]): RuntimeBinding => ({
  actor: { principal: { personId: "owner" } },
  source,
});
test("edge spawner owns exactly its authenticated node", () => {
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), owner), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner, nodeId: "node-two" }), owner), false);
  assert.equal(ownedByRuntimeSpawner(binding("local"), owner), false);
});
test("local spawner owns only local dispatches on restart", () => {
  assert.equal(ownedByRuntimeSpawner(binding("local"), undefined), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), undefined), false);
});

for (const source of ["local", { kind: "node", nodeId: "request-origin" }] as const) {
  test(`local recovery replays an exited DeepSeek host's terminal stream (source=${typeof source === "string" ? source : "node"})`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-node-origin-recovery-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const dispatchId = "dispatch_333333333333333333333333",
      runtimeSessionId = "runtime-node-origin",
      dispatchBinding = binding(source),
      stream = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: null,
        executionId: null,
        instanceId: "deepseek-worker",
        startedAt: "2026-11-02T07:00:00.000Z",
        dispatchOpId: dispatchId,
        kindId: "deepseek-harness",
        permissionMode: "bypass",
        cwd: rootDir,
        binding: dispatchBinding,
        prompt: "recover the exited worker",
        model: "deepseek-v4.1-flash",
        reasoningEffort: null,
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    const body =
        "Review was not registered. Runtime archive publication failed: Writer session token resolver is unavailable",
      sha256 = createHash("sha256").update(body).digest("hex");
    stream.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId,
          outcome: "failed",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${sha256}`,
          result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
        },
        body,
        reason: "Review was not registered before reviewer settlement.",
        processGroupPid: 2_147_483_647,
      },
      "2026-11-02T07:01:00.000Z",
    );
    const settled: string[] = [],
      context = {
        input: { rootDir, now: () => "2026-11-02T08:00:00.000Z" },
        processes: new Map(),
        exiting: new Set(),
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [
            {
              runtimeSessionId,
              instanceId: "deepseek-worker",
              providerSessionId: null,
              liveness: "live",
              outcome: null,
            },
          ],
          readRuntimeDispatch: () => ({ ...dispatchBinding, payload: { dispatchId } }),
        }),
        publishExit: async (active: { runtimeSessionId: string; process: { release?: () => void } }) => {
          settled.push(active.runtimeSessionId);
          active.process.release?.();
          context.processes.delete(active.runtimeSessionId);
        },
        runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      } as unknown as RuntimeSpawnerContext;
    const result = await adoptRuntimes(context);
    assert.deepEqual(settled, [runtimeSessionId], `recovery result: ${JSON.stringify(result)}`);
    assert.equal(context.processes.size, 0);
  });
}

test("recovery preserves a live DeepSeek worker already registered by this local spawner", async () => {
  const runtimeSessionId = "runtime-live-deepseek",
    active = { process: { pid: process.pid } },
    context = {
      input: { rootDir: tmpdir() },
      processes: new Map([[runtimeSessionId, active]]),
      exiting: new Set(),
      ownsModelSlot: () => true,
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [
          { runtimeSessionId, instanceId: "deepseek-worker", providerSessionId: null, liveness: "live", outcome: null },
        ],
        readRuntimeDispatch: () => {
          throw new Error("a registered launch must keep its existing owner");
        },
      }),
      publishExit: () => {
        throw new Error("a live worker must not be settled");
      },
    } as unknown as RuntimeSpawnerContext;
  assert.equal((await adoptRuntimes(context))[0]?.outcome, "ready");
  assert.equal(context.processes.get(runtimeSessionId), active);
});
