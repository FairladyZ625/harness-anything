// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OidcSessionService } from "../src/oidc-session-service.ts";

test("Device login without verification_uri_complete keeps secrets private and binds the person after pending/slow-down", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  const calls: Request[] = [];
  let now = 0,
    polls = 0;
  const notices: unknown[] = [];
  const service = new OidcSessionService(root, {
    loginAuthority: async () => ({ url: "http://127.0.0.1:8080", realm: "harness", clientId: "harness-node-one" }),
    reportDevice: async (_target, notice) => {
      notices.push(notice);
    },
    now: () => now,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (String(input).endsWith("/auth/device"))
        return Response.json({
          device_code: "private-device",
          user_code: "ABCD-EFGH",
          verification_uri: "http://127.0.0.1:8080/realms/harness/device",
          expires_in: 600,
          interval: 5,
        });
      if (String(input).endsWith("/revoke")) return new Response(null, { status: 200 });
      if (String(input).endsWith("/userinfo"))
        return Response.json({ sub: "human-subject", harness_person_id: "person-a" });
      polls++;
      if (polls < 3)
        return Response.json({ error: polls === 1 ? "authorization_pending" : "slow_down" }, { status: 400 });
      return Response.json({
        access_token: `x.${Buffer.from("{}").toString("base64url")}.x`,
        refresh_token: "private-refresh",
        expires_in: 300,
        refresh_expires_in: 21_600,
      });
    }) as typeof fetch,
  });
  const begun = await service.beginDevice("edge-root");
  assert.equal(begun.userCode, "ABCD-EFGH");
  assert.deepEqual(notices, [{ userCode: "ABCD-EFGH", createdAt: 0, expiresAt: 600_000, pending: true }]);
  assert.equal(JSON.stringify(begun).includes("private-device"), false);
  const request = new URLSearchParams(await calls[0]!.text());
  assert.equal(request.get("code_challenge_method"), "S256");
  assert.equal(request.get("scope"), "openid profile email offline_access");
  assert.ok(request.get("code_challenge"));
  assert.equal((await service.pollDevice()).pending, true);
  assert.equal(polls, 0, "do not poll before the provider interval");
  now = 5_000;
  assert.equal((await service.pollDevice()).pending, true);
  now = 10_000;
  assert.equal((await service.pollDevice()).interval, 10);
  now = 20_000;
  const completed = await service.pollDevice();
  assert.equal(completed.personId, "person-a");
  assert.equal(completed.authenticated, true);
  assert.deepEqual(notices.at(-1), { userCode: "ABCD-EFGH", createdAt: 0, expiresAt: 600_000, pending: false });
  assert.equal(JSON.stringify(notices).includes("private-device"), false);
  assert.equal(JSON.stringify(completed).includes("private-refresh"), false);
  assert.equal((await service.bind({ transportKind: "unix-socket" })).oidcPrincipal?.personId, "person-a");
  assert.deepEqual(await service.logout(), { ok: true, authenticated: false });
  assert.equal(calls.at(-1)?.url.endsWith("/revoke"), true);
  assert.equal((await service.status()).authenticated, false);
});

test("invited login authority supplies a request-scoped TLS CA", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-ca-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  let dispatcher: unknown,
    userInfoDispatcher: unknown,
    bindingDispatcher: unknown,
    logoutDispatcher: unknown,
    now = 0,
    tokenRequests = 0;
  const certificate = "-----BEGIN CERTIFICATE-----\\npublic-test-ca\\n-----END CERTIFICATE-----\\n";
  const service = new OidcSessionService(root, {
    now: () => now,
    loginAuthority: async () => authority,
    fetch: (async (input, init) => {
      dispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      const url = String(input);
      if (url.endsWith("/userinfo")) userInfoDispatcher = dispatcher;
      if (url.endsWith("/realms/harness")) bindingDispatcher = dispatcher;
      if (url.endsWith("/revoke")) logoutDispatcher = dispatcher;
      if (url.endsWith("/auth/device"))
        return Response.json({
          device_code: "private-device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://identity.example.test/realms/harness/device",
          expires_in: 600,
          interval: 5,
        });
      if (url.endsWith("/userinfo")) return Response.json({ sub: "person-one", harness_person_id: "person-one" });
      tokenRequests++;
      return Response.json({
        access_token: "x.e30.x",
        refresh_token: `refresh-${tokenRequests}`,
        expires_in: 60,
        refresh_expires_in: 600,
      });
    }) as typeof fetch,
  });
  const authority = {
    url: "https://identity.example.test",
    realm: "harness",
    clientId: "harness-node-one",
    certificate,
  };
  await service.beginDevice(undefined, authority);
  assert.ok(dispatcher, "the authority certificate is supplied through a request-scoped TLS dispatcher");
  now = 5_000;
  await service.pollDevice();
  assert.ok(userInfoDispatcher, "userinfo uses the invitation authority's request-scoped CA");
  const issued = JSON.parse(readFileSync(path.join(root, "rbac/oidc-session.json"), "utf8"));
  assert.deepEqual(issued.authority, {
    url: authority.url,
    realm: authority.realm,
    clientId: authority.clientId,
    certificate,
  });
  now = 36_000;
  await service.status();
  assert.equal(tokenRequests, 2, "the refresh request uses the persisted invited authority");
  await service.bindingHealth("edge-root");
  assert.ok(bindingDispatcher, "authority discovery uses the invitation's request-scoped CA");
  await service.logout();
  assert.ok(logoutDispatcher, "logout uses the session authority's request-scoped CA");
});

