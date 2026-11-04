import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { AccessAdminService, type AccessAdminRequest } from "../src/access-admin-service.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { managedRbacReceiptJournal } from "../src/access-admin-state.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "./keycloak.fixtures.ts";

export async function accessAdminFixture(
  t: TestContext,
  ports: {
    readonly withoutAdmin?: boolean;
    readonly now?: () => number;
    readonly wrapFetch?: (inner: typeof fetch) => typeof fetch;
  } = {},
) {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot(),
    fetchPort = ports.wrapFetch?.(keycloak.fetch) ?? keycloak.fetch,
    oidc = createIdentitySession(user.root, { fetch: fetchPort, ...(ports.now ? { now: ports.now } : {}) }),
    admin = new AccessAdminService(oidc, user.root, { fetch: fetchPort }),
    config = { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" };
  t.after(user.cleanup);
  const provider = new KeycloakPolicyAdapter(config, keycloak.fetch);
  await provider.syncBasePolicy("center-token");
  if (!ports.withoutAdmin) keycloak.accessAdmin();
  keycloak.writes.length = 0;
  return {
    keycloak,
    provider,
    admin,
    oidc,
    ...user,
    journal: () =>
      managedRbacReceiptJournal(user.root)
        .read()
        .map((line) => JSON.parse(line)),
    run: (request: AccessAdminRequest) => admin.run({ operationId: randomUUID(), ...request }),
    // The production evaluation path: RepoCell → KeycloakPolicyAdapter → UMA decision.
    evaluate: async (personId: string, repoId: string, action: RepoTaskAction) =>
      (
        await evaluateRepoCellAction({
          action,
          binding: {
            actor: { principal: { personId }, executor: null },
            source: "local",
            keycloakAuthorization: {
              session: {
                provider,
                personId,
                accessToken: `token-${personId}`,
                url: keycloakUrl,
                realm: keycloakRealm,
                clientId: "harness-center",
              },
            },
          },
          actionId: randomUUID(),
          repoId,
          revision: 1,
          now: "2026-10-01T00:00:00.000Z",
          fetchPort: keycloak.fetch,
        })
      ).outcome,
  };
}

/** Two registered repositories, a bound fleet center, and the edge permission groups every invitation test needs. */
export async function edgeJoinCenter(t: TestContext, base: Awaited<ReturnType<typeof accessAdminFixture>>) {
  const work = mkdtempSync(path.join(tmpdir(), "ha-edge-invitation-")),
    certificate = path.join(work, "center.crt"),
    key = path.join(work, "center.key");
  t.after(() => rmSync(work, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  for (const repoId of ["repo-a", "repo-b"]) {
    const canonicalRoot = path.join(work, repoId);
    mkdirSync(path.join(canonicalRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(canonicalRoot, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonicalRoot });
    execFileSync("git", ["add", "harness/harness.yaml"], { cwd: canonicalRoot });
    execFileSync(
      "git",
      ["-c", "user.name=Edge invite test", "-c", "user.email=edge-invite@example.invalid", "commit", "-qm", "seed"],
      { cwd: canonicalRoot },
    );
    registerBootstrappedDaemonRepo({ canonicalRoot, repoId, userRoot: base.root, createConvenienceLinks: false });
  }
  saveFleetCenterConfig(base.root, "default", {
    bind: "127.0.0.1",
    externalUrl: "https://center.example:7545",
    port: 8443,
    repoId: "repo-a",
    keyPath: key,
    certPath: certificate,
    stateRoot: path.join(work, "fleet-state"),
    quotaBytes: 1024 * 1024,
  });

  await base.run({
    operation: "group-create",
    groupId: "edge-source",
    displayName: "Edge source",
    scopes: [],
    composites: ["viewer"],
  });
  await base.run({
    operation: "group-create",
    groupId: "edge-selected",
    displayName: "Edge selected",
    scopes: [],
    composites: ["edge-source"],
  });
  return base;
}
