// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test("people.yaml and retired People mutations have no repository authority", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-retired-people-actions-")),
    repoId = workspaceId("retired-people-actions"),
    realm = await serveKeycloak(),
    binding = {
      actor,
      source: "local" as const,
      keycloakAuthorization: {
        session: {
          personId: actor.principal.personId,
          accessToken: realm.keycloak.account(actor.principal.personId),
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
        },
      },
    };
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "retired-people-actions",
    now: () => "2026-10-02T00:00:00.000Z",
  });
  t.after(async () => {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  });
  realm.keycloak.permit(actor.principal.personId, "retired-people-actions", ["task-create"]);
  const permitted = await cell.run({ kind: "task-create", taskId: "task-permitted", title: "Keycloak grant" }, binding);
  assert.equal(permitted.outcome, "applied", JSON.stringify(permitted));
  const revisionAfterGrant = cell.status().ledgerRevision;

  writeFileSync(
    path.join(rootDir, "harness", "people.yaml"),
    JSON.stringify({ schema: "harness-people/v1", people: [{ personId: actor.principal.personId, roles: ["owner"] }] }),
  );
  realm.keycloak.revoke(actor.principal.personId, "retired-people-actions", ["task-create"]);
  const denied = await cell.run({ kind: "task-create", taskId: "task-roster-grant", title: "Must be denied" }, binding);
  assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
  assert.equal(denied.code, "authorization_denied");
  await assert.rejects(cell.run({ kind: "people-add", personId: "person_other" }, binding));
  assert.equal(cell.status().ledgerRevision, revisionAfterGrant);
});