test("SSH device authorization uses the loopback login endpoint and hands the browser to the canonical center URL", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-ssh-browser-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests: string[] = [],
    dispatchers: unknown[] = [],
    service = new OidcSessionService(root, {
      now: () => 0,
      fetch: (async (input, init) => {
        requests.push(String(input));
        dispatchers.push((init as RequestInit & { dispatcher?: unknown }).dispatcher);
        return Response.json({
          device_code: "private-device",
          user_code: "SSH-CODE",
          verification_uri: "https://127.0.0.1:41232/realms/harness/device",
          expires_in: 600,
          interval: 5,
        });
      }) as typeof fetch,
    });

  const begun = await service.beginDevice(undefined, {
    url: "https://127.0.0.1:41232",
    servername: "login.center.example",
    browserUrl: "https://login.center.example:18544",
    realm: "harness",
    clientId: "harness-node-edge",
    certificate: "public test CA",
  });

  assert.deepEqual(requests, ["https://127.0.0.1:41232/realms/harness/protocol/openid-connect/auth/device"]);
  assert.ok(dispatchers[0], "the loopback request still uses the invitation TLS authority");
  assert.equal(begun.verificationUri, "https://login.center.example:18544/realms/harness/device?user_code=SSH-CODE");
  assert.equal(JSON.stringify(begun).includes("private-device"), false);
});

test("device login survives transient transport loss and replaces a code invalidated by Keycloak restart", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  let now = 0,
    deviceRequests = 0,
    tokenRequests = 0;
  const notices: unknown[] = [],
    cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    service = new OidcSessionService(root, {
      now: () => now,
      loginAuthority: async () => ({
        url: "https://identity.example.test",
        realm: "harness",
        clientId: "harness-node-one",
      }),
      reportDevice: async (_target, notice) => {
        notices.push(notice);
      },
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith("/auth/device")) {
          const serial = ++deviceRequests;
          return Response.json({
            device_code: `private-device-${serial}`,
            user_code: `CODE-${serial}`,
            verification_uri: "https://identity.example.test/realms/harness/device",
            expires_in: 600,
            interval: 1,
          });
        }
        if (url.endsWith("/token")) {
          tokenRequests += 1;
          if (tokenRequests === 1) throw new TypeError("fetch failed", { cause });
          if (tokenRequests === 2) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({
            access_token: "x.e30.x",
            refresh_token: "private-refresh",
            expires_in: 300,
            refresh_expires_in: 21_600,
          });
        }
        assert.ok(url.endsWith("/userinfo"));
        return Response.json({ sub: "person-one", harness_person_id: "person-one" });
      }) as typeof fetch,
    }),
    authority = {
      url: "https://identity.example.test",
      realm: "harness",
      clientId: "harness-node-one",
    };

  const begun = await service.beginDevice("edge-root", authority);
  now = 1_000;
  await assert.rejects(service.pollDevice(), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, "oidc_device_transport_unavailable");
    assert.match(String((error as Error).cause), /read ECONNRESET/u);
    return true;
  });
  now = 2_000;
  const renewed = await service.pollDevice();
  assert.equal(renewed.pending, true);
  assert.equal(renewed.userCode, "CODE-2");
  assert.equal(renewed.expiresAt, begun.expiresAt, "recovery stays inside the first device-code deadline");
  assert.deepEqual(notices, [
    { userCode: "CODE-1", createdAt: 0, expiresAt: 600_000, pending: true },
    { userCode: "CODE-1", createdAt: 0, expiresAt: 600_000, pending: false },
    { userCode: "CODE-2", createdAt: 2_000, expiresAt: 600_000, pending: true },
  ]);
  now = 3_000;
  const accepted = await service.pollDevice();
  assert.equal(accepted.authenticated, true);
  assert.equal(accepted.personId, "person-one");
  assert.equal(tokenRequests, 3);
});

test("device authorization signs in as harness-gui even when the rbac config names the resource server", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-login-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A managed install writes the resource server into config.clientId; the login client stays harness-gui.
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness", clientId: "harness-center" }),
  );
  let deviceRequest: URLSearchParams | undefined;
  const service = new OidcSessionService(root, {
    now: () => 0,
    fetch: (async (input, init) => {
      if (String(input).endsWith("/auth/device")) {
        deviceRequest = new URLSearchParams(String(init?.body));
        return Response.json({
          device_code: "private-device",
          user_code: "ABCD-EFGH",
          verification_uri: "http://127.0.0.1:8080/realms/harness/device",
          expires_in: 600,
          interval: 5,
        });
      }
      throw new Error(`unexpected request ${String(input)}`);
    }) as typeof fetch,
  });
  await service.beginDevice();
  assert.equal(deviceRequest?.get("client_id"), "harness-gui");
});

test("first device authorization reports an unreachable authority with the same code as polling", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-device-begin-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8443"), { code: "ECONNREFUSED" });
  const service = new OidcSessionService(root, {
    now: () => 0,
    fetch: (async () => {
      throw new TypeError("fetch failed", { cause });
    }) as typeof fetch,
  });
  await assert.rejects(
    service.beginDevice("edge-root", {
      url: "https://identity.example.test",
      realm: "harness",
      clientId: "harness-node-one",
    }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, "oidc_device_transport_unavailable");
      assert.match(String((error as Error).cause), /ECONNREFUSED/u);
      return true;
    },
  );
});
