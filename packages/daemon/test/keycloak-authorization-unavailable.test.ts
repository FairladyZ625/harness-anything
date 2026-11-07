// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { code as hostErrorCode } from "../src/daemon-host-errors.ts";
import { isKeycloakTransportFailure } from "../src/keycloak-transport-failure.ts";
import { rpcServerErrorCode } from "../src/protocol/json-rpc-dispatch-support.ts";
import { evaluateKeycloakPerson, evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl } from "./keycloak.fixtures.ts";

const url = "http://127.0.0.1:1";

function connectionRefusedFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    });
  }) as unknown as typeof fetch;
}

test("a Keycloak transport failure keeps the real cause but is not a generic daemon_error", async () => {
  const provider = new KeycloakPolicyAdapter(
      { url, realm: "harness", resourceServerClientId: "harness-center" },
      connectionRefusedFetch(),
    ),
    center = async () => ({ url, realm: "harness", accessToken: "center-token", provider });

  await assert.rejects(
    evaluateKeycloakPerson({
      credential: {
        session: {
          provider,
          personId: "person-transport",
          accessToken: "user-token",
          url,
          realm: "harness",
          clientId: "harness-center",
        },
        center,
      },
      personId: "person-transport",
      action: "task-create",
      resource: { kind: "repository", repoId: "repo-transport" },
    }),
    (error: Error & { readonly code?: string }) => {
      // The authorization never reached Keycloak, so the receipt must say the identity authority
      // is unavailable instead of classifying an expected transport transient as daemon_error.
      assert.equal(error.code, "keycloak_unavailable");
      assert.match(error.message, /identity authority/u);
      assert.ok(error.cause instanceof Error, "the original transport failure remains attached");
      return true;
    },
  );
});

test("an HTTP 5xx from the authority is a transport failure, not a policy rejection", () => {
  assert.equal(
    isKeycloakTransportFailure(
      Object.assign(new Error("Keycloak userinfo returned HTTP 503."), {
        code: "keycloak_admin_rejected",
        status: 503,
      }),
    ),
    true,
  );
  assert.equal(
    isKeycloakTransportFailure(
      Object.assign(new Error("Keycloak userinfo returned HTTP 401."), {
        code: "keycloak_admin_rejected",
        status: 401,
      }),
    ),
    false,
  );
});

test("a typed session failure keeps its code instead of inheriting a nested fetch failure", () => {
  const sessionFailure = Object.assign(
    new Error("Keycloak could not be reached to renew the session.", {
      cause: new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    }),
    { code: "oidc_session_unavailable" },
  );
  assert.equal(isKeycloakTransportFailure(sessionFailure), false);
});

test("a cold center token before execution-credential verification is a retryable identity outage", async () => {
  const provider = new KeycloakPolicyAdapter(
      { url, realm: "harness", resourceServerClientId: "harness-center" },
      connectionRefusedFetch(),
    ),
    centerFailure = Object.assign(new Error("Keycloak could not be reached to acquire a center token."), {
      code: "daemon_error",
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  await assert.rejects(
    evaluateRepoCellAction({
      action: { kind: "task-create", taskId: "task-f3", title: "F3" },
      binding: {
        actor: { principal: { personId: "person-f3" }, executor: null },
        source: "local",
        executionPrincipal: {
          personId: "person-f3",
          repoId: "repo-f3",
          runtimeSessionId: "runtime-f3",
          dispatchId: "dispatch-f3",
          taskId: "task-f3",
          executionId: "exec-f3",
          role: "implementation",
          source: "local",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        } as never,
        keycloakAuthorization: {
          session: {
            provider,
            personId: "person-f3",
            accessToken: "user-token",
            url,
            realm: "harness",
            clientId: "harness-center",
          },
          center: async () => {
            throw centerFailure;
          },
        },
      },
      actionId: "action-f3",
      repoId: "repo-f3",
      revision: 1,
      now: "2026-11-02T00:00:00.000Z",
    }),
    (error: Error & { readonly code?: string }) => {
      // The execution credential is verified before any task action. A cold center token here is
      // still pre-execution and must use the same recoverable identity classification.
      assert.equal(error.code, "keycloak_unavailable");
      assert.match(error.message, /verifying the runtime execution credential/u);
      return true;
    },
  );
  assert.equal(
    isKeycloakTransportFailure(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })),
    true,
    "a raw fetch rejection is recognized by the shared classifier",
  );
});

test("missing user authorization context names the repo-cell binding boundary", async () => {
  const decision = await evaluateRepoCellAction({
    action: { kind: "task-create", title: "Missing authorization context" },
    binding: {
      actor: { principal: { personId: "person-missing-context" }, executor: null },
      source: { kind: "node", nodeId: "edge-one" },
    },
    actionId: "missing-context-action",
    repoId: "repo-missing-context",
    revision: 9,
    now: "2026-11-07T00:00:00.000Z",
  });

  assert.equal(decision.outcome, "denied");
  assert.deepEqual(decision.reasonCodes, ["authorization_context_missing"]);
  assert.match(decision.nextActions.join(" "), /RepoCellBinding\.keycloakAuthorization/u);
  assert.match(decision.nextActions.join(" "), /daemon host binding and Fleet writer handoff/u);
  assert.ok(decision.bindingsUsed.some((binding) => binding.scope === "task-create"));
});

test("a valid identity without a policy grant still receives the grant remediation", async () => {
  const keycloak = fakeKeycloak(),
    provider = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      keycloak.fetch,
    ),
    personId = "person-without-grant",
    accessToken = keycloak.account(personId);
  await provider.syncBasePolicy("center-token");
  const decision = await evaluateRepoCellAction({
    action: { kind: "task-create", title: "Denied by policy" },
    binding: {
      actor: { principal: { personId }, executor: null },
      source: "local",
      keycloakAuthorization: {
        session: {
          provider,
          personId,
          accessToken,
          url: keycloakUrl,
          realm: keycloakRealm,
          clientId: "harness-center",
        },
      },
    },
    actionId: "policy-denial-action",
    repoId: "repo-without-grant",
    revision: 10,
    now: "2026-11-07T00:00:00.000Z",
    fetchPort: keycloak.fetch,
  });

  assert.equal(decision.outcome, "denied");
  assert.deepEqual(decision.reasonCodes, ["keycloak_denied"]);
  assert.match(decision.nextActions.join(" "), /Request policy group .* from an access administrator/u);
  assert.match(decision.nextActions.join(" "), /ha bootstrap --operation grant/u);
});

test("a Keycloak Admin write transport failure keeps its non-retryable daemon_error code", () => {
  const error = Object.assign(new Error("Keycloak Admin REST /groups could not be reached."), {
    code: "daemon_error",
  });
  // Admin REST writes are not authorization reads: a lost response may mean Keycloak already applied
  // the change. Only the authorization-stage wrapper may turn this sentinel into a retryable code.
  assert.equal(rpcServerErrorCode(error), "daemon_error");
  assert.equal(hostErrorCode(error), "daemon_error");
});
