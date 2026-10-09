// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import {
  createLoginCertificateTrustScopes,
  loginCertificateAccepted,
  resolveLoginCertificateTrust,
} from "../src/main/login-certificate-trust.ts";

// Public certificate fixtures only; the signing keys were discarded on generation.
const fixtures = path.join(import.meta.dirname, "fixtures"),
  leaf = readFileSync(path.join(fixtures, "login-listener-leaf.pem"), "utf8"),
  other = readFileSync(path.join(fixtures, "login-other.pem"), "utf8"),
  leafFingerprint = new X509Certificate(leaf).fingerprint256;
const listener = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: "10.211.55.2",
  hostname: "10.211.55.2",
  port: 18544,
  certificateFile: path.join(fixtures, "login-listener-leaf.pem"),
  ...overrides,
});
const resolve = (authorizationUrl: string, listenerReply: unknown, readCertificateFile = readFileSync) =>
  resolveLoginCertificateTrust({ listenerReply, authorizationUrl, readCertificateFile });

test("a listener-backed authorization URL earns trust in exactly its certificate", () => {
  assert.deepEqual(
    resolve("https://10.211.55.2:18544/realms/harness/protocol/openid-connect/auth?x=1", {
      ok: true,
      listener: listener(),
    }),
    {
      hostname: "10.211.55.2",
      fingerprint256: leafFingerprint,
    },
  );
  // A certificate file holding leaf + CA still pins the leaf Keycloak serves.
  assert.equal(
    resolve(
      "https://10.211.55.2:18544/realms/harness/",
      {
        listener: listener(),
      },
      () => `${leaf}${other}`,
    ).fingerprint256,
    leafFingerprint,
  );
});

test("any other origin, listener shape, or certificate file earns no trust", () => {
  const url = "https://10.211.55.2:18544/realms/harness/protocol/openid-connect/auth";
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
    assert.equal(resolve(url, listenerReply)?.fingerprint256, undefined, name);
  }
  assert.equal(
    resolve(url, { listener: listener({ certificateFile: "/nonexistent/login.pem" }) }),
    null,
    "missing certificate file",
  );
  assert.equal(
    resolve(url, { listener: listener() }, () => "not a certificate"),
    null,
    "unparseable certificate file",
  );
});

test("the verify decision accepts the pinned hostname and certificate, nothing else", () => {
  const trust = { hostname: "10.211.55.2", fingerprint256: leafFingerprint };
  assert.equal(loginCertificateAccepted({ hostname: "10.211.55.2", certificate: { data: leaf } }, trust), true);
  assert.equal(loginCertificateAccepted({ hostname: "10.211.55.3", certificate: { data: leaf } }, trust), false);
  assert.equal(loginCertificateAccepted({ hostname: "10.211.55.2", certificate: { data: other } }, trust), false);
  assert.equal(loginCertificateAccepted({ hostname: "10.211.55.2", certificate: { data: "garbage" } }, trust), false);
});

test("scopes relax the session only while an anchor is installed", () => {
  let installed:
    | ((
        request: { hostname: string; certificate: { data: string }; verificationResult: string },
        callback: (result: number) => void,
      ) => void)
    | null = null;
  const decide = (request: {
    readonly hostname: string;
    readonly data: string;
    readonly verificationResult?: string;
  }): number => {
    let result = NaN;
    installed!(
      {
        hostname: request.hostname,
        certificate: { data: request.data },
        verificationResult: request.verificationResult ?? "cert_authority_invalid",
      },
      (value) => (result = value),
    );
    return result;
  };
  const scope = createLoginCertificateTrustScopes((proc) => {
    installed = proc;
  });
  const first = scope();
  assert.equal(installed, null, "nothing installed before a login resolves its trust");
  first.install({ hostname: "10.211.55.2", fingerprint256: leafFingerprint });
  assert.equal(decide({ hostname: "10.211.55.2", data: leaf }), 0, "pinned certificate accepted");
  assert.equal(decide({ hostname: "10.211.55.2", data: other }), -2, "another certificate rejected");
  assert.equal(
    decide({ hostname: "docs.example", data: other, verificationResult: "OK" }),
    0,
    "a certificate Chromium already trusts stays loadable",
  );
  const second = scope();
  second.install({ hostname: "edge.example", fingerprint256: new X509Certificate(other).fingerprint256 });
  assert.equal(decide({ hostname: "edge.example", data: other }), 0, "a concurrent login keeps its own anchor");
  first.release();
  assert.notEqual(installed, null, "releasing one login does not relax the other");
  assert.equal(
    decide({ hostname: "10.211.55.2", data: leaf }),
    -2,
    "a released login's certificate is no longer accepted",
  );
  second.release();
  assert.equal(installed, null, "the session is back to default verification");
});
