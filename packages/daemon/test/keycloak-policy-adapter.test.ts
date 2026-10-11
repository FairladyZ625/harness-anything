// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionDeclarations, deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import {
  authorizeRepoCellAction,
  evaluateRepoCellAction,
  evaluateKeycloakPerson,
} from "../src/repo-cell-authorization.ts";
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
    contributorScopes = effectivePolicyGroupScopes(deriveBasePolicyGroups(), "contributor");
  await adapter.syncBasePolicy("admin-token");
  await adapter.writeGrant("admin-token", { groupId: "contributor", resource: "repo-a", userIds: ["user-a"] }, [
    "task-create",
  ]);
  const [permission] = [...keycloak.permissions.values()],
    [resource] = [...keycloak.resources.values()];
  resource!.scopes = [{ name: "task-create" }];
  await adapter.syncBasePolicy("admin-token");
  assert.deepEqual(permission!.scopes, contributorScopes);
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

test("retired roster bindings and machine authentication confer no repository permission", async () => {
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
        source: { kind: "node", nodeId: "node-a" } as const,
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
  assert.equal(roleAllowed.outcome, "denied");
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

test("Admin REST rejection exposes a stable code", async () => {
  const adapter = new KeycloakPolicyAdapter(config, async () => new Response(null, { status: 401 }));
  await assert.rejects(
    adapter.findUserId("expired-center-token", "person-a"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { readonly code?: string }).code === "keycloak_admin_rejected" &&
      /HTTP 401/u.test(error.message),
  );
});

test("Admin REST transport failure is infrastructure unavailability, not a policy rejection", async () => {
  const cause = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  });
  const adapter = new KeycloakPolicyAdapter(config, async () => {
    throw cause;
  });
  await assert.rejects(adapter.findUserId("admin-token", "person-one"), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "daemon_error");
    assert.equal(error.cause, cause);
    return true;
  });
});

// dec_F01770FD0DCF72683B7C4C7A47/CH5: identity and center policy are separate requirements.
test("center policy evaluates the matching live session once and can still deny its action", async () => {
  const keycloak = fakeKeycloak(),
    token = keycloak.account("person-center"),
    session = {
      personId: "person-center",
      accessToken: token,
      url: config.url,
      realm: config.realm,
      clientId: config.resourceServerClientId,
    };
  keycloak.permit("person-center", "repo-center", ["task-create"]);
  let centerCalls = 0,
    policyCalls = 0,
    adminReads = 0,
    centerPermits = true,
    centerFails = false;
  const center = async () => {
    centerCalls += 1;
    return {
      url: config.url,
      realm: config.realm,
      clientId: config.resourceServerClientId,
      accessToken: "admin-token",
    };
  };
  const fetchPort: typeof fetch = async (url, init) => {
      if (String(url).includes("/admin/realms/") && !String(url).endsWith("/policy/evaluate")) adminReads += 1;
      if (String(url).endsWith("/policy/evaluate")) {
        policyCalls += 1;
        if (centerFails) return new Response(null, { status: 503 });
        if (!centerPermits) return Response.json({ status: "DENY", results: [{ status: "DENY" }] });
      }
      return keycloak.fetch(url, init);
    },
    evaluate = (credential: Parameters<typeof evaluateKeycloakPerson>[0]["credential"]) =>
      evaluateKeycloakPerson({
        credential,
        personId: "person-center",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-center" },
        fetchPort,
      });
  assert.equal((await evaluate({ center })).outcome, "denied");
  assert.equal((await evaluate({ center, session: { ...session, personId: "other-person" } })).outcome, "denied");
  assert.equal(centerCalls, 0);
  assert.equal((await evaluate({ center, session })).outcome, "allowed");
  assert.equal(policyCalls, 1);
  centerPermits = false;
  assert.equal((await evaluate({ center, session })).outcome, "denied");
  assert.equal(policyCalls, 2);
  centerPermits = true;
  assert.equal((await evaluate({ center, session })).outcome, "allowed");
  assert.equal(centerCalls, 3);
  assert.equal(adminReads, 3, "center ids are retained in process memory");
  centerFails = true;
  await assert.rejects(evaluate({ center, session }), { code: "keycloak_admin_rejected" });
});

