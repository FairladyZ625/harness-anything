// harness-test-tier: fast
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { migrateCompletion } from "@harness-anything/preset/internal/preset-resolver";
import { readArtifactActionScopes } from "../src/authorization-provider.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";

const sharedKind = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
  sharedScope = `${sharedKind}/import`,
  bundled = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../../preset/assets/software-coding/vertical.json"), "utf8"),
  ) as { entityKinds: Record<string, unknown>[] },
  retireSharedKind = () => {
    const definition = structuredClone(bundled),
      kind = definition.entityKinds.find((entity) => entity.kindId === sharedKind.slice("entity-kind/".length));
    assert.ok(kind);
    kind.retired = true;
    return definition;
  };

function materializeRepo(parent: string, name: string, definition: unknown): string {
  const root = path.join(parent, name);
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "{}\n");
  writeFileSync(
    path.join(root, "harness", "vertical.json"),
    JSON.stringify({ schema: "repository-vertical-declaration/v1", revision: 1, definition }),
  );
  return root;
}

function register(userRoot: string, repos: readonly { readonly repoId: string; readonly root: string }[]): void {
  for (const repo of repos)
    writeDaemonRegistryRepo({
      userRoot,
      repoId: repo.repoId,
      canonicalRoot: repo.root,
      authoredBranch: "main",
      mode: "local",
    });
}

test("policy sync normalizes a historical completion default to the converted declaration's scopes", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-retired-code-doc-")),
    userRoot = path.join(parent, "user"),
    definition = structuredClone(bundled) as {
      entityKinds: Record<string, unknown>[];
      completion: { closeoutDefaults: Record<string, boolean> };
    };
  definition.completion.closeoutDefaults.codeDoc = true;
  const root = materializeRepo(parent, "repo-retired-code-doc", definition),
    source = path.join(root, "harness", "vertical.json");
  try {
    register(userRoot, [{ repoId: "repo-retired-code-doc", root }]);
    // managedRbac.resume() reaches this function while syncing the center's Base policy. The
    // canonical declaration reader already normalizes historical retired defaults; policy sync must
    // read the same accepted declaration, not reject the whole daemon start over the same bytes.
    const normalized = await readArtifactActionScopes(userRoot)();
    assert.ok(normalized.includes(sharedScope), "the active shared kind keeps its import scope");
    const candidate = path.join(parent, "candidate.json");
    assert.equal(migrateCompletion({ source, destination: candidate, dryRun: false }).changed, true);
    copyFileSync(candidate, source);
    assert.deepEqual(
      await readArtifactActionScopes(userRoot)(),
      normalized,
      "the retired key is normalized away, so conversion changes no policy scope",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("one repository retiring a shared kind cannot revoke another repository's import scope", async () => {
  for (const order of [
    ["active", "retired"],
    ["retired", "active"],
  ] as const) {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-cross-repo-scope-")),
      userRoot = path.join(parent, "user"),
      roots = {
        active: materializeRepo(parent, "repo-active", bundled),
        retired: materializeRepo(parent, "repo-retired", retireSharedKind()),
      },
      repos = order.map((name) => ({ repoId: `repo-${name}`, root: roots[name] }));
    try {
      register(userRoot, repos);
      const scopes = await readArtifactActionScopes(userRoot)();
      assert.ok(scopes.includes(sharedScope), `${order.join("->")} keeps the active repository's import`);

      const realm = fakeKeycloak(),
        adapter = new KeycloakPolicyAdapter(
          { url: "http://127.0.0.1:8080", realm: "harness", resourceServerClientId: "harness-center" },
          realm.fetch,
        );
      realm.account("person-cross-repo");
      await adapter.syncBasePolicy("admin-token", scopes);
      await adapter.claimRepositoryOwner("admin-token", "repo-active", "person-cross-repo");
      assert.equal(
        (
          await adapter.authorizePerson({
            adminAccessToken: "admin-token",
            personId: "person-cross-repo",
            action: sharedScope,
            resource: { kind: "repository", repoId: "repo-active" },
          })
        ).outcome,
        "allowed",
        `${order.join("->")} owner keeps import`,
      );
      const fresh = adapter.withFetchPort(realm.fetch);
      await fresh.materializeGrants("admin-token");
      assert.equal(
        [...realm.permissions.values()].some((permission) => permission.scopes.includes(sharedScope)),
        true,
        `${order.join("->")} existing grant keeps import`,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
