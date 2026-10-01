// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionDeclarations, deriveBasePolicyGroups } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { authorizeRepoCellAction, evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

const config = { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" };

test("sync derives every Keycloak scope and four composite Base roles, and no permission that is not bound to a resource", async () => {
  const keycloak = fakeKeycloak(),
    receipt = await new KeycloakPolicyAdapter(config, keycloak.fetch).syncBasePolicy("admin-token");
  assert.deepEqual(receipt, { scopeCount: actionDeclarations.length, groupCount: 4 });
  assert.equal(keycloak.scopes.size, actionDeclarations.length);
  assert.deepEqual([...keycloak.roles.keys()].sort(), ["admin", "contributor", "maintainer", "viewer"]);
  assert.deepEqual(
    ["admin", "maintainer", "contributor", "viewer"].map((id) => [...keycloak.roles.get(id)!.composites]),
    [["maintainer"], ["contributor"], ["viewer"], []],
  );
  // A Base group is a configuration unit; holding it grants nothing until it is granted on a resource.
  assert.deepEqual([keycloak.permissions.size, keycloak.userPolicies.size, keycloak.resources.size], [0, 0, 0]);
  assert.equal(
    keycloak.profile.attributes.some(({ name }) => name === "harness_person_id"),
    true,
  );
});

test("sync reads complete paginated collections and does not recreate existing entries", async () => {
  const keycloak = fakeKeycloak(),
    adapter = new KeycloakPolicyAdapter(config, keycloak.fetch);
  await adapter.syncBasePolicy("admin-token");
  assert.equal(keycloak.scopes.size > 100, true, "the scope collection spans more than one page");
  keycloak.writes.length = 0;
  assert.deepEqual(await adapter.syncBasePolicy("admin-token"), {
    scopeCount: actionDeclarations.length,
    groupCount: 4,
  });
  assert.deepEqual(
    keycloak.writes.filter((write) => !write.endsWith("/composites")),
    [],
  );
});

test("sync re-expands stored grants to the currently declared actions of their group", async () => {
  const keycloak = fakeKeycloak(),
    adapter = new KeycloakPolicyAdapter(config, keycloak.fetch),
    contributor = deriveBasePolicyGroups().find((group) => group.id === "contributor")!;
  await adapter.syncBasePolicy("admin-token");
  await adapter.writeGrant("admin-token", { groupId: "contributor", resource: "repo-a", userIds: ["user-a"] }, [
    "task-create",
  ]);
  const [permission] = [...keycloak.permissions.values()],
    [resource] = [...keycloak.resources.values()];
  resource!.scopes = [{ name: "task-create" }];
  await adapter.syncBasePolicy("admin-token");
  assert.deepEqual(permission!.scopes, contributor.scopes);
  assert.equal(resource!.scopes.length, actionDeclarations.length);
  assert.deepEqual(await adapter.readGrants("admin-token"), [
    { groupId: "contributor", resource: "repo-a", userIds: ["user-a"] },
  ]);
  // A grant whose group expands to no action keeps its holders and leaves no permission behind.
  await adapter.writeGrant(
    "admin-token",
    { groupId: "viewer", resource: "repo-a:task/task_1", userIds: ["user-a"] },
    [],
  );
  assert.deepEqual(
    [...keycloak.permissions.values()].map((item) => item.name),
    ["grant:contributor:repo-a"],
  );
  assert.equal((await adapter.readGrants("admin-token")).length, 2);
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

test("RepoCell online evaluation uses the authenticated token and asks for the repository before the exact entity", async () => {
  const permissions: string[] = [],
    binding = {
      actor: { principal: { personId: "person-a" }, executor: null },
      source: "local" as const,
      keycloakAuthorization: {
        session: {
          personId: "person-a",
          accessToken: "user-token",
          url: config.url,
          realm: config.realm,
          clientId: config.resourceServerClientId,
        },
      },
    },
    fetchPort = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-token");
      const permission = new URLSearchParams(String(init?.body)).get("permission") ?? "";
      permissions.push(permission);
      // Repository B itself is not granted; only its one task is.
      return permission === "repo-b#task-start"
        ? Response.json({ error: "access_denied" }, { status: 403 })
        : Response.json({ result: true });
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
  assert.deepEqual(permissions, ["repo-a#repo-bootstrap", "repo-b#task-start", "repo-b:task/task_123#task-start"]);
  assert.deepEqual(missing.reasonCodes, ["authentication_required"]);
});

test("RepoCell keeps RoleBinding authorization until its owning slice retires it; a node qualifies nobody", async () => {
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
    throughNodeOnly = await evaluateRepoCellAction({
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
  // Arriving through a node is where a write came from, not a reason to allow it.
  assert.equal(throughNodeOnly.outcome, "denied");
  assert.equal(noImplicitDefault.outcome, "denied");
});

test("synchronous RepoCell authorization does not fall back to roster for a mismatched Keycloak scope", () => {
  const action = { kind: "task-create" as const },
    decision = authorizeRepoCellAction({
      action,
      binding: {
        actor: { principal: { personId: "person-keycloak" }, executor: null },
        source: "local",
        keycloakAuthorization: {
          session: {
            personId: "person-keycloak",
            accessToken: "user-token",
            url: config.url,
            realm: config.realm,
            clientId: config.resourceServerClientId,
          },
        },
        authorizationDecision: {
          policyRef: "keycloak-policy@1",
          actor: { principal: { personId: "person-keycloak" }, executor: null },
          subject: "settings/repository",
          bindingsUsed: [{ authority: "keycloak", scope: "task-start" }],
          outcome: "allowed",
          reasonCodes: ["keycloak_allowed"],
          nextActions: [],
          evaluatedAtCut: "canonical:9",
        },
        authorizationBindingMode: "declared",
        roleBindings: [
          {
            actor: { kind: "person", id: "person-keycloak" },
            role: "repo-write",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        ],
      },
      actionId: "action-scope-mismatch",
      revision: 10,
      now: "2026-09-30T00:00:06.000Z",
    });
  assert.equal(decision.outcome, "denied");
  assert.equal(decision.policyRef, "keycloak-policy@1");
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
