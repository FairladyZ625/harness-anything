// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonCliBinDirectory, prepareBoundRuntimeLaunch } from "../src/daemon-host/runtime-spawn-context.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization/keycloak";
import { fakeKeycloak, keycloakRealm, keycloakUrl } from "./keycloak.fixtures.ts";
import type { RuntimeSpawnerInput } from "../src/daemon-host/runtime-spawn-types.ts";
import {
  dispatchDecisionPackageRoot,
  managedRootsForTrustedCwd,
  resolveDispatchCwd,
} from "../src/daemon-host/runtime-resume-admission.ts";
import { resolveManagedReviewWorktreePath } from "../src/daemon-host/task-worktree.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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

test("prepareBoundRuntimeLaunch deduplicates mixed-case Path/PATH keys and preserves existing entries", async () => {
  const existingEntries = [path.join("/system", "bin"), path.join("/git", "cmd")],
    existingPath = existingEntries.join(path.delimiter),
    prepared = {
      env: { Path: existingPath, SYSTEMROOT: "C:\\Windows" },
    } as Parameters<typeof prepareBoundRuntimeLaunch>[0]["prepared"],
    launch = await prepareBoundRuntimeLaunch({
      input: { rootDir: "/repo", repoId: "repo", now: () => new Date().toISOString() } as RuntimeSpawnerInput,
      prepared,
      daemonRoute: { userRoot: "/operator/state", daemonId: "studio", endpoint: "/daemon.sock" },
      cliBinDir: "/installation/bin",
      runtimeActor: "agent:runtime-session:worker",
      taskId: "task_path_dedup",
    });
  const pathKeys = Object.keys(launch.env).filter((key) => key.toUpperCase() === "PATH");
  assert.deepEqual(pathKeys, ["PATH"], `expected a single canonical PATH key, got ${JSON.stringify(pathKeys)}`);
  assert.equal("Path" in launch.env, false, "mixed-case Path key must be removed to avoid Windows PATH collision");
  assert.deepEqual(launch.env.PATH?.split(path.delimiter), [
    "/installation/bin",
    path.join("/repo", "tools", "git-hooks"),
    ...existingEntries,
  ]);
  assert.equal(launch.env.SYSTEMROOT, "C:\\Windows");
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
  context.after(() => removeTempRepository(root));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(path.join(binDirectory, "ha"), "#!/usr/bin/env node\n");
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), binDirectory);
});

test("an artifact task resume discards an inherited canonical cwd and any explicit override", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-package-cwd-")),
    taskPackage = path.join(root, "task-package");
  context.after(() => removeTempRepository(root));
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
  context.after(() => removeTempRepository(root));
  assert.equal(resolveDispatchCwd(root, {}, root, null, root).cwd, realpathSync.native(root));
});

