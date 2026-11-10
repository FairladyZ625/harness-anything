// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonCliBinDirectory, prepareBoundRuntimeLaunch } from "../src/runtime-spawn-context.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { fakeKeycloak, keycloakRealm, keycloakUrl } from "./keycloak.fixtures.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { resolveDispatchCwd } from "../src/runtime-resume-admission.ts";

test("an unbound runtime inherits its spawning daemon route and runtime actor", async () => {
  const prepared = {
      env: { HOME: "/isolated/home", PATH: "/provider/bin" },
    } as Parameters<typeof prepareBoundRuntimeLaunch>[0]["prepared"],
    launch = await prepareBoundRuntimeLaunch({
      input: { rootDir: "/repo", repoId: "repo", now: () => new Date().toISOString() } as RuntimeSpawnerInput,
      prepared,
      daemonRoute: { userRoot: "/operator/state", daemonId: "studio", endpoint: "/daemon.sock" },
      cliBinDir: "/installation/bin",
      runtimeActor: "agent:runtime-session:ceo",
      taskId: null,
    });
  assert.equal(launch.env.HARNESS_DAEMON_USER_ROOT, "/operator/state");
  assert.equal(launch.env.HARNESS_DAEMON_ID, "studio");
  assert.equal(launch.env.HARNESS_DAEMON_ENDPOINT, "/daemon.sock");
  assert.equal(launch.env.HARNESS_DAEMON_REPO_ID, "repo");
  assert.equal(launch.env.HARNESS_CANONICAL_ROOT, "/repo");
  assert.equal(launch.env.HARNESS_ACTOR, "agent:runtime-session:ceo");
  assert.equal(launch.env.HARNESS_TASK_BOUND, undefined);
  assert.equal(launch.env.HOME, prepared.env.HOME);
  assert.equal(launch.env.PATH?.split(path.delimiter)[0], "/installation/bin");
});

test("a read-only execution credential is delivered through the launch environment", async () => {
  const principals: Array<{ readonly role: string; readonly taskId: string | null }> = [],
    center = {
      accessToken: "synthetic-access-token",
      provider: {
        issueExecutionCredential: async (
          _accessToken: string,
          principal: { readonly role: string; readonly taskId: string | null },
        ) => {
          principals.push(principal);
          return "synthetic-execution-credential";
        },
      },
    },
    launch = await prepareBoundRuntimeLaunch({
      input: {
        rootDir: "/repo",
        repoId: "repo",
        now: () => "2026-11-08T00:00:00.000Z",
        keycloakCenter: async () => center,
      } as unknown as RuntimeSpawnerInput,
      prepared: { env: {}, permissionMode: "read-only" } as Parameters<typeof prepareBoundRuntimeLaunch>[0]["prepared"],
      daemonRoute: { userRoot: "/state", daemonId: "test", endpoint: "/daemon.sock" },
      runtimeActor: "agent:runtime-session:readonly",
      taskId: null,
      execution: {
        repoId: "repo",
        personId: "person",
        source: "local",
        runtimeSessionId: "runtime-readonly",
        dispatchId: "dispatch-readonly",
        taskId: null,
        executionId: null,
        role: "read-only",
      },
    });
  assert.deepEqual(
    principals.map(({ role, taskId }) => ({ role, taskId })),
    [{ role: "read-only", taskId: null }],
  );
  assert.equal(launch.env.HARNESS_EXECUTION_CREDENTIAL, "synthetic-execution-credential");
});

test("a launch for a dispatch whose execution client already exists reuses that credential", async () => {
  const keycloak = fakeKeycloak(),
    adapter = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      keycloak.fetch,
    ),
    principal = {
      repoId: "repo-existing",
      personId: "person-existing",
      source: "local" as const,
      runtimeSessionId: "runtime-existing",
      dispatchId: "dispatch-existing",
      taskId: "task-existing",
      executionId: "execution-existing",
      role: "reviewer" as const,
    },
    // The previous launch created this dispatch's client; a retry reaches it before starting.
    issued = await adapter.issueExecutionCredential("center-token", {
      ...principal,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    launch = await prepareBoundRuntimeLaunch({
      input: {
        rootDir: "/repo",
        repoId: "repo-existing",
        now: () => "2026-11-10T00:00:00.000Z",
        keycloakCenter: async () => ({
          provider: adapter,
          url: keycloakUrl,
          realm: keycloakRealm,
          clientId: "harness-center",
          accessToken: "center-token",
        }),
      } as unknown as RuntimeSpawnerInput,
      prepared: { env: {} } as Parameters<typeof prepareBoundRuntimeLaunch>[0]["prepared"],
      daemonRoute: { userRoot: "/state", daemonId: "test", endpoint: "/daemon.sock" },
      runtimeActor: "agent:runtime-session:runtime-existing",
      taskId: "task-existing",
      execution: principal,
    });
  assert.equal(
    launch.env.HARNESS_EXECUTION_CREDENTIAL,
    issued,
    "launch admission resolves the existing client instead of failing the dispatch",
  );
  assert.equal(keycloak.nodeClients.size, 1, "the retry created no second client");
});

test("runtime CLI bin resolves from the nearest daemon installation", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-bin-")),
    modulePath = path.join(root, "packages", "daemon", "dist", "runtime-spawn-context.js"),
    binDirectory = path.join(root, "node_modules", ".bin");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(path.join(binDirectory, "ha"), "#!/usr/bin/env node\n");
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), binDirectory);
});

test("an artifact task resume discards an inherited canonical cwd and any explicit override", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-package-cwd-")),
    taskPackage = path.join(root, "task-package");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(taskPackage);
  for (const request of [{}, { cwd: { scope: "repo-root" } }]) {
    assert.deepEqual(resolveDispatchCwd(root, request, root, null, taskPackage), {
      cwd: taskPackage,
      worktree: null,
    });
  }
  assert.equal(resolveDispatchCwd(root, {}, root, null).cwd, root);
});

test("an artifact task rooted at the repository uses the repo-root cwd scope", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-package-root-cwd-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(resolveDispatchCwd(root, {}, root, null, root).cwd, root);
});

test("runtime CLI bin stays absent when the daemon installation has no ha entry", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-missing-")),
    modulePath = path.join(root, "node_modules", "@harness-anything", "daemon", "dist", "runtime-spawn-context.js");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), undefined);
});
