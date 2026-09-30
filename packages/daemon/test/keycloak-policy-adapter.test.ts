// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionDeclarations } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";

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

test("RepoCell online evaluation uses the authenticated token and exact repository or entity resource", async () => {
  const permissions: string[] = [],
    binding = {
      actor: { principal: { personId: "person-a" }, executor: null },
      source: "local" as const,
      keycloakAuthorization: {
        accessToken: "user-token",
        url: config.url,
        realm: config.realm,
        clientId: config.resourceServerClientId,
      },
    },
    fetchPort = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-token");
      permissions.push(new URLSearchParams(String(init?.body)).get("permission") ?? "");
      return Response.json({ result: true });
    };
  const repository = await evaluateRepoCellAction({
      action: { kind: "repo-bootstrap" },
      binding,
      actionId: "action-repository",
      repoId: "repo-a",
      revision: 4,
      now: "2026-09-30T00:00:00.000Z",
      fetchPort,
    }),
    entity = await evaluateRepoCellAction({
      action: { kind: "task-start", taskId: "task_123" },
      binding,
      actionId: "action-entity",
      repoId: "repo-b",
      revision: 5,
      now: "2026-09-30T00:00:01.000Z",
      fetchPort,
    }),
    missing = await evaluateRepoCellAction({
      action: { kind: "task-start", taskId: "task_123" },
      binding: { actor: binding.actor, source: "local" },
      actionId: "action-missing-session",
      repoId: "repo-b",
      revision: 6,
      now: "2026-09-30T00:00:02.000Z",
      fetchPort,
    });
  assert.equal(repository.outcome, "allowed");
  assert.equal(entity.outcome, "allowed");
  assert.deepEqual(permissions, ["repo-a#repo-bootstrap", "repo-b:task/task_123#task-start"]);
  assert.deepEqual(missing.reasonCodes, ["authentication_required"]);
});

test("RepoCell keeps existing RoleBinding and assignment authorization until their owning slices retire them", async () => {
  const actor = { principal: { personId: "person-legacy" }, executor: null },
    common = {
      actor,
      source: "local" as const,
      authorizationBindingMode: "declared" as const,
    },
    roleAllowed = await evaluateRepoCellAction({
      action: { kind: "task-create" },
      binding: {
        ...common,
        roleBindings: [
          {
            actor: { kind: "person", id: actor.principal.personId },
            role: "repo-write",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        ],
      },
      actionId: "action-role-binding",
      repoId: "repo-a",
      revision: 7,
      now: "2026-09-30T00:00:03.000Z",
    }),
    assignmentAllowed = await evaluateRepoCellAction({
      action: { kind: "task-create" },
      binding: {
        ...common,
        source: { kind: "assignment", nodeId: "node-a", assignmentId: "assignment-a" } as const,
        assignmentScope: {
          repoId: "repo-a",
          scope: { kind: "repository", ref: "repo-a" },
        },
      },
      actionId: "action-assignment",
      repoId: "repo-a",
      revision: 8,
      now: "2026-09-30T00:00:04.000Z",
    }),
    noImplicitDefault = await evaluateRepoCellAction({
      action: { kind: "task-create" },
      binding: common,
      actionId: "action-no-default",
      repoId: "repo-a",
      revision: 9,
      now: "2026-09-30T00:00:05.000Z",
    });
  assert.equal(roleAllowed.outcome, "allowed");
  assert.equal(assignmentAllowed.outcome, "allowed");
  assert.equal(noImplicitDefault.outcome, "denied");
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
