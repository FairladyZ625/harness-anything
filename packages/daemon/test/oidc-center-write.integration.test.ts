// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

test("a local-center repository still writes after login to an edge center", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-center-write-")),
    userRoot = path.join(root, "user"),
    localRoot = path.join(root, "local"),
    edgeRoot = path.join(root, "edge"),
    local = await serveKeycloak(),
    edge = await serveKeycloak();
  t.after(async () => {
    await Promise.all([local.close(), edge.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(localRoot);
  mkdirSync(edgeRoot);
  initRepo(localRoot);
  registerBootstrappedDaemonRepo({
    userRoot,
    canonicalRoot: localRoot,
    repoId: "local-center-repo",
    createConvenienceLinks: false,
  });
  local.bind(userRoot);
  const centers = [
    { ...local, personId: "person-local" },
    { ...edge, personId: "person-edge" },
  ];
  for (const center of centers) {
    center.keycloak.account(center.personId);
    center.keycloak.permit(
      center.personId,
      "local-center-repo",
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
    );
  }
  const oidc = createIdentitySession(userRoot, {
    loginAuthority: async (target) => ({
      url: target === edgeRoot ? edge.url : local.url,
      realm: "harness",
      clientId: "harness-gui",
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input)),
        center = centers.find((item) => item.url === url.origin)!;
      if (
        url.pathname.endsWith("/token") &&
        (init?.body as URLSearchParams).get("grant_type") === "authorization_code"
      ) {
        const token = `x.${Buffer.from(JSON.stringify({ iss: `${center.url}/realms/harness` })).toString("base64url")}.x`;
        center.keycloak.interactiveSession(center.personId, "gui", center.url, token, "harness-gui");
        return Response.json({
          access_token: token,
          refresh_token: token,
          expires_in: 3600,
          refresh_expires_in: 21600,
        });
      }
      return fetch(input, init);
    },
  });
  // Discovery must already know each canonical issuer before the authorization-code exchange.
  for (const center of centers)
    center.keycloak.interactiveSession(center.personId, "gui", center.url, `seed-${center.personId}`, "harness-gui");
  const signIn = async (target: string) => {
    const pending = await oidc.begin("http://127.0.0.1:43123/callback", target);
    await oidc.complete("code", String(pending.state));
  };
  await signIn(localRoot);
  const host = await openDaemonHost({ userRoot, daemonId: "oidc-centers", oidc, runtimeDiscover: () => [] });
  t.after(() => host.close());
  await host.attachmentsSettled();
  await signIn(edgeRoot);

  assert.equal((await oidc.status(localRoot)).personId, "person-local");
  assert.equal((await oidc.status(edgeRoot)).personId, "person-edge");

  const receipt = await host.run(
    "local-center-repo",
    { kind: "task-create", taskId: "task_after_edge_login", title: "Local write after edge login" },
    auth,
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
});
