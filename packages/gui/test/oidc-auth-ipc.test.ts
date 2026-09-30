// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBindingStatusReply,
  requireSuccessfulAuthReply,
  systemBrowserLogin,
} from "../src/main/oidc-auth-ipc.ts";

test("auth IPC rejects daemon failure receipts with their code and explanation", () => {
  assert.throws(
    () =>
      requireSuccessfulAuthReply({
        ok: false,
        code: "bootstrap_failed",
        rejectionExplanation: "fetch failed",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "bootstrap_failed");
      assert.equal((error as Error).message, "bootstrap_failed: fetch failed");
      return true;
    },
  );
});

test("binding IPC projects an unconfigured receipt as an explicit state", () => {
  assert.deepEqual(
    normalizeBindingStatusReply({
      ok: false,
      code: "rbac_not_configured",
      rejectionExplanation: "Run ha bootstrap first.",
    }),
    { ok: true, configured: false },
  );
});

test("system-browser login opens only after the loopback callback is listening", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await systemBrowserLogin({
    daemonRequest: async (params) => {
      calls.push(params);
      if (params.operation === "login-begin") {
        const redirectUri = String(params.redirectUri);
        return { authorizationUrl: `${redirectUri}?code=code-from-keycloak&state=state-from-keycloak` };
      }
      return { ok: true, authenticated: true, personId: "person-zeyu" };
    },
    openExternal: async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
    },
  });
  assert.deepEqual(result, { ok: true, authenticated: true, personId: "person-zeyu" });
  assert.equal(calls[0]?.operation, "login-begin");
  assert.match(String(calls[0]?.redirectUri), /^http:\/\/127\.0\.0\.1:\d+\/oidc\/callback$/u);
  assert.deepEqual(calls[1], {
    operation: "login-complete",
    code: "code-from-keycloak",
    state: "state-from-keycloak",
  });
});
