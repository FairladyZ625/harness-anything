// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { registerSettledBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

test("center start uses the signed-in person's authority repository permission without a people roster", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-s6-host-auth-")),
    userRoot = path.join(root, "user"),
    repo = path.join(root, "repo"),
    realm = await serveKeycloak();
  t.after(async () => {
    await realm.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Host Test",
    "-c",
    "user.email=host@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await registerSettledBootstrappedDaemonRepo({ repoId: "authority", canonicalRoot: repo, userRoot });
  realm.bind(userRoot);
  realm.keycloak.account("person-admin");
  realm.keycloak.account("person-other");
  realm.keycloak.permit("person-admin", "authority", ["daemon-fleet-center-start"]);
  realm.keycloak.permit("person-other", "other", ["daemon-fleet-center-start"]);
  const keyPath = path.join(root, "key.pem"),
    certPath = path.join(root, "cert.pem"),
    rosterPath = path.join(root, "fleet.json");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    rosterPath,
    JSON.stringify({
      schema: "fleet-roster/v3",
      assignments: [
        {
          assignmentId: "assignment-one",
          nodeId: "node-one",
          repoId: "authority",
          viewId: "view-one",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scope: { kind: "task", taskId: "task-one", executionId: "exec-one", paths: ["tasks/task-one/notes.md"] },
        },
      ],
    }),
  );
  const host = await openDaemonHost({ daemonId: "s6-host-auth", userRoot }),
    request = { port: 0, bind: "127.0.0.1", keyPath, certPath, rosterPath, quotaBytes: 64 * 1024 * 1024 };
  t.after(() => host.close());
  signInAt(userRoot, "person-other");
  await assert.rejects(host.fleet.startCenter(request, auth), { code: "authorization_denied" });
  // A local authored role cannot change the authority's decision.
  writeFileSync(
    path.join(repo, "harness", "people.yaml"),
    JSON.stringify({ schema: "harness-people/v1", people: [], roles: [] }),
  );
  await assert.rejects(host.fleet.startCenter(request, auth), { code: "authorization_denied" });
  signInAt(userRoot, "person-admin");
  const result = await host.fleet.startCenter(request, auth);
  assert.equal(result.outcome, "applied");
  assert.ok(Number(result.port) > 0);
  assert.equal((result.authorizationDecision as { policyRef: string }).policyRef, "keycloak-policy@1");
});
