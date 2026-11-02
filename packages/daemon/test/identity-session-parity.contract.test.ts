// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinIdentitySession } from "@harness-anything/authorization-builtin";
import { createIdentitySession } from "../src/authorization-provider.ts";
import type { IdentitySessionPort } from "@harness-anything/kernel";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";

for (const kind of ["builtin", "keycloak"] as const) {
  test(`${kind}: local session authority observes login, current grants, and logout`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-session-parity-"));
    const realm = kind === "keycloak" ? await serveKeycloak() : undefined;
    t.after(async () => {
      await realm?.close();
      rmSync(root, { recursive: true, force: true });
    });
    if (realm) realm.bind(root);
    const session: IdentitySessionPort = realm ? createIdentitySession(root) : new BuiltinIdentitySession(root);
    assert.equal(session.configured(), true);
    assert.equal(session.centerConfigured(), true);
    assert.equal((await session.status()).authenticated, false);
    await assert.rejects(session.requireSession(), { code: "authentication_required" });
    await assert.rejects(session.requireAccessManagement(), { code: "authentication_required" });
    const owner = {
      username: "owner",
      personId: "owner",
      email: "owner@example.invalid",
      displayName: "Owner",
      password: "synthetic-session-owner",
    };
    assert.equal((await session.bootstrapStatus()).required, true);
    await session.bootstrapAdmin(owner);
    assert.equal((await session.bootstrapStatus()).required, false);
    await assert.rejects(session.bootstrapAdmin(owner), { code: "bootstrap_admin_closed" });
    assert.equal((await session.status()).authenticated, false, "bootstrap is not login");
    if (realm) {
      realm.keycloak.interactiveSession("owner", "local", realm.url);
      signInAt(root, "owner", []);
    } else {
      const begun = await session.begin("http://127.0.0.1:43123/callback");
      const response = await fetch(String(begun.authorizationUrl), {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ username: owner.username, password: owner.password, state: String(begun.state) }),
      });
      const callback = new URL(response.headers.get("location")!);
      await session.complete(callback.searchParams.get("code")!, String(begun.state));
    }
    assert.equal((await session.status()).authenticated, true);
    assert.equal((await session.requireSession()).personId, "owner");
    assert.equal((await session.requireAccessManagement()).personId, "owner");
    const bound = await session.bind({ transportKind: "unix-socket" });
    assert.equal(bound.oidcPrincipal?.personId, "owner");
    assert.equal(await session.configureAuthority(async () => "configured"), "configured");
    const order: number[] = [];
    await Promise.all([
      session.serialize(async () => {
        order.push(1);
        await Promise.resolve();
        order.push(2);
      }),
      session.serialize(async () => {
        order.push(3);
      }),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
    // Keep Keycloak first-admin recovery closed while revoking the acting person.
    realm?.keycloak.accessAdmin("recovery-admin");
    const center = await session.center();
    for (const grant of await center.provider.readGrants(center.accessToken)) {
      if (
        grant.resource === "@fleet" &&
        grant.userIds.includes((await center.provider.findUserId(center.accessToken, "owner"))!)
      )
        await center.provider.writeGrant(center.accessToken, { ...grant, userIds: [] }, []);
    }
    await assert.rejects(session.requireAccessManagement(), { code: "authorization_denied" });
    await assert.rejects(
      session.configureAuthority(async () => "unreachable"),
      { code: "authorization_denied" },
    );
    assert.equal(
      (await session.requireSession()).personId,
      "owner",
      "losing management authority does not sign the person out",
    );
    assert.equal((await session.logout()).authenticated, false);
    assert.equal((await session.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
    await assert.rejects(bound.localSessionAccessToken!(), { code: "authentication_required" });
    await assert.rejects(session.requireSession(), { code: "authentication_required" });
  });
}
