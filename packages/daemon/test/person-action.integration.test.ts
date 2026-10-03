// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

test("Person explanations resolve Keycloak identity and evaluate online permission", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-person-action-keycloak-")),
    repoId = workspaceId("person-action-keycloak"),
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
    ownerId: "person-action-keycloak",
    now: () => "2026-10-02T00:00:00.000Z",
  });
  t.after(async () => {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  });
  const personRef = `person/${actor.principal.personId}`;
  realm.keycloak.permit(actor.principal.personId, `person-action-keycloak:${personRef}`, ["people-delegate"]);
  const object = await cell.read(
      "repo.entity.actions.explain",
      { schema: "entity-action-explain-request/v1", mode: "object", entityKind: null, refs: [personRef] },
      binding,
    ),
    delegate = object.subjects[0]?.actions.find(({ action }) => action.id === "delegate");
  assert.equal(object.mode, "object");
  assert.equal(delegate?.authorizationDecision?.policyRef, "keycloak-policy@1");
  assert.equal(delegate?.authorizationDecision?.outcome, "allowed");
  const missing = await cell.read(
    "repo.entity.actions.explain",
    { schema: "entity-action-explain-request/v1", mode: "object", entityKind: null, refs: ["person/person_missing"] },
    binding,
  );
  assert.equal(missing.subjects[0]?.failure?.code, "entity_not_found");
});
