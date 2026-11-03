// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { code as hostErrorCode } from "../src/daemon-host-errors.ts";
import { isKeycloakTransportFailure } from "../src/keycloak-transport-failure.ts";
import { rpcServerErrorCode } from "../src/protocol/json-rpc-dispatch-support.ts";
import { evaluateKeycloakPerson, evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";

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

test("a Keycloak Admin write transport failure keeps its non-retryable daemon_error code", () => {
  const error = Object.assign(new Error("Keycloak Admin REST /groups could not be reached."), {
    code: "daemon_error",
  });
  // Admin REST writes are not authorization reads: a lost response may mean Keycloak already applied
  // the change. Only the authorization-stage wrapper may turn this sentinel into a retryable code.
  assert.equal(rpcServerErrorCode(error), "daemon_error");
  assert.equal(hostErrorCode(error), "daemon_error");
});