test(
  "resolveDispatchCwd permits symlinked managed authoredRoot packages while rejecting external escapes",
  { skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  (context) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-symlink-authored-")),
      root = path.join(parent, "repo"),
      externalLedger = path.join(parent, "private-ledger"),
      externalOutside = path.join(parent, "outside"),
      taskPackage = path.join(externalLedger, "tasks", "task_1");
    context.after(() => removeTempRepository(parent));
    mkdirSync(root, { recursive: true });
    mkdirSync(taskPackage, { recursive: true });
    mkdirSync(externalOutside, { recursive: true });
    symlinkSync(externalLedger, path.join(root, "harness"), "dir");
    symlinkSync(externalOutside, path.join(root, "user-link"), "dir");
    symlinkSync(externalOutside, path.join(externalLedger, "tasks", "escape"), "dir");

    // Managed taskPackageRoot inside symlinked harness/ resolves cleanly.
    const resolvedPackage = resolveDispatchCwd(
      root,
      {},
      undefined,
      null,
      path.join(root, "harness", "tasks", "task_1"),
    );
    assert.equal(resolvedPackage.cwd, realpathSync.native(taskPackage));

    // Ordinary inherited cwd without managed roots must still stay inside the repository realpath.
    assert.throws(
      () => resolveDispatchCwd(root, {}, resolvedPackage.cwd, null),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid_runtime_cwd" &&
        error.message === "Runtime cwd must stay inside the repository.",
    );

    // Ordinary inherited cwd replaced with an out-of-repo symlink during backoff is rejected on re-validation.
    const ordinarySub = path.join(root, "ordinary-dir");
    mkdirSync(ordinarySub, { recursive: true });
    assert.equal(resolveDispatchCwd(root, {}, ordinarySub, null).cwd, realpathSync.native(ordinarySub));
    removeTempRepository(ordinarySub);
    symlinkSync(externalOutside, ordinarySub, "dir");
    assert.throws(
      () => resolveDispatchCwd(root, {}, ordinarySub, null),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid_runtime_cwd" &&
        error.message === "Runtime cwd must stay inside the repository.",
    );

    // Inherited cwd with explicit managed root resolves only while realpath remains inside that managed root.
    assert.equal(
      resolveDispatchCwd(
        root,
        {},
        resolvedPackage.cwd,
        null,
        undefined,
        managedRootsForTrustedCwd(root, "task-package"),
      ).cwd,
      resolvedPackage.cwd,
    );
    assert.deepEqual(managedRootsForTrustedCwd(root, undefined), []);
    assert.deepEqual(managedRootsForTrustedCwd(root, "worktree"), [path.join(root, ".worktrees")]);
    assert.deepEqual(managedRootsForTrustedCwd(root, "task-package"), [path.join(root, "harness")]);
    assert.deepEqual(managedRootsForTrustedCwd(root, "decision-package"), [path.join(root, "harness")]);

    // A symlinked .worktrees target outside the repository is allowed ONLY with trusted "worktree" provenance,
    // never for ordinary caller-selected Task-bound cwds (inheritedManagedRoots = []).
    const externalWorktrees = path.join(parent, "external-worktrees"),
      externalCheckout = path.join(externalWorktrees, ".review", "task_1", "abc");
    mkdirSync(externalCheckout, { recursive: true });
    symlinkSync(externalWorktrees, path.join(root, ".worktrees"), "dir");
    assert.equal(
      resolveDispatchCwd(
        root,
        {},
        path.join(root, ".worktrees", ".review", "task_1", "abc"),
        null,
        undefined,
        managedRootsForTrustedCwd(root, "worktree"),
      ).cwd,
      realpathSync.native(externalCheckout),
    );
    assert.throws(
      () =>
        resolveDispatchCwd(
          root,
          {},
          path.join(root, ".worktrees", ".review", "task_1", "abc"),
          null,
          undefined,
          managedRootsForTrustedCwd(root, undefined),
        ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid_runtime_cwd" &&
        error.message === "Runtime cwd must stay inside the repository.",
    );

    // Missing inherited cwd fails with directory-does-not-exist instead of containment escape.
    assert.throws(
      () => resolveDispatchCwd(root, {}, path.join(root, ".worktrees", ".review", "missing"), null),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid_runtime_cwd" &&
        error.message === "Runtime cwd directory does not exist.",
    );

    // Symlink escape inside harness/ pointing outside authoredRoot is still rejected.
    assert.throws(
      () => resolveDispatchCwd(root, {}, undefined, null, path.join(root, "harness", "tasks", "escape")),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_cwd",
    );

    // External caller payload.cwd symlink escape is still rejected.
    assert.throws(
      () => resolveDispatchCwd(root, { cwd: { scope: "repo-relative", path: "user-link" } }, undefined, null),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_cwd",
    );

    // Decision review package under symlinked harness/ resolves only for its own package path, never an escape.
    const decisionPackage = path.join(externalLedger, "decisions", "decision-dec_1");
    mkdirSync(decisionPackage, { recursive: true });
    assert.equal(
      dispatchDecisionPackageRoot(
        root,
        { cwd: { scope: "repo-relative", path: "harness/decisions/decision-dec_1" } },
        { decisionId: "dec_1" },
      ),
      path.join(root, "harness", "decisions", "decision-dec_1"),
    );
    assert.equal(
      dispatchDecisionPackageRoot(
        root,
        { cwd: { scope: "repo-relative", path: "user-link" } },
        { decisionId: "dec_1" },
      ),
      null,
    );
  },
);

test("resolveManagedReviewWorktreePath matches realpath containment under symlinked .worktrees roots and rejects escapes", (context) => {
  if (process.platform === "win32") return;
  const parent = mkdtempSync(path.join(tmpdir(), "ha-review-reclaim-root-")),
    root = path.join(parent, "repo"),
    externalWorktrees = path.join(parent, "external-worktrees"),
    reviewCheckout = path.join(externalWorktrees, ".review", "task_1", "a".repeat(40)),
    implWorktree = path.join(externalWorktrees, "task_1"),
    outsideDir = path.join(parent, "outside");
  context.after(() => removeTempRepository(parent));
  mkdirSync(root, { recursive: true });
  mkdirSync(reviewCheckout, { recursive: true });
  mkdirSync(implWorktree, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  symlinkSync(externalWorktrees, path.join(root, ".worktrees"), "dir");
  symlinkSync(outsideDir, path.join(externalWorktrees, ".review", "escape-link"), "dir");

  const resolvedExpected = realpathSync.native(reviewCheckout);
  assert.equal(resolveManagedReviewWorktreePath(root, resolvedExpected), resolvedExpected);
  assert.equal(
    resolveManagedReviewWorktreePath(root, path.join(root, ".worktrees", ".review", "task_1", "a".repeat(40))),
    resolvedExpected,
  );
  assert.equal(resolveManagedReviewWorktreePath(root, path.join(root, ".worktrees", ".review")), null);
  assert.equal(resolveManagedReviewWorktreePath(root, implWorktree), null);
  assert.equal(resolveManagedReviewWorktreePath(root, path.join(root, ".worktrees", ".review", "escape-link")), null);
  assert.equal(resolveManagedReviewWorktreePath(root, outsideDir), null);
});

test("runtime CLI bin stays absent when the daemon installation has no ha entry", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-cli-missing-")),
    modulePath = path.join(root, "node_modules", "@harness-anything", "daemon", "dist", "runtime-spawn-context.js");
  context.after(() => removeTempRepository(root));
  mkdirSync(path.dirname(modulePath), { recursive: true });
  assert.equal(daemonCliBinDirectory(pathToFileURL(modulePath).href), undefined);
});
