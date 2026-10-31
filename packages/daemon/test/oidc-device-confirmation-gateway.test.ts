// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { openDeviceConfirmationGateway } from "../src/oidc-device-confirmation-gateway.ts";

test("device confirmation gateway keeps the browser on a managed loopback origin", async (t) => {
  const calls: { url: string; headers: Headers; body?: BodyInit | null }[] = [],
    gateway = await openDeviceConfirmationGateway(
      {
        url: "https://127.0.0.1:56506",
        browserUrl: "https://center.example:8443",
        servername: "center.example",
        realm: "harness",
        clientId: "harness-node-edge",
        certificate: "test-ca",
      },
      "https://center.example:8443/realms/harness/device?user_code=CODE",
      60_000,
      (async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body });
        return new Response('<a href="https://center.example:8443/realms/harness/device">continue</a>', {
          status: 302,
          headers: {
            location: "https://center.example:8443/realms/harness/device/verify",
            "content-type": "text/html",
            "content-security-policy": "form-action 'self' https://center.example:8443",
            "set-cookie": "AUTH_SESSION_ID=one; Domain=center.example; Path=/; Secure; HttpOnly",
          },
        });
      }) as typeof fetch,
    );
  t.after(() => gateway.close());
  const page = new URL(gateway.verificationUri),
    response = await fetch(page, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")!).origin, page.origin);
  assert.equal(response.headers.get("content-security-policy"), `form-action 'self' ${page.origin}`);
  assert.equal((await response.text()).includes("center.example:8443"), false);
  const upstreamCookie = response.headers.getSetCookie().find((value) => value.startsWith("AUTH_SESSION_ID="));
  assert.match(upstreamCookie ?? "", /Path=\//u);
  assert.doesNotMatch(upstreamCookie ?? "", /Domain=|Secure/u);
  assert.equal(calls[0]?.url, "https://127.0.0.1:56506/realms/harness/device?user_code=CODE");
  assert.equal(calls[0]?.headers.get("host"), "center.example:8443");
  assert.equal(calls[0]?.headers.get("accept-encoding"), "identity");
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("harness-gateway="))
    ?.split(";", 1)[0];
  assert.ok(cookie);
  await fetch(`${page.origin}/realms/harness/device/verify`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: page.origin,
      cookie: `${cookie}; AUTH_SESSION_ID=one`,
    },
    body: "username=person&password=secret",
  });
  assert.equal(calls[1]?.headers.get("origin"), "https://center.example:8443");
  assert.equal(calls[1]?.headers.get("cookie"), `${cookie}; AUTH_SESSION_ID=one`);
  assert.equal(Buffer.from(calls[1]?.body as Buffer).toString(), "username=person&password=secret");
  assert.equal(
    await fetch(`${page.origin}/realms/harness/device`).then((result) => result.status),
    403,
    "a request without the one-shot capability is refused",
  );
});
