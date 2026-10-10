// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OidcSessionService } from "../src/oidc-session-service.ts";

test("Device login keeps device/verifier/refresh private and honors pending/slow-down before binding the person", async (t) => {
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
          verification_uri_complete: "http://127.0.0.1:8080/realms/harness/device?user_code=ABCD-EFGH",
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
