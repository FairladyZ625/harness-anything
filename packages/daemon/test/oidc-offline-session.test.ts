// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { OidcSessionService, type OidcSessionPorts } from "../src/oidc-session-service.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";

// dec_F01770FD0DCF72683B7C4C7A47/CH6: the provider owns offline idle expiration.
function offlineFixture(refreshExpiresIn: number) {
  let stored: string | undefined;
  const state = { now: Date.now(), reachable: true, revoked: false, refreshes: 0, serial: 0 };
  const authority = { url: "http://127.0.0.1:8080", realm: "isolated", clientId: "harness-node-a" };
  const issue = () =>
    Response.json({
      access_token: `x.${Buffer.from(JSON.stringify({ serial: ++state.serial })).toString("base64url")}.x`,
      refresh_token: `refresh-${state.serial}`,
      expires_in: 60,
      refresh_expires_in: refreshExpiresIn,
      scope: "openid profile email offline_access",
    });
  const ports: Partial<OidcSessionPorts> = {
    now: () => state.now,
    loginAuthority: async () => authority,
    reportDevice: async () => {},
    sessionStore: {
      read: () => stored,
      write: (value) => {
        stored = value;
      },
      delete: () => {
        stored = undefined;
      },
      retireBootstrap: () => {},
    },
    fetch: async (input, init) => {
      if (String(input).endsWith("/auth/device"))
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "http://127.0.0.1:8080/device",
          expires_in: 600,
          interval: 1,
        });
      if (String(input).endsWith("/userinfo")) return Response.json({ sub: "user-a", harness_person_id: "person-a" });
      const form = init?.body as URLSearchParams;
      if (form.get("grant_type") !== "refresh_token") return issue();
      state.refreshes++;
      if (!state.reachable) throw new TypeError("isolated provider unavailable");
      assert.equal(form.get("refresh_token"), `refresh-${state.serial}`, "persist the rotated refresh token");
      if (state.revoked) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return issue();
    },
  };
  const open = () => new OidcSessionService("/unused-offline-test-root", ports);
  return { state, open, store: ports.sessionStore! };
}

for (const refreshExpiresIn of [0, 60]) {
  test(`offline token with refresh_expires_in=${refreshExpiresIn} survives restart and renews once for concurrent uses`, async () => {
    const fixture = offlineFixture(refreshExpiresIn),
      first = fixture.open();
    await first.beginDevice("/unused-offline-test-edge");
    fixture.state.now += 1_000;
    const login = await first.pollDevice();
    assert.equal(login.authenticated, true);
    assert.equal(login.expiresAt, null);
    assert.equal(JSON.stringify(login).includes("refresh-"), false);
    const restarted = fixture.open();
    fixture.state.now += 86_400_000;
    const [status, binding] = await Promise.all([restarted.status(), restarted.bind({ transportKind: "unix-socket" })]);
    assert.equal(status.authenticated, true);
    assert.equal(status.expiresAt, null);
    assert.equal(binding.oidcPrincipal?.subject, "user-a");
    assert.equal(fixture.state.refreshes, 1);
    fixture.state.now += 60_000;
    assert.equal((await restarted.status()).authenticated, true);
    assert.equal(fixture.state.refreshes, 2);
  });
}

test("offline network failure preserves credentials and only admits an explicitly selected replica read; provider rejection clears them", async () => {
  const fixture = offlineFixture(0),
    service = fixture.open();
  await service.beginDevice("/unused-offline-test-edge");
  fixture.state.now += 1_000;
  await service.pollDevice();
  fixture.state.now += 60_000;
  fixture.state.reachable = false;
  const before = fixture.store.read();
  await assert.rejects(service.status(), { code: "oidc_session_unavailable" });
  assert.equal(fixture.store.read(), before);
  const online = await service.bind({ transportKind: "unix-socket" });
  assert.equal(online.oidcPrincipal, undefined);
  assert.equal(online.replicaReadPrincipal, undefined);
  const offline = await service.bind({ transportKind: "unix-socket" }, true);
  assert.equal(localDefaultBinding(offline, null, true).actor.principal.personId, "person-a");
  assert.throws(() => localDefaultBinding(offline), { code: "authentication_required" });
  fixture.state.reachable = true;
  fixture.state.revoked = true;
  assert.equal((await service.status()).authenticated, false);
  assert.equal(fixture.store.read(), undefined);
  const refreshes = fixture.state.refreshes;
  assert.equal((await service.status()).authenticated, false);
  assert.equal(fixture.state.refreshes, refreshes, "do not retry a rejected refresh token");
});
