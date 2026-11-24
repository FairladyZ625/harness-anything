// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createCloudQueryHost } from "../src/fleet-sync/cloud-query-host.ts";

test("task claimable fails closed when task-start authority is absent", async () => {
  const host = createCloudQueryHost({
    pool: {} as never,
    authorizer: {
      authorizeRepositoryRead: async () => ({ outcome: "allowed", personId: "person_owner" }),
    },
    repositories: new Map([["repo", { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 }]]),
    maxInFlight: 2,
  });
  const response = await host(
    new Request("http://cloud.local/v1/repositories/repo/task-claimable", {
      headers: { authorization: "Bearer token" },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "claim_authorization_unavailable" } });
});
