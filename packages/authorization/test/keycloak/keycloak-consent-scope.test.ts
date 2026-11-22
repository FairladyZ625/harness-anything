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
  optionalClientScopes: Set<string>;
}

const baselineRealmScopes: readonly MockClientScope[] = [
  { id: "scope-profile", name: "profile", protocol: "openid-connect", attributes: {} },
  { id: "scope-email", name: "email", protocol: "openid-connect", attributes: {} },
  { id: "scope-offline", name: "offline_access", protocol: "openid-connect", attributes: {} },
];

function createKeycloakConsentFixture(
  initial: {
    readonly scopes?: readonly MockClientScope[];
    readonly realmDefaultScopeIds?: readonly string[];
    readonly realmOptionalScopeIds?: readonly string[];
    readonly clients?: readonly (Omit<MockClient, "optionalClientScopes"> & {
      readonly optionalClientScopes?: ReadonlySet<string>;
    })[];
    readonly onRequest?: (method: string, route: string) => Response | undefined;
  } = {},
) {
  let seq = 0;
  const seedScopes = initial.scopes ?? baselineRealmScopes;
  const scopes = new Map<string, MockClientScope>(
    seedScopes.map((scope) => [scope.id, { ...scope, attributes: { ...scope.attributes } }]),
  );
  const realmDefaultScopeIds = new Set<string>(
    initial.realmDefaultScopeIds ??
      [...scopes.values()].filter((s) => s.name === "profile" || s.name === "email").map((s) => s.id),
  );
  const realmOptionalScopeIds = new Set<string>(
    initial.realmOptionalScopeIds ?? [...scopes.values()].filter((s) => s.name === "offline_access").map((s) => s.id),
  );
  const clients = new Map<string, MockClient>(
    (initial.clients ?? []).map((client) => [
      client.id,
      {
        ...client,
        attributes: { ...client.attributes },
        defaultClientScopes: new Set(client.defaultClientScopes),
        optionalClientScopes: new Set(client.optionalClientScopes ?? []),
      },
    ]),
  );
  const requests: string[] = [];

  const scopeIdByName = (name: string): string | undefined =>
    [...scopes.values()].find((scope) => scope.name === name)?.id;

  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      route = url.pathname.replace("/admin/realms/harness", ""),
      body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push(`${method} ${route}`);

    const injected = initial.onRequest?.(method, route);
    if (injected) return injected;

    if (route === "/default-default-client-scopes" && method === "GET")
      return Response.json(
        [...realmDefaultScopeIds]
          .map((id) => scopes.get(id))
          .filter((scope): scope is MockClientScope => scope !== undefined),
      );
    if (route === "/default-optional-client-scopes" && method === "GET")
      return Response.json(
        [...realmOptionalScopeIds]
          .map((id) => scopes.get(id))
          .filter((scope): scope is MockClientScope => scope !== undefined),
      );
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
      // Model Keycloak 26.7.3 RepresentationToModel.updateClientScopes:
      // explicit defaultClientScopes/optionalClientScopes replace realm defaults; omission inherits them.
      const hasExplicitScopes = body!.defaultClientScopes !== undefined || body!.optionalClientScopes !== undefined;
      const defaultClientScopes = new Set<string>();
      const optionalClientScopes = new Set<string>();
      if (hasExplicitScopes) {
        for (const name of (body!.defaultClientScopes as readonly string[] | undefined) ?? []) {
          const matched = scopeIdByName(name);
          if (matched) defaultClientScopes.add(matched);
        }
        for (const name of (body!.optionalClientScopes as readonly string[] | undefined) ?? []) {
          const matched = scopeIdByName(name);
          if (matched && !defaultClientScopes.has(matched)) optionalClientScopes.add(matched);
        }
      } else {
        for (const scopeId of realmDefaultScopeIds) defaultClientScopes.add(scopeId);
        for (const scopeId of realmOptionalScopeIds) optionalClientScopes.add(scopeId);
      }
      clients.set(id, {
        id,
        clientId: String(body!.clientId),
        enabled: body!.enabled !== false,
        attributes: { ...((body!.attributes as Record<string, string> | undefined) ?? {}) },
        defaultClientScopes,
        optionalClientScopes,
      });
      return new Response(null, { status: 201, headers: { location: `${url.origin}${url.pathname}/${id}` } });
    }
    if (route === "/clients" && method === "GET") {
      const filter = url.searchParams.get("clientId");
      const list = [...clients.values()]
        .filter((client) => !filter || client.clientId === filter)
        .map(({ defaultClientScopes: _d, optionalClientScopes: _o, ...rest }) => rest);
      return Response.json(list);
    }

    const clientMatch = /^\/clients\/([^/]+)(?:\/(default|optional)-client-scopes(?:\/([^/]+))?)?$/u.exec(route);
    if (clientMatch) {
      const clientId = decodeURIComponent(clientMatch[1]!);
      const scopeKind = clientMatch[2] as "default" | "optional" | undefined;
      const scopeId = clientMatch[3] ? decodeURIComponent(clientMatch[3]) : undefined;
      const client = clients.get(clientId);
      if (!client) return new Response(null, { status: 404 });
      if (scopeKind !== undefined) {
        const targetSet = scopeKind === "default" ? client.defaultClientScopes : client.optionalClientScopes;
        const otherSet = scopeKind === "default" ? client.optionalClientScopes : client.defaultClientScopes;
        if (method === "GET") {
          return Response.json(
            [...targetSet].map((id) => scopes.get(id)).filter((scope): scope is MockClientScope => scope !== undefined),
          );
        }
        if (method === "PUT" && scopeId) {
          if (!scopes.has(scopeId)) return new Response(null, { status: 404 });
          // Keycloak 26.7.3 JpaRealmProvider.addClientScopes skips adding a scope if the client already
          // maps the same scope in either default or optional mappings.
          if (!otherSet.has(scopeId)) targetSet.add(scopeId);
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE" && scopeId) {
          targetSet.delete(scopeId);
          return new Response(null, { status: 204 });
        }
      }
      if (method === "GET") {
        const { defaultClientScopes: _d, optionalClientScopes: _o, ...rest } = client;
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
    optionalScopeNames(clientId: string): string[] {
      const client = [...clients.values()].find((item) => item.clientId === clientId);
      if (!client) return [];
      return [...client.optionalClientScopes]
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

test("createNode provisions consent before POST /clients and binds default/optional scopes atomically with zero post-write requests", async () => {
  const fixture = createKeycloakConsentFixture();

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-1", personId: "person-a" }, "secret-1");
  const firstPostIndex = fixture.requests.indexOf("POST /clients");
  assert.ok(firstPostIndex >= 0);
  assert.equal(
    firstPostIndex,
    fixture.requests.length - 1,
    "POST /clients must be the final request of createNode with no post-write reads or binds",
  );

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-2", personId: "person-b" }, "secret-2");

  const consentScopes = [...fixture.scopes.values()].filter((scope) => scope.name === "consent");
  assert.equal(consentScopes.length, 1, "consent scope is created once and reused across registrations");
  assert.equal(consentScopes[0]!.protocol, "openid-connect");
  assert.equal(consentScopes[0]!.attributes["include.in.token.scope"], "true");
  assert.equal(consentScopes[0]!.attributes["display.on.consent.screen"], "false");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-1"), ["consent", "email", "profile"]);
  assert.deepEqual(fixture.optionalScopeNames("harness-node-edge-1"), ["offline_access"]);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-2"), ["consent", "email", "profile"]);
  assert.deepEqual(fixture.optionalScopeNames("harness-node-edge-2"), ["offline_access"]);
});

test("F-1: createNode failure during scope setup leaves no stranded client and retries cleanly", async () => {
  let failScopeCreate = true;
  const fixture = createKeycloakConsentFixture({
    onRequest: (method, route) => {
      if (failScopeCreate && method === "POST" && route === "/client-scopes") {
        failScopeCreate = false;
        return new Response(null, { status: 503 });
      }
      return undefined;
    },
  });

  await assert.rejects(
    fixture.adapter.createNode("admin-token", { nodeId: "edge-retry", personId: "person-a" }, "secret-1"),
    { code: "keycloak_admin_rejected" },
  );
  assert.equal(fixture.clients.size, 0, "failed scope setup must not leave an enabled client in Keycloak");

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-retry", personId: "person-a" }, "secret-1");
  assert.equal(fixture.clients.size, 1);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-retry"), ["consent", "email", "profile"]);
});

test("F-1: writeNode failure during scope bind does not advance revision/state so reconcile stays accurate and retry converges", async () => {
  let failScopeBind = false;
  const fixture = createKeycloakConsentFixture({
    onRequest: (method, route) => {
      if (failScopeBind && method === "PUT" && route.includes("/default-client-scopes/")) {
        failScopeBind = false;
        return new Response(null, { status: 503 });
      }
      return undefined;
    },
  });

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-rec", personId: "person-a" }, "secret-rec");
  const initial = (await fixture.adapter.readNode("admin-token", "edge-rec"))!;
  await fixture.adapter.writeNode("admin-token", { ...initial, state: "paused", revision: 2 });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-rec"), ["email", "profile"]);

  failScopeBind = true;
  await assert.rejects(fixture.adapter.writeNode("admin-token", { ...initial, state: "active", revision: 3 }), {
    code: "keycloak_admin_rejected",
  });
  const afterFailure = (await fixture.adapter.readNode("admin-token", "edge-rec"))!;
  assert.deepEqual(
    [afterFailure.state, afterFailure.revision],
    ["paused", 2],
    "failed consent bind must not publish revision 3 / active state before scope is attached",
  );

  await fixture.adapter.writeNode("admin-token", { ...initial, state: "active", revision: 3 });
  const afterRetry = (await fixture.adapter.readNode("admin-token", "edge-rec"))!;
  assert.deepEqual([afterRetry.state, afterRetry.revision], ["active", 3]);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-rec"), ["consent", "email", "profile"]);
});

test("F-1: revokeNode failure during scope detach disables client with pending revocation and retries to completion", async () => {
  let failDetach = true;
  const fixture = createKeycloakConsentFixture({
    onRequest: (method, route) => {
      if (failDetach && method === "DELETE" && route.includes("/default-client-scopes/")) {
        failDetach = false;
        return new Response(null, { status: 503 });
      }
      return undefined;
    },
  });

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-rev", personId: "person-a" }, "secret-rev");
  const active = (await fixture.adapter.readNode("admin-token", "edge-rev"))!;
  await assert.rejects(fixture.adapter.revokeNode("admin-token", { ...active, state: "removed" }), {
    code: "keycloak_admin_rejected",
  });
  const pending = (await fixture.adapter.readNode("admin-token", "edge-rev"))!;
  assert.equal(pending.revocation, "pending", "reconcile sees pending revocation instead of falsely marking applied");
  assert.equal(fixture.clientByClientId("harness-node-edge-rev")?.enabled, false);

  await fixture.adapter.revokeNode("admin-token", { ...pending, state: "removed" });
  const completed = (await fixture.adapter.readNode("admin-token", "edge-rev"))!;
  assert.equal(completed.revocation, "complete");
  assert.equal(fixture.defaultScopeNames("harness-node-edge-rev").includes("consent"), false);
});

test("F-2: syncLoginClients promotes optional consent to default under Keycloak 26.7.3 duplicate-skipping semantics while preserving other scopes", async () => {
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
      ...baselineRealmScopes,
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
        defaultClientScopes: new Set(["scope-profile", "scope-email"]),
        optionalClientScopes: new Set(["scope-existing", "scope-offline"]),
      },
      {
        id: "uuid-active",
        clientId: "harness-node-active-1",
        enabled: true,
        attributes: { harness_person_id: "person-a", harness_device: JSON.stringify(activeDevice) },
        defaultClientScopes: new Set(["scope-profile", "scope-email"]),
        optionalClientScopes: new Set(["scope-existing", "scope-offline"]),
      },
      {
        id: "uuid-tombstone",
        clientId: "harness-node-tombstone-1",
        enabled: false,
        attributes: { harness_person_id: "person-a", harness_device: JSON.stringify(removedDevice) },
        defaultClientScopes: new Set(["scope-existing", "scope-profile"]),
        optionalClientScopes: new Set(),
      },
      {
        id: "uuid-third-party",
        clientId: "web-bff",
        enabled: true,
        attributes: {},
        defaultClientScopes: new Set(["scope-profile"]),
        optionalClientScopes: new Set(["scope-existing", "scope-offline"]),
      },
    ],
  });

  await fixture.adapter.syncLoginClients("admin-token");

  const consentScope = fixture.scopes.get("scope-existing");
  assert.equal(consentScope?.attributes["include.in.token.scope"], "true");
  assert.equal(consentScope?.attributes["display.on.consent.screen"], "false");

  // Both managed active clients had consent in optional-client-scopes; DELETE optional must precede PUT default.
  const activeDeleteIdx = fixture.requests.indexOf("DELETE /clients/uuid-active/optional-client-scopes/scope-existing");
  const activePutIdx = fixture.requests.indexOf("PUT /clients/uuid-active/default-client-scopes/scope-existing");
  assert.ok(
    activeDeleteIdx >= 0 && activePutIdx > activeDeleteIdx,
    "optional consent must be removed before default PUT",
  );

  assert.deepEqual(fixture.defaultScopeNames("harness-gui"), ["consent", "email", "profile"]);
  assert.deepEqual(fixture.optionalScopeNames("harness-gui"), ["offline_access"]);
  assert.deepEqual(fixture.defaultScopeNames("harness-node-active-1"), ["consent", "email", "profile"]);
  assert.deepEqual(fixture.optionalScopeNames("harness-node-active-1"), ["offline_access"]);
  assert.deepEqual(
    fixture.defaultScopeNames("harness-node-tombstone-1"),
    ["profile"],
    "disabled tombstone nodes must not hold the consent default client scope",
  );
  assert.deepEqual(
    fixture.defaultScopeNames("web-bff"),
    ["profile"],
    "unmanaged third-party clients must never be auto-promoted to default consent scope",
  );
  assert.deepEqual(
    fixture.optionalScopeNames("web-bff"),
    ["consent", "offline_access"],
    "unmanaged third-party clients remain completely untouched",
  );
});

