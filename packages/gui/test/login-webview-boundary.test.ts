// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import {
  createLoginWebviewGrants,
  isAllowedLoginRequest,
  resolveLoginListenerTrust,
} from "../src/main/login-webview-boundary.ts";

// Public certificate fixtures only; the signing keys were discarded on generation.
const fixtures = path.join(import.meta.dirname, "fixtures"),
  leaf = readFileSync(path.join(fixtures, "login-listener-leaf.pem"), "utf8"),
  other = readFileSync(path.join(fixtures, "login-other.pem"), "utf8"),
  leafFingerprint = new X509Certificate(leaf).fingerprint256,
  authorizationUrl = "https://10.211.55.2:18544/realms/harness/protocol/openid-connect/auth",
  callbackOrigin = "http://127.0.0.1:53142";
const listener = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: "10.211.55.2",
  hostname: "10.211.55.2",
  port: 18544,
  certificateFile: path.join(fixtures, "login-listener-leaf.pem"),
  ...overrides,
});
const resolve = (url: string, listenerReply: unknown, readCertificateFile = readFileSync) =>
  resolveLoginListenerTrust({ listenerReply, authorizationUrl: url, readCertificateFile });

test("a listener-backed authorization URL earns trust in exactly its origin and certificate", () => {
  assert.deepEqual(
    resolve(`${authorizationUrl}?x=1`, {
      ok: true,
      listener: listener(),
    }),
    { origin: "https://10.211.55.2:18544", fingerprint256: leafFingerprint },
  );
  // A certificate file holding leaf + CA still pins the leaf the listener serves.
  assert.equal(
    resolve("https://10.211.55.2:18544/realms/harness/", { listener: listener() }, () => `${leaf}${other}`)
      .fingerprint256,
    leafFingerprint,
  );
});

test("any other origin, listener shape, or certificate file earns no trust", () => {
  const refusals: readonly [string, unknown][] = [
    ["different port", { listener: listener({ port: 18545 }) }],
    ["different hostname", { listener: listener({ hostname: "10.211.55.3" }) }],
    [
      "loopback authority",
      { listener: { hostname: "127.0.0.1", port: 8080, certificateFile: listener().certificateFile } },
    ],
    ["no listener configured", { ok: true, listener: null }],
    ["listener without a certificate file", { listener: listener({ certificateFile: undefined }) }],
    ["daemon refusal", { ok: false, code: "local_transport_required" }],
  ];
  for (const [name, listenerReply] of refusals) {
    assert.equal(resolve(authorizationUrl, listenerReply)?.fingerprint256, undefined, name);
  }
  // A configured certificate that cannot be read or parsed fails the sign-in visibly.
  assert.throws(
    () => resolve(authorizationUrl, { listener: listener({ certificateFile: "/nonexistent/login.pem" }) }),
    "missing certificate file",
  );
  assert.throws(
    () => resolve(authorizationUrl, { listener: listener() }, () => "not a certificate"),
    "unparseable certificate file",
  );
});

test("the login partition allows only the listener origin and the loopback callback", () => {
  const allowedOrigins = ["https://10.211.55.2:18544", callbackOrigin];
  assert.equal(isAllowedLoginRequest("https://10.211.55.2:18544/realms/harness/", allowedOrigins), true);
  assert.equal(isAllowedLoginRequest(`${callbackOrigin}/oidc/callback?code=1`, allowedOrigins), true);
  // The certificate cache is keyed by hostname only; another port on that host must never
  // reach certificate verification inside the login partition.
  assert.equal(isAllowedLoginRequest("https://10.211.55.2:18545/", allowedOrigins), false);
  assert.equal(isAllowedLoginRequest("http://10.211.55.2:18544/realm", allowedOrigins), false);
  assert.equal(isAllowedLoginRequest("https://10.211.55.3:18544/", allowedOrigins), false);
  assert.equal(isAllowedLoginRequest("data:text/html,hello", allowedOrigins), false);
  assert.equal(isAllowedLoginRequest("not a url", allowedOrigins), false);
});

