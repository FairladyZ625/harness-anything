// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "./keycloak.fixtures.ts";

test("work teams use native membership, reject stale edits, and do not grant business permissions", async (t) => {
  const kc = fakeKeycloak(),
    user = keycloakUserRoot(),
    teamCleanup = user.cleanup,
    oidc = new OidcSessionService(user.root, { fetch: kc.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: kc.fetch }),
    adapter = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      kc.fetch,
    ),
    run = (request: Parameters<typeof admin.run>[0]) => admin.run({ operationId: randomUUID(), ...request });
  t.after(teamCleanup);
  kc.account("alice");
  await adapter.syncBasePolicy("center-token");
  assert.equal((await run({ operation: "team-create", teamName: "Builders" })).outcome, "applied");
  const list = async () =>
    (await run({ operation: "team-list" })).teams as {
      id: string;
      name: string;
      version: string;
      personIds: string[];
    }[];
  const first = (await list())[0]!;
  assert.deepEqual(first.personIds, []);
  assert.equal(
    (await run({ operation: "team-member-add", teamId: first.id, personId: "alice", expectedVersion: first.version }))
      .outcome,
    "applied",
  );
  assert.deepEqual(await adapter.readPersonTeams("center-token", "alice"), [first.id]);
  const stale = await run({ operation: "team-delete", teamId: first.id, expectedVersion: first.version });
  assert.equal(stale.code, "version_conflict");
  assert.equal(
    (
      await adapter.authorizePerson({
        adminAccessToken: "center-token",
        personId: "alice",
        action: "task-start",
        resource: { kind: "repository", repoId: "repo-a" },
      })
    ).outcome,
    "denied",
  );
  const second = (await list())[0]!;
  assert.deepEqual(second.personIds, ["alice"]);
  assert.equal(
    (
      await run({
        operation: "team-member-remove",
        teamId: first.id,
        personId: "alice",
        expectedVersion: second.version,
      })
    ).outcome,
    "applied",
  );
  assert.deepEqual(await adapter.readPersonTeams("center-token", "alice"), []);
  const third = (await list())[0]!;
  assert.equal(
    (await run({ operation: "team-update", teamId: third.id, teamName: "Reviewers", expectedVersion: third.version }))
      .outcome,
    "applied",
  );
  const last = (await list())[0]!;
  assert.equal(last.name, "Reviewers");
  assert.equal(
    (await run({ operation: "team-delete", teamId: last.id, expectedVersion: last.version })).outcome,
    "applied",
  );
  assert.deepEqual(await list(), []);
});
