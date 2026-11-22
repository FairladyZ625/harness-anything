// harness-test-tier: fast
// dec_E610E1D99A39003886D1B5EE7C/CH1: managed first-party clients receive OIDC default scope "consent";
// disabled/tombstone nodes and unmanaged third-party OAuth clients do not.
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "../../src/keycloak/keycloak-policy-adapter.ts";

interface MockClientScope {
  id: string;
  name: string;
  protocol: string;
  attributes: Record<string, string>;
}

interface MockClient {
  id: string;
  clientId: string;
  enabled: boolean;
  attributes: Record<string, string>;
  defaultClientScopes: Set<string>;
}

function createKeycloakConsentFixture(
  initial: {
    readonly scopes?: readonly MockClientScope[];
    readonly clients?: readonly MockClient[];
  } = {},
) {
  let seq = 0;
  const scopes = new Map<string, MockClientScope>(
    (initial.scopes ?? []).map((scope) => [scope.id, { ...scope, attributes: { ...scope.attributes } }]),
  );
  const clients = new Map<string, MockClient>(
    (initial.clients ?? []).map((client) => [
      client.id,
      { ...client, attributes: { ...client.attributes }, defaultClientScopes: new Set(client.defaultClientScopes) },
    ]),
  );
  const requests: string[] = [];

  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      route = url.pathname.replace("/admin/realms/harness", ""),
      body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push(`${method} ${route}`);

    if (route === "/client-scopes" && method === "GET") return Response.json([...scopes.values()]);
    if (route === "/client-scopes" && method === "POST") {
      const id = `scope-${++seq}`;
      const scope: MockClientScope = {
        id,
        name: String(body!.name),
        protocol: String(body!.protocol ?? ""),
        attributes: { ...((body!.attributes as Record<string, string> | undefined) ?? {}) },
      };
      scopes.set(id, scope);
      return new Response(null, { status: 201, headers: { location: `${url.origin}${url.pathname}/${id}` } });
    }
    if (/^\/client-scopes\/[^/]+$/u.test(route) && method === "PUT") {
      const id = decodeURIComponent(route.split("/")[2]!);
      const existing = scopes.get(id);
      if (!existing) return new Response(null, { status: 404 });
      existing.name = String(body!.name ?? existing.name);
      existing.protocol = String(body!.protocol ?? existing.protocol);
      existing.attributes = { ...((body!.attributes as Record<string, string> | undefined) ?? existing.attributes) };
      return new Response(null, { status: 204 });
    }

    if (route === "/clients" && method === "POST") {
      const id = `client-${++seq}`;
      clients.set(id, {
        id,
        clientId: String(body!.clientId),
        enabled: body!.enabled !== false,
        attributes: { ...((body!.attributes as Record<string, string> | undefined) ?? {}) },
        defaultClientScopes: new Set<string>(),
      });
      return new Response(null, { status: 201, headers: { location: `${url.origin}${url.pathname}/${id}` } });
    }
    if (route === "/clients" && method === "GET") {
      const filter = url.searchParams.get("clientId");
      const list = [...clients.values()]
        .filter((client) => !filter || client.clientId === filter)
        .map(({ defaultClientScopes: _scopes, ...rest }) => rest);
      return Response.json(list);
    }

    const clientMatch = /^\/clients\/([^/]+)(?:\/default-client-scopes(?:\/([^/]+))?)?$/u.exec(route);
    if (clientMatch) {
      const clientId = decodeURIComponent(clientMatch[1]!);
      const scopeId = clientMatch[2] ? decodeURIComponent(clientMatch[2]) : undefined;
      const client = clients.get(clientId);
      if (!client) return new Response(null, { status: 404 });
      if (route.includes("/default-client-scopes")) {
        if (method === "GET") {
          return Response.json(
            [...client.defaultClientScopes]
              .map((id) => scopes.get(id))
              .filter((scope): scope is MockClientScope => scope !== undefined),
          );
        }
        if (method === "PUT" && scopeId) {
          if (!scopes.has(scopeId)) return new Response(null, { status: 404 });
          client.defaultClientScopes.add(scopeId);
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE" && scopeId) {
          client.defaultClientScopes.delete(scopeId);
          return new Response(null, { status: 204 });
        }
      }
      if (method === "GET") {
        const { defaultClientScopes: _scopes, ...rest } = client;
        return Response.json(rest);
      }
      if (method === "PUT") {
        if (typeof body!.enabled === "boolean") client.enabled = body!.enabled;
        if (body!.attributes && typeof body!.attributes === "object")
          client.attributes = { ...client.attributes, ...(body!.attributes as Record<string, string>) };
        return new Response(null, { status: 204 });
      }
    }

    if (route === "/roles/access-admin" && method === "GET") return new Response(null, { status: 404 });
    if (route === "/users" && method === "GET") return Response.json([]);
    throw new Error(`Unexpected Keycloak request: ${method} ${route}`);
  };

  return {
    scopes,
    clients,
    requests,
    clientByClientId(clientId: string) {
      return [...clients.values()].find((client) => client.clientId === clientId);
    },
    defaultScopeNames(clientId: string): string[] {
      const client = [...clients.values()].find((item) => item.clientId === clientId);
      if (!client) return [];
      return [...client.defaultClientScopes]
        .map((id) => scopes.get(id)?.name)
        .filter((name): name is string => typeof name === "string")
        .sort();
    },
    adapter: new KeycloakPolicyAdapter(
      { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" },
      fetchPort,
    ),
  };
}

