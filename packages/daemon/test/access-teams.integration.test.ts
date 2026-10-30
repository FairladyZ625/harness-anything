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
    teamReads: string[] = [],
    countedFetch: typeof fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        response = await kc.fetch(input, init),
        url = new URL(rawUrl);
      if (url.pathname.includes("/users") || url.pathname.includes("/groups"))
        teamReads.push(`${response.status} ${url.pathname}${url.search}`);
      return response;
    },
    user = keycloakUserRoot(),
    teamCleanup = user.cleanup,
    oidc = new OidcSessionService(user.root, { fetch: kc.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: kc.fetch }),
    adapter = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      countedFetch,
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
  teamReads.length = 0;
  const firstReadStartedAt = performance.now(),
    firstTeams = await adapter.readPersonTeams("center-token", "alice"),
    firstReadElapsedMs = performance.now() - firstReadStartedAt,
    firstReadRequests = [...teamReads];
  assert.deepEqual(firstTeams, [first.id]);
  assert.equal(firstReadRequests.filter((request) => request.includes("/users?q=")).length, 1);
  assert.equal(firstReadRequests.filter((request) => request.includes("/groups?")).length, 1);
  teamReads.length = 0;
  const stale = await run({ operation: "team-delete", teamId: first.id, expectedVersion: first.version });
  assert.equal(stale.code, "version_conflict");
  assert.equal(
    (
      await adapter.authorize({
        userAccessToken: "token-alice",
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
  const secondAdapter = new KeycloakPolicyAdapter(
    { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
    countedFetch,
  );
  const secondReadStartedAt = performance.now(),
    secondTeams = await secondAdapter.readPersonTeams("center-token", "alice"),
    secondReadElapsedMs = performance.now() - secondReadStartedAt,
    secondReadRequests = [...teamReads];
  assert.deepEqual(secondTeams, []);
  assert.equal(secondReadRequests.filter((request) => request.includes("/users?q=")).length, 0);
  assert.equal(secondReadRequests.filter((request) => request.includes("/groups?")).length, 1);
  console.log(
    JSON.stringify({
      perf: "readPersonTeams",
      fixture: "in-memory Keycloak (not production latency)",
      calls: [
        { elapsedMs: firstReadElapsedMs, requests: firstReadRequests },
        { elapsedMs: secondReadElapsedMs, requests: secondReadRequests },
      ],
    }),
  );
  let rejectNextGroupRead = true;
  const staleReads: string[] = [],
    staleFetch: typeof fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        url = new URL(rawUrl);
      if (rejectNextGroupRead && url.pathname === "/admin/realms/harness/users/user-1/groups") {
        rejectNextGroupRead = false;
        staleReads.push(`404 ${url.pathname}${url.search}`);
        return new Response("{}", { status: 404 });
      }
      const response = await countedFetch(input, init);
      if (url.pathname.includes("/users") || url.pathname.includes("/groups"))
        staleReads.push(`${response.status} ${url.pathname}${url.search}`);
      return response;
    },
    staleAdapter = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      staleFetch,
    );
  await assert.rejects(staleAdapter.readPersonTeams("center-token", "alice"), { status: 404 });
  assert.deepEqual(
    staleReads.map((request) => request.split(" ")[0]),
    ["200", "404"],
    "stale user identifiers fail the current request without retry",
  );
  staleReads.length = 0;
  assert.deepEqual(await staleAdapter.readPersonTeams("center-token", "alice"), []);
  assert.equal(staleReads.filter((request) => request.includes("/users?q=")).length, 1);
  assert.equal(staleReads.filter((request) => request.includes("/groups?")).length, 1);
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
