// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskAssignmentMatches, verifyDelegatedExecutionToken } from "@harness-anything/kernel";
import { binding } from "../src/daemon-host-binding.ts";
import { evaluateKeycloakPrincipal } from "../src/repo-cell-authorization.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

// dec_2665E58BA5AE42E37793193748/CH1: the owner is not the node's acting principal.
const principal = { kind: "machine", nodeId: "compute-a", subject: "service-account-a" } as const;
const machine = { principal, executor: null };
const center = async () => ({
  url: "https://keycloak.example",
  realm: "harness",
  clientId: "harness-center",
  accessToken: "center-token",
});
const auth = {
  transportKind: "fleet-tls",
  nodePrincipal: { nodeId: principal.nodeId, subject: principal.subject, personId: "owner" },
  keycloakCenter: center,
} as const;

test("fleet binding uses machine or actual login, preserving node provenance and center", async () => {
  const compute = await binding("unused", auth);
  assert.deepEqual(compute.actor, machine);
  assert.deepEqual(compute.source, { kind: "node", nodeId: principal.nodeId });
  assert.equal(compute.keycloakAuthorization?.center, center);
  const human = await binding("unused", {
    ...auth,
    oidcPrincipal: {
      personId: "different-human",
      subject: "person-subject",
      expiresAt: Date.now() + 60_000,
      accessToken: "human-token",
      authority: { url: "https://keycloak.example", realm: "harness", clientId: "harness-center" },
    },
  });
  assert.deepEqual(human.actor.principal, { personId: "different-human" });
  assert.deepEqual(human.source, compute.source);
  assert.equal(human.keycloakAuthorization?.session?.personId, "different-human");
  await assert.rejects(binding("unused", { ...auth, nodePrincipal: undefined }), { code: "authentication_required" });
  await assert.rejects(binding("unused", { ...auth, keycloakCenter: undefined }), { code: "authentication_required" });
});

test("machine claim requires a live explicit node assignment", () => {
  const now = "2026-10-10T00:00:00.000Z",
    expiresAt = "2026-10-11T00:00:00.000Z";
  const claimant = { principal, nodeId: principal.nodeId, teamIds: [] };
  assert.equal(
    taskAssignmentMatches({ assignee: { kind: "node", nodeId: principal.nodeId }, expiresAt }, claimant, now),
    true,
  );
  for (const assignment of [
    null,
    { assignee: { kind: "node", nodeId: "other" } as const, expiresAt },
    { assignee: { kind: "person", personId: "owner" } as const, expiresAt },
    { assignee: { kind: "node", nodeId: principal.nodeId } as const, expiresAt: now },
  ])
    assert.equal(taskAssignmentMatches(assignment, claimant, now), false);
});

test("delegation binds the typed issuer and runtime, never the accountability owner", () => {
  const token = {
    schema: "delegated-execution-token/v1",
    tokenId: "det_a",
    issuer: principal,
    delegate: { runtimeSessionId: "run-a" },
    allowedActions: ["task-submit"],
    issuedAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-11T00:00:00.000Z",
    revokedAt: null,
  };
  const actor = { principal, executor: { kind: "agent", id: "runtime-session:run-a" } } as const;
  assert.equal(verifyDelegatedExecutionToken(token, actor, "task-submit", token.issuedAt).ok, true);
  assert.equal(
    verifyDelegatedExecutionToken(token, { ...actor, principal: { personId: "owner" } }, "task-submit", token.issuedAt)
      .ok,
    false,
  );
  assert.equal(verifyDelegatedExecutionToken(token, actor, "task-complete", token.issuedAt).ok, false);
});

test("Keycloak evaluates the machine subject's independent grant", async () => {
  const keycloak = fakeKeycloak();
  keycloak.account("owner");
  keycloak.permit("owner", "repo", ["task-start"]);
  const adapter = new KeycloakPolicyAdapter(
    { url: "https://keycloak.example", realm: "harness", resourceServerClientId: "harness-center" },
    keycloak.fetch,
  );
  const request = {
    credential: { center },
    principal,
    action: "task-start",
    resource: { kind: "repository", repoId: "repo" } as const,
    fetchPort: keycloak.fetch,
  };
  assert.equal((await evaluateKeycloakPrincipal(request)).outcome, "denied", "owner grant does not authorize node");
  await adapter.writeGrant("center-token", { groupId: "contributor", resource: "repo", userIds: [principal.subject] }, [
    "task-start",
  ]);
  assert.equal((await evaluateKeycloakPrincipal(request)).outcome, "allowed");
  assert.equal(
    (await evaluateKeycloakPrincipal({ ...request, resource: { kind: "repository", repoId: "other" } })).outcome,
    "denied",
  );
});
