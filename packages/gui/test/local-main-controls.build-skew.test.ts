// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { addLocalMainControls } from "../src/main/local-main-controls.ts";
import type { GuiServiceBridge } from "../src/api/service-bridge.ts";

type Daemon = { readonly build?: { readonly commitSha?: string | null } };
type Overlay = { readonly buildStale?: null | { readonly daemonCommit: string; readonly clientCommit: string } };

// The System page cannot compute the GUI's own commit, so main overlays the verdict on the daemon's
// system status: a daemon whose reported commit no longer matches this GUI's is the standing
// explanation for a plane full of schema rejections, and the overlay turns it into one sentence
// plus the existing restart control.
test("system status carries a build-skew verdict only when both commits are known and differ", async () => {
  const own = "0123456789abcdef0123456789abcdef01234567", staleCommit = "fedcba9876543210fedcba9876543210fedcba98";
  const target = async () => ({ repoId: "skew-repo", socketPath: "/dev/null", userRoot: "/tmp/ha-skew-user", daemonId: "skew" });
  const statusFor = async (daemon: Daemon): Promise<Overlay> => {
    const inner: GuiServiceBridge = { invoke: async () => ({ schema: "gui-system-status/v1", ok: true, observedAt: "2026-08-21T00:00:00.000Z", daemon: { daemonId: "skew", pid: 1, startedAt: "2026-08-21T00:00:00.000Z", ...daemon }, repos: [] }), stream: async () => () => undefined };
    const bridge = addLocalMainControls({ bridge: inner, target: target as never, clientBuildCommit: own });
    const status = await bridge.invoke("getSystemStatus", {}) as { readonly daemon: Overlay };
    return status.daemon;
  };
  const stale = await statusFor({ build: { commitSha: staleCommit } });
  assert.deepEqual(stale.buildStale, { daemonCommit: staleCommit, clientCommit: own }, "a differing daemon commit must surface the skew verdict");
  const matched = await statusFor({ build: { commitSha: own } });
  assert.equal(matched.buildStale, null, "a matching daemon commit must stay silent");
  const unknown = await statusFor({ build: { commitSha: null } });
  assert.equal(unknown.buildStale, null, "a daemon that cannot name its commit proves nothing and must stay silent");
  const legacy = await statusFor({});
  assert.equal(legacy.buildStale, null, "a pre-identity daemon reports no build object at all");
});
