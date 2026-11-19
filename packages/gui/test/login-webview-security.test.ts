// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Session } from "electron";
import { createLoginWebviewSecurity } from "../src/main/login-webview-security.ts";

const leaf = readFileSync(new URL("./fixtures/login-listener-leaf.pem", import.meta.url), "utf8");
const other = readFileSync(new URL("./fixtures/login-other.pem", import.meta.url), "utf8");
const authorizationUrl = "https://center.internal/authorize";
const callbackOrigin = "http://127.0.0.1:53142";
const targetUrl = "https://10.144.144.2:7545/";

class LoginSession {
  verifier?: NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>;
  beforeRequest?: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
  setProxy = async () => undefined;
  setPermissionCheckHandler = () => undefined;
  setPermissionRequestHandler = () => undefined;
  on = () => undefined;
  setCertificateVerifyProc(verifier: NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>): void {
    this.verifier = verifier;
  }
  webRequest = {
    onBeforeRequest: (listener: NonNullable<LoginSession["beforeRequest"]>) => {
      this.beforeRequest = listener;
    },
  };

  verify(data: string, hostname = "center.internal"): number | undefined {
    const request = { hostname, certificate: { data }, verificationResult: "OK", errorCode: 0 };
    let result;
    this.verifier?.(request as Parameters<NonNullable<LoginSession["verifier"]>>[0], (code) => (result = code));
    return result;
  }

  permits(url: string): boolean {
    let allowed = false;
    this.beforeRequest?.({ url }, ({ cancel }) => (allowed = !cancel));
    return allowed;
  }
}

test("an isolated remote login pins the TLS leaf even when Chromium trusts a different certificate", async () => {
  const sessions = new Map<string, LoginSession>();
  const security = createLoginWebviewSecurity({
    fromPartition(partition) {
      const session = sessions.get(partition) ?? new LoginSession();
      sessions.set(partition, session);
      return session as unknown as Session;
    },
  });
  const open = (certificate: string) =>
    security.openLoginWebview({
      authorizationUrl,
      callbackOrigin,
      listenerReply: {
        listener: { address: "10.144.144.2", hostname: "center.internal", port: 443, targetUrl, certificate },
      },
    });

  const first = await open(leaf);
  assert.ok(first);
  try {
    const second = await open(other);
    assert.ok(second);
    try {
      assert.equal(sessions.size, 2);
      const [firstSession, secondSession] = [...sessions.values()];
      assert.equal(firstSession.verify(leaf), 0);
      assert.equal(firstSession.verify(other), -2);
      assert.equal(firstSession.verify(leaf, "other.example"), -2);
      assert.equal(secondSession.verify(leaf), -2);
      assert.equal(secondSession.verify(other), 0);
      assert.equal(firstSession.permits(authorizationUrl), true);
      assert.equal(firstSession.permits(callbackOrigin), true);
      assert.equal(firstSession.permits(targetUrl), false);
      assert.equal(firstSession.permits("https://center.internal:7545/"), false);
      await first.release();
      assert.equal(firstSession.verify(leaf), -2);
      assert.equal(firstSession.permits(authorizationUrl), false);
      assert.equal(secondSession.permits(authorizationUrl), true);
    } finally {
      await second.release();
    }
  } finally {
    await first.release();
  }
});