test("createNode idempotently creates the OIDC consent scope with include.in.token.scope=true and attaches it as a default scope", async () => {
  const fixture = createKeycloakConsentFixture();

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-1", personId: "person-a" }, "secret-1");
  await fixture.adapter.createNode("admin-token", { nodeId: "edge-2", personId: "person-b" }, "secret-2");

  const consentScopes = [...fixture.scopes.values()].filter((scope) => scope.name === "consent");
  assert.equal(consentScopes.length, 1, "consent scope is created once and reused across registrations");
  assert.equal(consentScopes[0]!.protocol, "openid-connect");
  assert.equal(consentScopes[0]!.attributes["include.in.token.scope"], "true");
  assert.equal(consentScopes[0]!.attributes["display.on.consent.screen"], "false");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-1"), ["consent"]);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-2"), ["consent"]);
  assert.equal(
    fixture.requests.some((req) => req.includes("/optional-client-scopes")),
    false,
    "consent must be bound as default-client-scopes, never optional",
  );
});

test("syncLoginClients aligns drifted consent scope, binds active managed clients, detaches tombstones, and ignores third-party clients", async () => {
  const activeDevice = {
    nodeId: "active-1",
    personId: "person-a",
    systemName: "active-1",
    displayName: "Active 1",
    platform: "darwin",
    registeredAt: "2026-11-20T00:00:00.000Z",
    state: "active",
    revision: 1,
    revocation: "complete",
  };
  const removedDevice = {
    ...activeDevice,
    nodeId: "tombstone-1",
    state: "removed",
  };
  const fixture = createKeycloakConsentFixture({
    scopes: [
      {
        id: "scope-existing",
        name: "consent",
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "true" },
      },
    ],
    clients: [
      {
        id: "uuid-gui",
        clientId: "harness-gui",
        enabled: true,
        attributes: {},
        defaultClientScopes: new Set(),
      },
      {
        id: "uuid-active",
        clientId: "harness-node-active-1",
        enabled: true,
        attributes: { harness_person_id: "person-a", harness_device: JSON.stringify(activeDevice) },
        defaultClientScopes: new Set(),
      },
      {
        id: "uuid-tombstone",
        clientId: "harness-node-tombstone-1",
        enabled: false,
        attributes: { harness_person_id: "person-a", harness_device: JSON.stringify(removedDevice) },
        defaultClientScopes: new Set(["scope-existing"]),
      },
      {
        id: "uuid-third-party",
        clientId: "web-bff",
        enabled: true,
        attributes: {},
        defaultClientScopes: new Set(),
      },
    ],
  });

  await fixture.adapter.syncLoginClients("admin-token");

  const consentScope = fixture.scopes.get("scope-existing");
  assert.equal(consentScope?.attributes["include.in.token.scope"], "true");
  assert.equal(consentScope?.attributes["display.on.consent.screen"], "false");
  assert.deepEqual(fixture.defaultScopeNames("harness-gui"), ["consent"]);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-active-1"), ["consent"]);
  assert.deepEqual(
    fixture.defaultScopeNames("harness-node-tombstone-1"),
    [],
    "disabled tombstone nodes must not hold the consent default client scope",
  );
  assert.deepEqual(
    fixture.defaultScopeNames("web-bff"),
    [],
    "unmanaged third-party clients must never be auto-granted consent scope",
  );
});

test("writeNode and deleteNode detach consent scope on disable/tombstone and re-attach when resumed active", async () => {
  const fixture = createKeycloakConsentFixture();

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-life", personId: "person-a" }, "secret-life");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["consent"]);

  const active = (await fixture.adapter.readNode("admin-token", "edge-life"))!;
  await fixture.adapter.writeNode("admin-token", { ...active, state: "paused", revision: 2 });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), []);

  await fixture.adapter.writeNode("admin-token", { ...active, state: "active", revision: 3 });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["consent"]);

  await fixture.adapter.deleteNode("admin-token", "edge-life");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), []);

  await fixture.adapter.deleteNode("admin-token", "never-registered");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-never-registered"), []);
});
