// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionDeclarations } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";

const config = { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" };

test("sync derives every Keycloak scope and four composite Base roles from declarations", async () => {
  const scopes = new Set<string>(),
    roles = new Map<string, { id: string; name: string }>(),
    composites: string[] = [],
    policies = new Map<string, { id: string; name: string }>(),
    permissions = new Set<string>();
  const fetchPort = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input),
      body = init?.body ? (JSON.parse(String(init.body)) as { name?: string }) : null;
    if (url.includes("/clients?clientId=")) return Response.json([{ id: "client-1" }]);
    if (url.endsWith("/authz/resource-server/scope")) {
      if (init?.method === "POST" && body?.name) scopes.add(body.name);
      return init?.method === "POST"
        ? new Response(null, { status: 201 })
        : Response.json([...scopes].map((name) => ({ id: `scope-${name}`, name })));
    }
    if (url.endsWith("/roles")) {
      if (init?.method === "POST" && body?.name) roles.set(body.name, { id: `role-${body.name}`, name: body.name });
      return init?.method === "POST" ? new Response(null, { status: 201 }) : Response.json([...roles.values()]);
    }
    if (url.includes("/composites")) {
      composites.push(url);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/policy/role")) {
      if (init?.method === "POST" && body?.name)
        policies.set(body.name, { id: `policy-${body.name}`, name: body.name });
      return init?.method === "POST" ? new Response(null, { status: 201 }) : Response.json([...policies.values()]);
    }
    if (url.endsWith("/permission/scope")) {
      if (init?.method === "POST" && body?.name) permissions.add(body.name);
      return init?.method === "POST"
        ? new Response(null, { status: 201 })
        : Response.json([...permissions].map((name) => ({ name })));
    }
    return new Response(null, { status: 404 });
  };
  const receipt = await new KeycloakPolicyAdapter(config, fetchPort).syncBasePolicy("admin-token");
  assert.deepEqual(receipt, { scopeCount: actionDeclarations.length, groupCount: 4 });
  assert.equal(scopes.size, actionDeclarations.length);
  assert.deepEqual([...roles.keys()].sort(), ["admin", "contributor", "maintainer", "viewer"]);
  assert.equal(composites.length, 3);
  assert.equal(policies.size, 3);
  assert.equal(permissions.size, actionDeclarations.length);
});

test("online evaluation returns explicit allow and denies unknown, negative, and unavailable scopes", async () => {
  const allow = new KeycloakPolicyAdapter(config, async () => Response.json({ result: true }));
  assert.deepEqual(
    await allow.authorize({
      userAccessToken: "user",
      action: "task-create",
      resource: { kind: "repository", repoId: "repo-a" },
    }),
    {
      outcome: "allowed",
      reasonCode: "keycloak_allowed",
      resource: "repo-a",
      scope: "task-create",
    },
  );
  const deny = new KeycloakPolicyAdapter(config, async () => new Response(null, { status: 403 }));
  assert.equal(
    (
      await deny.authorize({
        userAccessToken: "user",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-b" },
      })
    ).outcome,
    "denied",
  );
  assert.equal(
    (
      await deny.authorize({
        userAccessToken: "user",
        action: "not-declared",
        resource: { kind: "repository", repoId: "repo-a" },
      })
    ).reasonCode,
    "unknown_scope",
  );
  const unavailable = new KeycloakPolicyAdapter(config, async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(
    unavailable.authorize({
      userAccessToken: "user",
      action: "task-create",
      resource: { kind: "entity", repoId: "repo-a", entityRef: "task/task_123" },
    }),
    /offline/u,
  );
});

test("group validation rejects unknown scopes and inheritance cycles before any Keycloak write", () => {
  const adapter = new KeycloakPolicyAdapter(config, async () => new Response(null, { status: 500 }));
  assert.throws(
    () => adapter.validatePolicyGroups([{ id: "custom", base: false, scopes: ["unknown"], composites: [] }]),
    /Unknown/u,
  );
  assert.throws(
    () =>
      adapter.validatePolicyGroups([
        { id: "a", base: false, scopes: [], composites: ["b"] },
        { id: "b", base: false, scopes: [], composites: ["a"] },
      ]),
    /cycle/u,
  );
});
