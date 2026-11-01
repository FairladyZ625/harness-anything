// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { withOnlineRuntimeSession, type RuntimeOperatorSession } from "../src/runtime-online-binding.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

const operatorSession: RuntimeOperatorSession = {
  personId: "person_owner_1",
  accessToken: "test-operator-access-token",
  url: "https://keycloak.test",
  realm: "harness-test",
  clientId: "harness-center",
};

function localBinding(personId = "person_owner_1"): RepoCellBinding {
  return {
    actor: { principal: { personId }, executor: { kind: "agent", id: "runtime-session:runtime-1" } },
    source: "local",
  };
}

test("a persisted local binding regains the daemon's current operator session", async () => {
  const binding = localBinding(),
    center = async () => ({ accessToken: "test-center-access-token" }) as never,
    online = await withOnlineRuntimeSession(binding, async () => operatorSession, center);
  assert.deepEqual(online.keycloakAuthorization?.session, operatorSession);
  assert.equal(online.keycloakAuthorization?.center, center);
  assert.equal(online.actor, binding.actor);
  assert.equal(online.source, "local");
});

test("a device-scoped binding never borrows the daemon's local session", async () => {
  let reads = 0;
  const online = await withOnlineRuntimeSession(
    {
      actor: { principal: { personId: "person_owner_1" }, executor: null },
      source: { kind: "node", nodeId: "node-1" },
    },
    async () => {
      reads += 1;
      return operatorSession;
    },
  );
  assert.equal(reads, 0);
  assert.equal(online.keycloakAuthorization, undefined);
});

test("a session owned by another person is rejected before any launch", async () => {
  await assert.rejects(
    withOnlineRuntimeSession(localBinding(), async () => ({ ...operatorSession, personId: "person_someone_else" })),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "authentication_required",
  );
});
