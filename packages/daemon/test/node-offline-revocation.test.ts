// harness-test-tier: fast
// dec_F01770FD0DCF72683B7C4C7A47/CH5: product removal explicitly revokes native offline consent.
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";

function fixture(options: { consent?: boolean; reject?: string; missingUser?: boolean; missingNode?: boolean } = {}) {
  const calls: string[] = [];
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
                attributes: { harness_person_id: "owner" },
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
    if (call === "DELETE /users/user-id/consents/harness-node-A" || call === "DELETE /clients/uuid-A")
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${call}`);
  };
  return {
    calls,
    adapter: new KeycloakPolicyAdapter(
      { url: "https://keycloak.invalid", realm: "test", resourceServerClientId: "center" },
      fetchPort,
    ),
  };
}

test("removal revokes only the registered owner's device consent before deleting its client", async () => {
  const { adapter, calls } = fixture();
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, [
    "GET /clients",
    "GET /users",
    "GET /users/user-id/consents",
    "DELETE /users/user-id/consents/harness-node-A",
    "DELETE /clients/uuid-A",
  ]);
});

test("a device with no offline grant can be removed without inventing a session id", async () => {
  const { adapter, calls } = fixture({ consent: false });
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, ["GET /clients", "GET /users", "GET /users/user-id/consents", "DELETE /clients/uuid-A"]);
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
  assert.deepEqual(calls, ["GET /clients", "GET /users"]);
});

test("an already absent client does not revoke another device's consent", async () => {
  const { adapter, calls } = fixture({ missingNode: true });
  await adapter.deleteNode("admin", "A");
  assert.deepEqual(calls, ["GET /clients"]);
});
