// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { systemBrowserLogin } from "../src/main/oidc-auth-ipc.ts";

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