function grantFixture() {
  let serial = 0;
  const grants = createLoginWebviewGrants({
      createToken: () => `token-${++serial}`,
      createPartition: () => `login-partition-${serial}`,
    }),
    sessions = new Map<string, object>();
  return {
    grants,
    authorize: () => {
      const handle = grants.authorize({
        expectedSrc: authorizationUrl,
        allowedOrigins: ["https://10.211.55.2:18544", callbackOrigin],
        trust: { origin: "https://10.211.55.2:18544", fingerprint256: leafFingerprint },
        createSession: (partition) => {
          const session = {};
          sessions.set(partition, session);
          return session;
        },
      });
      return handle;
    },
    sessionOf: (partition: string) => sessions.get(partition)!,
  };
}

test("a grant token places a webview only on its own partition and only for its exact source", () => {
  const { grants, authorize } = grantFixture(),
    first = authorize(),
    second = authorize();
  assert.notEqual(first.partitionToken, second.partitionToken);
  assert.notEqual(first.partition, second.partition);
  const attachment = grants.consumeWebviewAttachment({ partition: first.partitionToken, src: authorizationUrl });
  assert.equal(attachment?.partition, first.partition);
  assert.deepEqual(attachment?.allowedOrigins, ["https://10.211.55.2:18544", callbackOrigin]);
  // The renderer cannot steer the attach with its own source, token guesses, or absent fields.
  assert.equal(
    grants.consumeWebviewAttachment({ partition: first.partitionToken, src: "https://10.211.55.2:18544/phish" }),
    null,
    "a different source",
  );
  assert.equal(grants.consumeWebviewAttachment({ src: authorizationUrl }), null, "no token offered");
  assert.equal(
    grants.consumeWebviewAttachment({ partition: first.partition, src: authorizationUrl }),
    null,
    "the real partition name is not a token",
  );
});

test("certificate decisions bind the guest, the full origin, and the fingerprint", () => {
  const { grants, authorize, sessionOf } = grantFixture(),
    first = authorize();
  // Guests of no grant never earn trust.
  assert.equal(
    grants.decideCertificateError({ webContentsId: 1, url: "https://10.211.55.2:18544/", certificatePem: leaf }),
    false,
  );
  assert.equal(grants.bindGuestWebContents(1, {}), null);
  assert.equal(grants.bindGuestWebContents(1, sessionOf(first.partition))?.partition, first.partition);
  assert.equal(
    grants.decideCertificateError({
      webContentsId: 1,
      url: "https://10.211.55.2:18544/realms/",
      certificatePem: leaf,
    }),
    true,
    "the bound guest, the listener origin, and the pinned certificate are accepted together",
  );
  const refusals: readonly [
    string,
    { readonly webContentsId: number; readonly url: string; readonly certificatePem: string },
  ][] = [
    ["another port on the same host", { webContentsId: 1, url: "https://10.211.55.2:18545/", certificatePem: leaf }],
    ["another host", { webContentsId: 1, url: "https://10.211.55.3:18544/", certificatePem: leaf }],
    ["another certificate", { webContentsId: 1, url: "https://10.211.55.2:18544/", certificatePem: other }],
    ["another guest", { webContentsId: 2, url: "https://10.211.55.2:18544/", certificatePem: leaf }],
    ["unparseable url", { webContentsId: 1, url: "not a url", certificatePem: leaf }],
  ];
  for (const [name, input] of refusals) {
    assert.equal(grants.decideCertificateError(input), false, name);
  }
  // A destroyed guest stops earning trust even while the sign-in's grant is alive.
  grants.unbindGuestWebContents(1);
  assert.equal(
    grants.decideCertificateError({ webContentsId: 1, url: "https://10.211.55.2:18544/", certificatePem: leaf }),
    false,
  );
});

test("the sign-in settling releases the token and every certificate decision with it", () => {
  const { grants, authorize, sessionOf } = grantFixture(),
    first = authorize();
  assert.equal(grants.bindGuestWebContents(3, sessionOf(first.partition))?.partition, first.partition);
  grants.release(first.partitionToken);
  assert.equal(grants.consumeWebviewAttachment({ partition: first.partitionToken, src: authorizationUrl }), null);
  assert.equal(
    grants.decideCertificateError({ webContentsId: 3, url: "https://10.211.55.2:18544/", certificatePem: leaf }),
    false,
    "a released sign-in's certificate stays rejected",
  );
  assert.equal(
    grants.bindGuestWebContents(4, sessionOf(first.partition)),
    null,
    "a released sign-in's session binds no new guest",
  );
});
