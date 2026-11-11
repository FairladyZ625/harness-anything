// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { getEntityKindContract, type AuthorizationPermissionDecision } from "@harness-anything/kernel";
import { preparePersonActionExplanationBinding } from "../src/task-action-explanation-read.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

const now = () => "2026-11-11T00:00:00.000Z";

function authority() {
  const calls: string[] = [];
  let outcome: AuthorizationPermissionDecision["outcome"] = "allowed";
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "same-id" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        personId: "same-id",
        accessToken: "test-token",
        url: "https://authority.example.test",
        realm: "fixture",
        clientId: "fixture",
        provider: {
          policyRef: "test-policy@1",
          authority: "fixture",
          deniedReasonCode: "keycloak_denied",
          validateUserAccessToken: async () => true,
          authorizePerson: async () => assert.fail("session-only evaluation expected"),
          authorize: async ({ action, resource }) => {
            calls.push(`${resource.kind === "entity" ? resource.entityRef : "repository"}:${action}`);
            return {
              outcome,
              reasonCode: outcome === "allowed" ? "keycloak_allowed" : "keycloak_denied",
              resource: "fixture",
              scope: action,
            };
          },
        },
      },
    },
  };
  return {
    calls,
    binding,
    revoke: () => {
      outcome = "denied";
    },
  };
}

function prepare(refs: readonly string[], binding: RepoCellBinding) {
  return preparePersonActionExplanationBinding(
    { revision: 7, repoId: "explain-repetition", now, binding },
    { schema: "entity-action-explain-request/v1", mode: "object", entityKind: null, refs },
  );
}

for (const unique of [1, 2]) {
  test(`explain authorizes each of ${unique} unique targets once at every request size`, async (t) => {
    const { calls, binding } = authority(),
      actionCount = getEntityKindContract("task")!.actionCatalog!.actions.filter(
        (action) => action.execution?.ingress,
      ).length;
    for (const size of [unique, 20, 100, 500]) {
      calls.length = 0;
      const refs = Array.from({ length: size }, (_, index) => `task/task-${index % unique}`),
        started = performance.now(),
        prepared = await prepare(refs, binding);
      t.diagnostic(
        JSON.stringify({
          positions: size,
          unique,
          actionCount,
          calls: calls.length,
          durationMs: performance.now() - started,
        }),
      );
      assert.equal(calls.length, unique * actionCount);
      assert.equal(new Set(calls).size, calls.length);
      assert.equal(prepared.explanationDecisions?.size, unique * actionCount);
    }
  });
}

test("explain deduplicates full refs across supported kinds and reauthorizes the next request", async () => {
  const { calls, binding, revoke } = authority(),
    refs = ["task/same-id", "squad/same-id", "person/same-id"],
    first = await prepare([...refs, ...refs, "invalid", "fact/F-ABCDEFGH", "other:task/same-id"], binding),
    callCount = calls.length;
  assert.equal(callCount, new Set(calls).size);
  for (const ref of refs) {
    assert.ok([...first.explanationDecisions!.keys()].some((key) => key.startsWith(`${ref}:`)));
  }
  assert.deepEqual([...first.personExplanation!.existsIds], ["same-id"]);
  assert.equal(first.explanationDecisions!.size, callCount);
  revoke();
  const second = await prepare(refs, first);
  assert.equal(calls.length, callCount * 2);
  assert.ok([...second.explanationDecisions!.values()].every((decision) => decision.outcome === "denied"));
});
