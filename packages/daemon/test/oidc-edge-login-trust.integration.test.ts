// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OidcSessionService } from "../src/oidc-session-service.ts";

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
  const listener = certificate("keycloak"),
    wrong = certificate("other"),
    server = createServer(listener, (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url?.endsWith("/auth/device")
            ? {
                device_code: "private-device",
                user_code: "ABCD-EFGH",
                verification_uri: "https://localhost/realms/harness/device",
                expires_in: 600,
                interval: 5,
              }
            : request.url?.endsWith("/token")
              ? { access_token: "x.e30.x", refresh_token: "private-refresh", expires_in: 300, refresh_expires_in: 600 }
              : { sub: "person-one", harness_person_id: "person-one" },
        ),
      );
    });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let now = 0;
  const authority = {
      url: `https://localhost:${address.port}`,
      realm: "harness",
      clientId: "harness-node-one",
    },
    service = new OidcSessionService(root, { now: () => now });

  await assert.rejects(service.beginDevice(undefined, authority), /fetch failed/u);
  const accepted = await service.beginDevice(undefined, { ...authority, certificate: listener.cert });
  assert.equal(accepted.userCode, "ABCD-EFGH");
  now = 5_000;
  assert.equal(
    (await service.pollDevice()).authenticated,
    true,
    "userinfo must trust only the invitation certificate too",
  );
  await assert.rejects(service.beginDevice(undefined, { ...authority, certificate: wrong.cert }), /fetch failed/u);
});