test("center policy rejects a session after its current user token is rejected", async () => {
  const keycloak = fakeKeycloak(),
    token = keycloak.account("person-live-token");
  keycloak.permit("person-live-token", "repo-live-token", ["task-create"]);
  let userinfoCalls = 0,
    policyCalls = 0,
    revoked = false;
  const fetchPort: typeof fetch = async (url, init) => {
      const route = String(url);
      if (route.endsWith("/userinfo")) {
        userinfoCalls += 1;
        return revoked ? new Response(null, { status: 401 }) : keycloak.fetch(url, init);
      }
      if (route.endsWith("/policy/evaluate")) policyCalls += 1;
      return keycloak.fetch(url, init);
    },
    credential = {
      session: {
        personId: "person-live-token",
        accessToken: token,
        url: config.url,
        realm: config.realm,
        clientId: config.resourceServerClientId,
      },
      center: async () => ({ ...config, accessToken: "admin-token" }),
    },
    evaluate = () =>
      evaluateKeycloakPerson({
        credential,
        personId: "person-live-token",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-live-token" },
        fetchPort,
      });
  assert.equal((await evaluate()).outcome, "allowed");
  revoked = true;
  assert.deepEqual(await evaluate(), { outcome: "denied", reasonCode: "keycloak_denied" });
  assert.equal(userinfoCalls, 2);
  assert.equal(policyCalls, 1, "a rejected user token must stop before center policy evaluation");
});

test("center policy reuses a valid JWT user token check", async () => {
  const keycloak = fakeKeycloak(),
    token =
      "header." +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 60 })).toString("base64url") +
      ".signature";
  keycloak.account("person-jwt-token");
  keycloak.interactiveSession("person-jwt-token", "jwt", config.url, token);
  keycloak.permit("person-jwt-token", "repo-jwt-token", ["task-create"]);
  const userinfoTokens: string[] = [],
    fetchPort: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/userinfo")) {
        userinfoTokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return keycloak.fetch(config.url + "/realms/harness/protocol/openid-connect/userinfo", init);
      }
      return keycloak.fetch(url, init);
    },
    credential = {
      session: {
        personId: "person-jwt-token",
        accessToken: token,
        url: config.url,
        realm: config.realm,
        clientId: config.resourceServerClientId,
      },
      center: async () => ({ ...config, accessToken: "admin-token" }),
    },
    evaluate = () =>
      evaluateKeycloakPerson({
        credential,
        personId: "person-jwt-token",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-jwt-token" },
        fetchPort,
      });
  assert.equal((await evaluate()).outcome, "allowed");
  assert.equal((await evaluate()).outcome, "allowed");
  assert.equal(userinfoTokens.length, 1);
});

test("center policy rejects an expired JWT before center evaluation", async () => {
  const keycloak = fakeKeycloak(),
    token =
      "header." +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) - 1 })).toString("base64url") +
      ".signature";
  keycloak.account("person-expired-jwt");
  keycloak.interactiveSession("person-expired-jwt", "expired", config.url, token);
  const requests: string[] = [],
    fetchPort: typeof fetch = async (url, init) => {
      requests.push(String(url));
      return keycloak.fetch(url, init);
    },
    decision = await evaluateKeycloakPerson({
      credential: {
        session: {
          personId: "person-expired-jwt",
          accessToken: token,
          url: config.url,
          realm: config.realm,
          clientId: config.resourceServerClientId,
        },
        center: async () => ({ ...config, accessToken: "admin-token" }),
      },
      personId: "person-expired-jwt",
      action: "task-create",
      resource: { kind: "repository", repoId: "repo-expired-jwt" },
      fetchPort,
    });
  assert.deepEqual(decision, { outcome: "denied", reasonCode: "keycloak_denied" });
  assert.equal(
    requests.some((url) => url.endsWith("/policy/evaluate")),
    false,
  );
});

test("a stale cached resource id is discarded and refreshed once after the center rejects it", async () => {
  let resourceReads = 0,
    policyCalls = 0;
  const fetchPort: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users")) return Response.json([{ id: "user-current" }]);
      if (url.pathname.endsWith("/clients")) return Response.json([{ id: "client-current" }]);
      if (url.pathname.endsWith("/resource")) {
        resourceReads += 1;
        return Response.json([{ _id: resourceReads === 1 ? "resource-old" : "resource-new", name: "repo-rebuilt" }]);
      }
      if (url.pathname.endsWith("/policy/evaluate")) {
        policyCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          resources?: readonly { readonly _id?: string }[];
        };
        if (body.resources?.[0]?.["_id"] === "resource-old") return new Response(null, { status: 404 });
        return Response.json({ status: "PERMIT", results: [{ status: "PERMIT" }] });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    },
    adapter = new KeycloakPolicyAdapter({ ...config, realm: "stale-resource-recovery" }, fetchPort);
  assert.equal(
    (
      await adapter.authorizePerson({
        adminAccessToken: "center-token",
        personId: "person-rebuilt",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-rebuilt" },
      })
    ).outcome,
    "allowed",
  );
  assert.equal(resourceReads, 2);
  assert.equal(policyCalls, 2);
});