test("F-4: a failed optional-to-default promotion restores the original optional consent binding", async () => {
  let failDefaultBind = true;
  const activeDevice = {
    nodeId: "active-retry",
    personId: "person-a",
    systemName: "active-retry",
    displayName: "Active retry",
    platform: "darwin",
    registeredAt: "2026-11-20T00:00:00.000Z",
    state: "active",
    revision: 1,
    revocation: "complete",
  } as const;
  const fixture = createKeycloakConsentFixture({
    scopes: [
      ...baselineRealmScopes,
      {
        id: "scope-existing",
        name: "consent",
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
      },
    ],
    clients: [
      {
        id: "uuid-active-retry",
        clientId: "harness-node-active-retry",
        enabled: true,
        attributes: { harness_person_id: "person-a", harness_device: JSON.stringify(activeDevice) },
        defaultClientScopes: new Set(["scope-profile", "scope-email"]),
        optionalClientScopes: new Set(["scope-existing", "scope-offline"]),
      },
    ],
    onRequest: (method, route) => {
      if (
        failDefaultBind &&
        method === "PUT" &&
        route === "/clients/uuid-active-retry/default-client-scopes/scope-existing"
      ) {
        failDefaultBind = false;
        return new Response(null, { status: 503 });
      }
      return undefined;
    },
  });

  await assert.rejects(fixture.adapter.syncLoginClients("admin-token"), { code: "keycloak_admin_rejected" });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-active-retry"), ["email", "profile"]);
  assert.deepEqual(
    fixture.optionalScopeNames("harness-node-active-retry"),
    ["consent", "offline_access"],
    "the failed promotion must preserve the pre-existing optional consent binding",
  );
  assert.equal(
    fixture.requests.includes("PUT /clients/uuid-active-retry/optional-client-scopes/scope-existing"),
    true,
    "the failed default bind must be followed by an optional rollback",
  );
});

test("writeNode and deleteNode detach consent scope on disable/tombstone and re-attach when resumed active", async () => {
  const fixture = createKeycloakConsentFixture();

  await fixture.adapter.createNode("admin-token", { nodeId: "edge-life", personId: "person-a" }, "secret-life");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["consent", "email", "profile"]);

  const active = (await fixture.adapter.readNode("admin-token", "edge-life"))!;
  await fixture.adapter.writeNode("admin-token", { ...active, state: "paused", revision: 2 });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["email", "profile"]);

  await fixture.adapter.writeNode("admin-token", { ...active, state: "active", revision: 3 });
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["consent", "email", "profile"]);

  await fixture.adapter.deleteNode("admin-token", "edge-life");
  assert.deepEqual(fixture.defaultScopeNames("harness-node-edge-life"), ["email", "profile"]);

  await fixture.adapter.deleteNode("admin-token", "never-registered");
  assert.equal(fixture.defaultScopeNames("harness-node-never-registered").includes("consent"), false);
});
