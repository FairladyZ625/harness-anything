// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { evaluateKeycloakPerson } from "../src/repo-cell-authorization.ts";

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
