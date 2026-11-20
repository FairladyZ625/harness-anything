// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IdentitySessionPort, OidcLoginAuthority } from "@harness-anything/kernel";
import { BuiltinIdentitySession } from "../../src/builtin/index.ts";

test("builtin edge sessions delegate device login, transient poll retries, and bind before fleet-edge.json exists", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-edge-delegate-")),
    edgeTarget = path.join(root, "edge-repo"),
    override: OidcLoginAuthority = {
      url: "https://center.example.test:8443",
      realm: "harness",
      clientId: "harness-gui",
      certificate: "stub-cert",
    };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(edgeTarget, { recursive: true });

  const isolated = new BuiltinIdentitySession(root);
  await assert.rejects(isolated.beginDevice(edgeTarget, override), { code: "identity_plugin_required" });

  let polls = 0;
  const calls: string[] = [];
  const externalStub: IdentitySessionPort = {
    begin: async () => ({ ok: true }),
    complete: async () => ({ ok: true }),
    beginDevice: async (loginTarget, authority) => {
      calls.push(`beginDevice:${loginTarget}:${authority?.url}`);
      return { ok: true, pending: true, userCode: "EDGE-1" };
    },
    deviceApproval: async (userCode, loginTarget) => {
      calls.push(`deviceApproval:${userCode}:${loginTarget}`);
      return { ok: true, pending: true, approved: false };
    },
    pollDevice: async () => {
      polls += 1;
      calls.push(`pollDevice:${polls}`);
      if (polls === 1)
        throw Object.assign(new Error("Temporary transport blip"), { code: "oidc_device_transport_unavailable" });
      if (polls === 2) return { ok: true, pending: true, interval: 1 };
      return { ok: true, authenticated: true, personId: "person-edge" };
    },
    status: async () => ({ ok: true, authenticated: true }),
    bindingHealth: async () => ({ ok: true }),
    logout: async () => ({ ok: true, authenticated: false }),
    bootstrapStatus: async () => ({ ok: true, required: false }),
    interactiveAuthority: async () => override,
    configured: () => true,
    centerConfigured: () => false,
    bind: async (auth, loginTarget) => {
      calls.push(`bind:${loginTarget}`);
      return {
        ...auth,
        oidcPrincipal: {
          provider: (await isolated.center()).provider,
          personId: "person-edge",
          subject: "edge-sub",
          expiresAt: Date.now() + 60_000,
          accessToken: "edge-token",
          authority: override,
        },
      };
    },
    discovery: () => null,
    requireAccessManagement: async () => {
      throw new Error("unused");
    },
    requireSession: async () => {
      throw new Error("unused");
    },
    serialize: (op) => op(),
    configureAuthority: (op) => op(),
    center: async () => {
      throw new Error("unused");
    },
    bootstrapAdmin: async () => {
      throw new Error("unused");
    },
    invite: async () => {
      throw new Error("unused");
    },
    revokeDeviceSessions: async () => undefined,
  };

  const session = new BuiltinIdentitySession(root, undefined, externalStub);
  assert.equal((await session.beginDevice(edgeTarget, override)).userCode, "EDGE-1");
  await assert.rejects(session.pollDevice(), { code: "oidc_device_transport_unavailable" });
  assert.equal((await session.pollDevice()).pending, true);
  assert.equal((await session.deviceApproval("EDGE-1", edgeTarget)).pending, true);
  assert.equal((await session.pollDevice()).authenticated, true);
  const bound = await session.bind({ transportKind: "unix-socket" }, edgeTarget);
  assert.equal(bound.oidcPrincipal?.personId, "person-edge");
  assert.deepEqual(calls, [
    `beginDevice:${edgeTarget}:https://center.example.test:8443`,
    "pollDevice:1",
    "pollDevice:2",
    `deviceApproval:EDGE-1:${edgeTarget}`,
    "pollDevice:3",
    `bind:${edgeTarget}`,
  ]);
});
