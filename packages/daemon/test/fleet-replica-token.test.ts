// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { requestFleetReplicaToken } from "../src/fleet/replica-token.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

test("a node secret obtains a short-lived client-credentials token through the pinned CA", async () => {
  let request: { readonly input: string | URL | Request; readonly init?: RequestInit } | undefined;
  const token = await requestFleetReplicaToken(
    {
      url: "https://login.example",
      realm: "tenant-realm",
      nodeId: "edge-a",
      credential: "node-secret",
      ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
      servername: "login.example",
    },
    (async (input, init) => {
      request = { input, init };
      return Response.json({ access_token: "short-token", expires_in: 300 });
    }) as typeof fetch,
  );
  assert.equal(token, "short-token");
  assert.equal(String(request?.input), "https://login.example/realms/tenant-realm/protocol/openid-connect/token");
  assert.deepEqual(
    [...new URLSearchParams(request?.init?.body as URLSearchParams)],
    [
      ["grant_type", "client_credentials"],
      ["client_id", "harness-node-edge-a"],
      ["client_secret", "node-secret"],
    ],
  );
  assert.equal(request?.init?.redirect, "error", "a token endpoint cannot redirect the node secret elsewhere");
});

test("a rejected node secret is surfaced without echoing credentials or response bodies", async () => {
  await assert.rejects(
    requestFleetReplicaToken(
      {
        url: "https://login.example",
        realm: "harness",
        nodeId: "edge-a",
        credential: "never-log-this",
        ca: "fixture-ca",
      },
      (async () => new Response("secret leaked by an upstream", { status: 401 })) as typeof fetch,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "fleet_replica_token_unavailable");
      assert.doesNotMatch(String(error), /never-log-this|secret leaked/u);
      return true;
    },
  );
});

test("a revoked node cannot exchange its machine credential for a token", async () => {
  const keycloak = fakeKeycloak("https://keycloak.fixture/realms/harness");
  keycloak.node("edge-revoked", "person-a");
  const client = keycloak.nodeClients.get("harness-node-edge-revoked");
  assert.ok(client);
  client.enabled = false;
  await assert.rejects(
    requestFleetReplicaToken(
      {
        url: "https://keycloak.fixture",
        realm: "harness",
        nodeId: "edge-revoked",
        credential: "secret-edge-revoked",
        ca: "fixture-ca",
      },
      keycloak.fetch,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "fleet_replica_token_unavailable");
      assert.doesNotMatch(String(error), /secret-edge-revoked/u);
      return true;
    },
  );
});
