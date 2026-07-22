// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readDaemonStatusWithGenerationFallback } from "../src/commands/daemon/status-compatibility.ts";

test("generation-aware status falls back to legacy parameters when an old daemon rejects the capability field", async () => {
  const attempts: boolean[] = [];
  const status = await readDaemonStatusWithGenerationFallback(true, async (includeAxes) => {
    attempts.push(includeAxes);
    if (includeAxes) return { ok: false, error: { code: "invalid_daemon_status_request" } };
    return { ok: true, details: { data: legacyStatus() } };
  });

  assert.deepEqual(attempts, [true, false]);
  assert.equal((status?.service as Record<string, unknown>).started, true);
});

test("generation-aware status keeps a capable daemon on the single capability request", async () => {
  const attempts: boolean[] = [];
  const status = await readDaemonStatusWithGenerationFallback(true, async (includeAxes) => {
    attempts.push(includeAxes);
    return {
      ok: true,
      details: { data: { ...legacyStatus(), service: { ...legacyStatus().service, machineId: "machine-a", daemonGeneration: 7 } } }
    };
  });

  assert.deepEqual(attempts, [true]);
  assert.equal((status?.service as Record<string, unknown>).machineId, "machine-a");
  assert.equal((status?.service as Record<string, unknown>).daemonGeneration, 7);
});

function legacyStatus(): { readonly schema: string; readonly service: Record<string, unknown> } {
  return { schema: "daemon-status/v2", service: { started: true, pid: 42 } };
}
