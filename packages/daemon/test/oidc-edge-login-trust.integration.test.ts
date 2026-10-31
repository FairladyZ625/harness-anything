// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createIdentitySession } from "../src/authorization-provider.ts";

test("edge device login trusts only the invitation's self-signed Keycloak certificate", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-login-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certificate = (name: string) => {
    const keyFile = path.join(root, `${name}.key`),
      certFile = path.join(root, `${name}.pem`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyFile), cert: readFileSync(certFile, "utf8") };
  };
  let tokenRequests = 0;
  const upstreamHosts = new Set<string>(),
    tlsServernames = new Set<string>();
  const listener = certificate("keycloak"),
    wrong = certificate("other"),
    defaultRoots: string[] = [],
    server = createServer(listener, (request, response) => {
      if (request.headers.host) upstreamHosts.add(request.headers.host);
      const servername = (request.socket as typeof request.socket & { readonly servername?: string }).servername;
      if (servername) tlsServernames.add(servername);
      if (request.url?.endsWith("/token")) tokenRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url?.endsWith("/.well-known/openid-configuration")
            ? { issuer: `https://${request.headers.host}/realms/harness` }
            : request.url?.endsWith("/auth/device")
              ? {
                  device_code: "private-device",
                  user_code: "ABCD-EFGH",
                  verification_uri: "https://localhost/realms/harness/device",
                  expires_in: 600,
                  interval: 5,
                }
              : request.url?.endsWith("/token")
                ? {
                    access_token: `x.${Buffer.from(JSON.stringify({ iss: `https://${request.headers.host}/realms/harness` })).toString("base64url")}.x`,
                    refresh_token: "private-refresh",
                    expires_in: 300,
                    refresh_expires_in: 600,
                  }
                : { sub: "person-one", harness_person_id: "person-one" },
        ),
      );
    });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let now = 0,
    managedVerificationUrl: string | undefined;
  const authority = {
      url: `https://localhost:${address.port}`,
      realm: "harness",
      clientId: "harness-node-one",
    },
    loginTarget = root,
    service = createIdentitySession(root, {
      now: () => now,
      defaultCaCertificates: () => defaultRoots,
      loginAuthority: async () => authority,
    });
  t.after(async () => {
    if (!managedVerificationUrl) return;
    now = Number.MAX_SAFE_INTEGER;
    await assert.rejects(service.pollDevice(), { code: "oidc_device_expired" });
  });

  await assert.rejects(service.beginDevice(loginTarget, authority), /fetch failed/u);
  await assert.rejects(
    service.beginDevice(loginTarget, {
      ...authority,
      url: `https://127.0.0.1:${address.port}`,
      certificate: listener.cert,
    }),
    /fetch failed/u,
    "an invitation CA does not bypass listener hostname verification",
  );
  const accepted = await service.beginDevice(loginTarget, {
    ...authority,
    browserUrl: authority.url,
    certificate: listener.cert,
  });
  assert.equal(accepted.userCode, "ABCD-EFGH");
  managedVerificationUrl = String(accepted.managedVerificationUri);
  const managedPage = await fetch(managedVerificationUrl);
  assert.equal(managedPage.status, 200);
  assert.ok(upstreamHosts.has(`localhost:${address.port}`), "the gateway preserves the issuer Host authority");
  assert.ok(tlsServernames.has("localhost"), "the gateway preserves the issuer TLS server name");
  now = 5_000;
  assert.equal(
    (await service.pollDevice()).authenticated,
    true,
    "userinfo must trust only the invitation certificate too",
  );
  managedVerificationUrl = undefined;
  await assert.rejects(fetch(String(accepted.managedVerificationUri)), /fetch failed/u);
  now = 280_000;
  assert.equal(
    (await service.status(loginTarget)).authenticated,
    true,
    "a private-CA session renews without environment CA setup",
  );
  assert.equal(tokenRequests, 2, "device exchange and refresh both use the invitation CA");
  await assert.rejects(service.beginDevice(loginTarget, { ...authority, certificate: wrong.cert }), /fetch failed/u);

  defaultRoots.push(listener.cert);
  const publicTrustLogin = await service.beginDevice(loginTarget, authority);
  assert.equal(publicTrustLogin.pending, true, "a system-trusted listener works with no invite CA");
  now = 285_000;
  assert.equal((await service.pollDevice()).authenticated, true);
  now = 560_000;
  assert.equal((await service.status(loginTarget)).authenticated, true, "a no-CA session renews through system trust");
  assert.equal(tokenRequests, 4, "the public-trust login and its refresh use no invite CA");
});
