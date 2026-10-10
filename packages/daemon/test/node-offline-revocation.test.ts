// harness-test-tier: fast
// dec_F01770FD0DCF72683B7C4C7A47/CH5: product removal explicitly revokes native offline consent.
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";

function fixture(options: { consent?: boolean; reject?: string; missingUser?: boolean; missingNode?: boolean } = {}) {
  const calls: string[] = [],
    updates: Record<string, unknown>[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      route = url.pathname.replace("/admin/realms/test", ""),
      call = `${init?.method ?? "GET"} ${route}`;
    calls.push(call);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer admin");
    if (call === options.reject) return new Response(null, { status: 503 });
    if (route === "/clients") {
      assert.equal(url.searchParams.get("clientId"), "harness-node-A");
      return Response.json(
        options.missingNode
          ? []
          : [
              {
                id: "uuid-A",
                clientId: "harness-node-A",
                attributes: {
                  harness_person_id: "owner",
                  harness_device: JSON.stringify({
                    nodeId: "A",
                    personId: "owner",
                    systemName: "A",
                    displayName: "A",
                    platform: "test",
                    registeredAt: "2026-10-10T00:00:00Z",
                    state: "active",
                    revision: 1,
                    revocation: "complete",
                  }),
                },
              },
            ],
      );
    }
    if (route === "/users") {
      assert.equal(url.searchParams.get("q"), "harness_person_id:owner");
      return Response.json(options.missingUser ? [] : [{ id: "user-id" }]);
    }
    if (call === "GET /users/user-id/consents")
      return Response.json([
        { clientId: "harness-node-B" },
        ...(options.consent === false ? [] : [{ clientId: "harness-node-A" }]),
      ]);
    if (call === "PUT /clients/uuid-A") updates.push(JSON.parse(String(init!.body)));
    if (call === "DELETE /users/user-id/consents/harness-node-A" || call === "PUT /clients/uuid-A")
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${call}`);
  };
  return {
    calls,
    updates,
    adapter: new KeycloakPolicyAdapter(
      { url: "https://keycloak.invalid", realm: "test", resourceServerClientId: "center" },
      fetchPort,
    ),
  };
}

test("removal revokes only the registered owner's device consent while retaining a disabled tombstone", async () => {
  const { adapter, calls, updates } = fixture();
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, [
    "GET /clients",
    "GET /clients",
    "PUT /clients/uuid-A",
    "GET /clients",
    "GET /users",
    "GET /users/user-id/consents",
    "DELETE /users/user-id/consents/harness-node-A",
    "GET /clients",
    "PUT /clients/uuid-A",
  ]);
  assert.deepEqual(
    updates.map((entry) => [
      entry.enabled,
      JSON.parse((entry.attributes as Record<string, string>).harness_device!).revocation,
    ]),
    [
      [false, "pending"],
      [false, "complete"],
    ],
  );
});

test("a device with no offline grant can be removed without inventing a session id", async () => {
  const { adapter, calls } = fixture({ consent: false });
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, [
    "GET /clients",
    "GET /clients",
    "PUT /clients/uuid-A",
    "GET /clients",
    "GET /users",
    "GET /users/user-id/consents",
    "GET /clients",
    "PUT /clients/uuid-A",
  ]);
});

for (const reject of ["GET /users/user-id/consents", "DELETE /users/user-id/consents/harness-node-A"])
  test(`removal surfaces ${reject} failure without deleting the client`, async () => {
    const { adapter, calls } = fixture({ reject });
    await assert.rejects(adapter.deleteNode("admin", "A"), { code: "keycloak_admin_rejected" });
    assert.equal(calls.includes("DELETE /clients/uuid-A"), false);
  });

test("an unresolved owner cannot be reported as successfully revoked", async () => {
  const { adapter, calls } = fixture({ missingUser: true });
  await assert.rejects(adapter.deleteNode("admin", "A"), { code: "access_person_unknown" });
  assert.deepEqual(calls, ["GET /clients", "GET /clients", "PUT /clients/uuid-A", "GET /clients", "GET /users"]);
});

test("an already absent client does not revoke another device's consent", async () => {
  const { adapter, calls } = fixture({ missingNode: true });
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, ["GET /clients"]);
});