// dec_B0B79908FE04BBA7766035765B/CH2: identifiers share only a fetch/realm/client namespace.
test("policy identifiers are shared across adapters but isolated across fetch ports and Keycloak configurations", async () => {
  const reads = new Map<string, number>(),
    requests: string[] = [],
    makeFetch =
      (owner: string): typeof fetch =>
      async (input) => {
        const url = new URL(String(input)),
          namespace = `${owner}:${url.origin}:${url.pathname.split("/")[3]}`;
        requests.push(String(input));
        if (url.pathname.endsWith("/users")) {
          reads.set(namespace, (reads.get(namespace) ?? 0) + 1);
          return Response.json([{ id: `${namespace}:user` }]);
        }
        if (url.pathname.endsWith("/clients")) return Response.json([{ id: url.searchParams.get("clientId") }]);
        if (url.pathname.endsWith("/resource"))
          return Response.json([{ _id: `${namespace}:resource`, name: "repo-shared" }]);
        assert.ok(url.pathname.endsWith("/policy/evaluate"));
        return Response.json({ status: "PERMIT", results: [{ status: "PERMIT" }] });
      },
    sharedFetch = makeFetch("first"),
    evaluate = (fetchPort: typeof fetch, overrides: Partial<typeof config> = {}) =>
      new KeycloakPolicyAdapter({ ...config, ...overrides }, fetchPort).authorizePerson({
        adminAccessToken: "center-token",
        personId: "person-shared",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-shared" },
      });
  assert.equal((await evaluate(sharedFetch)).outcome, "allowed");
  assert.equal((await evaluate(sharedFetch)).outcome, "allowed");
  assert.equal(requests.length, 5, "new adapters reuse the same three ids and still evaluate each request");
  assert.equal((await evaluate(makeFetch("second"))).outcome, "allowed");
  assert.equal((await evaluate(sharedFetch, { realm: "another-realm" })).outcome, "allowed");
  assert.equal((await evaluate(sharedFetch, { url: "http://127.0.0.1:8081" })).outcome, "allowed");
  assert.equal((await evaluate(sharedFetch, { resourceServerClientId: "another-client" })).outcome, "allowed");
  assert.equal(requests.filter((url) => new URL(url).pathname.endsWith("/users")).length, 5);
  assert.equal(requests.filter((url) => new URL(url).pathname.endsWith("/clients")).length, 5);
  assert.equal(requests.filter((url) => new URL(url).pathname.endsWith("/resource")).length, 5);
  assert.equal(requests.filter((url) => url.endsWith("/policy/evaluate")).length, 6);
  assert.equal(reads.size, 4);
});

test("missing person and resource identifiers deny without caching misses or substituting another grant", async () => {
  const keycloak = fakeKeycloak(),
    calls: string[] = [],
    fetchPort: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return keycloak.fetch(input, init);
    },
    evaluate = () =>
      new KeycloakPolicyAdapter(config, fetchPort).authorizePerson({
        adminAccessToken: "center-token",
        personId: "person-missing",
        action: "task-create",
        resource: { kind: "repository", repoId: "repo-missing" },
      });
  assert.equal((await evaluate()).outcome, "denied");
  assert.equal(calls.length, 1, "an absent person never reaches policy evaluation");
  keycloak.account("person-missing");
  assert.equal((await evaluate()).outcome, "denied");
  assert.equal(calls.filter((url) => url.endsWith("/policy/evaluate")).length, 0);
  keycloak.permit("person-missing", "repo-missing", ["task-create"]);
  assert.equal((await evaluate()).outcome, "allowed");
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith("/users")).length, 2);
  assert.equal(calls.filter((url) => new URL(url).pathname.endsWith("/resource")).length, 2);
  assert.equal(calls.filter((url) => url.endsWith("/policy/evaluate")).length, 1);
});
