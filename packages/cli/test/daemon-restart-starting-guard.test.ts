// harness-test-tier: fast
// PLT-Honest: 'ha daemon restart' on a still-starting daemon is the exact
// action that killed the user's recovering daemon today. This test proves the
// guard refuses restart when the endpoint is owned by a live process that is
// not yet serving status, and that the refusal message does not instruct the
// operator to restart.
import assert from "node:assert/strict";
import test from "node:test";
import { runDaemonControl } from "../src/commands/daemon/control.ts";
import type { DaemonControlLifecycle } from "../src/commands/daemon/control-replacement.ts";

const controlTarget = {
  repoId: "canonical",
  canonicalRoot: "/repo",
  userRoot: "/user-root",
  daemonId: "default",
  socketPath: "/user-root/daemon.sock",
  legacySocketPath: "/repo/legacy.sock",
  registered: true
} as const;

function baseInput(overrides: { readonly lifecycle: Partial<DaemonControlLifecycle> }): Parameters<typeof runDaemonControl>[0] {
  return {
    rootDir: "/repo",
    args: ["restart"],
    daemonEntryPath: () => "/repo/packages/cli/src/index.ts",
    requestDaemonControl: async () => {
      throw new Error("restart RPC must not be issued when the guard refuses");
    },
    daemonControlLifecycle: {
      target: controlTarget,
      probeStatus: async () => undefined,
      ownerIsAlive: () => true,
      startReplacement: async () => {
        throw new Error("replacement must not start when the guard refuses");
      },
      wait: async () => undefined,
      ...overrides.lifecycle
    } as DaemonControlLifecycle
  };
}

test("restart is refused when a live owner is not yet serving status (still starting)", async () => {
  await assert.rejects(
    runDaemonControl(baseInput({
      lifecycle: {
        probeEndpointOwner: () => ({ pid: 4242, alive: true }),
        probeStatus: async () => undefined, // not reachable = still starting
        ownerIsAlive: () => true
      }
    }), "restart"),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /DAEMON_RESTART_REFUSED_STARTING/u);
      assert.match(message, /pid 4242/u);
      assert.match(message, /60-90s/u, "must set the honest cold-start expectation");
      assert.match(message, /Do NOT restart/u, "must prohibit the lethal action");
      assert.match(message, /ha daemon status --json/u, "must steer to wait + poll");
      assert.match(message, /ha daemon stop/u, "must offer a deliberate stop as the force path");
      return true;
    }
  );
});

test("restart proceeds when the live owner is already serving status (honestly ready)", async () => {
  // When status is reachable, the daemon is ready and restart is the
  // operator's informed choice — the guard must NOT refuse.
  let rpcIssued = false;
  const result = await runDaemonControl({
    ...baseInput({
      lifecycle: {
        probeEndpointOwner: () => ({ pid: 4242, alive: true }),
        probeStatus: async () => ({ ok: true }), // reachable = ready
        ownerIsAlive: () => true
      }
    }),
    requestDaemonControl: async () => {
      rpcIssued = true;
      throw new Error("accepted-then-short-circuit");
    }
  }, "restart").catch((error: unknown) => error);
  assert.equal(rpcIssued, true, "restart RPC must be issued when the daemon is ready");
  assert.ok(result instanceof Error, "test short-circuits after the guard passes");
});

test("restart proceeds when no owner can be determined (no false refusal)", async () => {
  // Best-effort: if ownership is unknown, the guard must not silently refuse a
  // legitimate restart. Silently refusing is its own dishonesty.
  let rpcIssued = false;
  await runDaemonControl({
    ...baseInput({
      lifecycle: {
        probeEndpointOwner: () => undefined, // unknown ownership
        probeStatus: async () => undefined,
        ownerIsAlive: () => false
      }
    }),
    requestDaemonControl: async () => {
      rpcIssued = true;
      throw new Error("short-circuit-after-guard");
    }
  }, "restart").catch(() => undefined);
  assert.equal(rpcIssued, true, "guard must not refuse when ownership is unknown");
});
