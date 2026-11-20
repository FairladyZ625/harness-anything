// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { openDeviceConfirmationGateway } from "@harness-anything/authorization/keycloak";

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
      {
        systemCaCertificates: () => [],
        fetchWithTlsCa: (fetcher, _ca, input, init) => fetcher(input, init),
      },
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

test("device confirmation gateway rewrites SameSite=None to SameSite=Lax while stripping Secure and Domain", async (t) => {
  const gateway = await openDeviceConfirmationGateway(
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
    (async () => {
      const headers = new Headers({ "content-type": "text/html" });
      headers.append("set-cookie", "AUTH_SESSION_ID=one; Path=/realms/harness/; Secure; HttpOnly; SameSite=None");
      headers.append(
        "set-cookie",
        "KC_RESTART=token; Domain=center.example; Path=/realms/harness/; Max-Age=300; Secure; HttpOnly; samesite=none",
      );
      headers.append("set-cookie", "KC_AUTH_SESSION_HASH=hash; Path=/; Secure;SameSite=None;HttpOnly");
      headers.append("set-cookie", "KEEP_LAX=1; Path=/; Secure; SameSite=Lax");
      headers.append("set-cookie", "KEEP_STRICT=1; Path=/; Secure; SameSite=Strict");
      return new Response("ok", { status: 200, headers });
    }) as typeof fetch,
    {
      systemCaCertificates: () => [],
      fetchWithTlsCa: (fetcher, _ca, input, init) => fetcher(input, init),
    },
  );
  t.after(() => gateway.close());

  const response = await fetch(gateway.verificationUri, { redirect: "manual" });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();

  const authSession = cookies.find((value) => value.startsWith("AUTH_SESSION_ID=")) ?? "";
  assert.match(authSession, /Path=\/realms\/harness\//u);
  assert.match(authSession, /HttpOnly/u);
  assert.match(authSession, /;\s*SameSite=Lax(?:;|$)/u);
  assert.doesNotMatch(authSession, /Domain=|Secure|SameSite=None/iu);

  const kcRestart = cookies.find((value) => value.startsWith("KC_RESTART=")) ?? "";
  assert.match(kcRestart, /Path=\/realms\/harness\//u);
  assert.match(kcRestart, /Max-Age=300/u);
  assert.match(kcRestart, /HttpOnly/u);
  assert.match(kcRestart, /;\s*SameSite=Lax(?:;|$)/u);
  assert.doesNotMatch(kcRestart, /Domain=|Secure|SameSite=None/iu);

  const kcHash = cookies.find((value) => value.startsWith("KC_AUTH_SESSION_HASH=")) ?? "";
  assert.match(kcHash, /Path=\//u);
  assert.match(kcHash, /HttpOnly/u);
  assert.match(kcHash, /;SameSite=Lax;/u);
  assert.doesNotMatch(kcHash, /Domain=|Secure|SameSite=None/iu);

  const keepLax = cookies.find((value) => value.startsWith("KEEP_LAX=")) ?? "";
  assert.match(keepLax, /;\s*SameSite=Lax$/u);
  assert.doesNotMatch(keepLax, /Secure/iu);

  const keepStrict = cookies.find((value) => value.startsWith("KEEP_STRICT=")) ?? "";
  assert.match(keepStrict, /;\s*SameSite=Strict$/u);
  assert.doesNotMatch(keepStrict, /Secure/iu);
});
