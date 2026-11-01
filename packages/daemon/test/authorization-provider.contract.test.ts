// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { readArtifactActionScopes } from "../src/authorization-provider.ts";
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

test("policy sync reads accepted repository declarations without the writer registry", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-artifact-scopes-")),
    userRoot = path.join(parent, "user"),
    repoRoot = path.join(parent, "repo"),
    defaultVertical = path.join(import.meta.dirname, "../../preset/assets/software-coding/vertical.json");
  try {
    mkdirSync(path.join(repoRoot, "harness"), { recursive: true });
    writeFileSync(path.join(repoRoot, "harness", "harness.yaml"), "{}\n");
    const definition = JSON.parse(readFileSync(defaultVertical, "utf8")) as {
      entityKinds: Record<string, unknown>[];
    };
    const retiredSeed = definition.entityKinds.find((entity) => entity.entityType === "artifact") as Record<
      string,
      unknown
    >;
    retiredSeed.retired = true;
    definition.entityKinds.push({
      kindId: "KND-44444444444444444444444444444444",
      id: "custom-note",
      entityType: "artifact",
      schemaVersions: [{ version: 1, attributes: {} }],
      idPrefix: "CN",
      display: { singular: "Custom Note", plural: "Custom Notes" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      store: { pathTemplate: "entities/custom-notes/{id}.json" },
      locatorKinds: ["repository-path"],
      retired: true,
    });
    writeFileSync(
      path.join(repoRoot, "harness", "vertical.json"),
      JSON.stringify({ schema: "repository-vertical-declaration/v1", revision: 1, definition }),
    );
    writeDaemonRegistryRepo({
      userRoot,
      repoId: "repo-scopes",
      canonicalRoot: repoRoot,
      authoredBranch: "main",
      mode: "local",
    });
    const scopes = await readArtifactActionScopes(userRoot)();
    assert.ok(scopes.length >= 12);
    assert.equal(
      scopes.includes("entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94/import"),
      false,
      "the repository declaration retires this bundled kind",
    );
    assert.ok(scopes.includes("entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05/import"));
    assert.ok(scopes.includes("entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05/update"));
    assert.equal(
      scopes.includes("entity-kind/KND-44444444444444444444444444444444/import"),
      false,
      "a retired repo kind must not regain import from the bundled seed",
    );
    assert.ok(scopes.includes("entity-kind/KND-44444444444444444444444444444444/update"));
    assert.equal(
      scopes.includes("entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94/import"),
      false,
      "a retired seed kind is replaced by the repository declaration",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
