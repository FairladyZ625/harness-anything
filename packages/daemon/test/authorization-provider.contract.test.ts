// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRepoCellAction, authorizeRepoCellAction } from "../src/repo-cell-authorization.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

test("an injected non-Keycloak provider authorizes through the real daemon and kernel boundary", async () => {
  const requests: string[] = [];
  const provider: NonNullable<NonNullable<RepoCellBinding["keycloakAuthorization"]>["session"]>["provider"] = {
    policyRef: "local-policy@1",
    authority: "local",
    deniedReasonCode: "local_denied",
    validateUserAccessToken: async () => true,
    authorizePerson: async () => {
      throw new Error("no center credential is used by this session");
    },
    authorize: async ({ action, resource }) => {
      requests.push(action);
      assert.deepEqual(resource, { kind: "repository", repoId: "repo-local" });
      return { outcome: "allowed", reasonCode: "local_allowed", resource: "repo-local", scope: action };
    },
  };
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "local-person" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider,
        personId: "local-person",
        accessToken: "local-session",
        url: "local:",
        realm: "local",
        clientId: "local",
      },
    },
  };
  const input = {
    action: { kind: "task-create" as const, title: "local provider" },
    binding,
    actionId: "local-action",
    repoId: "repo-local",
    revision: 3,
    now: "2026-11-01T00:00:00Z",
  };
  const decision = await evaluateRepoCellAction(input);
  assert.equal(decision.policyRef, "local-policy@1");
  const result = authorizeRepoCellAction({ ...input, binding: { ...binding, authorizationDecision: decision } });
  assert.equal(result.outcome, "allowed");
  assert.deepEqual(requests, ["task-create"]);
  assert.equal(
    authorizeRepoCellAction({ ...input, revision: 4, binding: { ...binding, authorizationDecision: decision } })
      .outcome,
    "denied",
  );
});
