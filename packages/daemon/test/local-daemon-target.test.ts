// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { INITIAL_SETTINGS_V1, resolveHarnessLayout } from "@harness-anything/kernel";
import { createPresetProcessService } from "@harness-anything/preset";
import {
  localUserDaemonEndpoint,
  perUserSocketRoot,
  resolveLocalDaemonTarget,
} from "../src/client/local-daemon-target.ts";
import { daemonRequestLogPath } from "../src/request-log.ts";

test("local daemon target resolves a v1 workspace after the shared registry reader upgrades it", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-v1-")),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify({
        schema: "harness-daemon-registry/v1",
        repos: [
          {
            repoId: "legacy",
            canonicalRoot: workspaceRoot,
            displayName: "Legacy",
            authoredBranch: "main",
            state: "enabled",
            registeredAt: "2026-07-07T00:00:00.000Z",
          },
        ],
      })}\n`,
    );

    const target = await resolveLocalDaemonTarget({ rootDir: workspaceRoot, userRoot, env: {} });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "registry.json"), "utf8")) as {
      schema: string;
      repos: Record<string, unknown>[];
    };

    assert.equal(target.repoId, "legacy");
    assert.equal(target.canonicalRoot, realpathSync.native(workspaceRoot));
    assert.equal(persisted.schema, "harness-daemon-registry/v2");
    assert.equal(persisted.repos[0]?.connectionId, "local");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target resolves a registered workspace from its subdirectory", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"),
    nestedRoot = path.join(workspaceRoot, "harness", "tasks"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("workspace", canonicalWorkspaceRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} });

    assert.equal(target.repoId, "workspace");
    assert.equal(target.canonicalRoot, canonicalWorkspaceRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target chooses the deepest nested registered workspace", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"),
    innerRoot = path.join(outerRoot, "packages", "inner"),
    nestedRoot = path.join(innerRoot, "harness"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot),
      canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} });

    assert.equal(target.repoId, "inner");
    assert.equal(target.canonicalRoot, canonicalInnerRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target rejects a disabled nested workspace instead of falling back to its enabled parent", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"),
    innerRoot = path.join(outerRoot, "packages", "inner"),
    nestedRoot = path.join(innerRoot, "harness"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot),
      canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot, "disabled")]), null, 2)}\n`,
    );

    await assert.rejects(
      () => resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} }),
      /workspace is blocked by disabled repoId "inner" at .*ha repo unbind inner to remove it/u,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target honors an explicit root instead of the process working directory", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"),
    innerRoot = path.join(outerRoot, "packages", "inner"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(innerRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot),
      canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot)]), null, 2)}\n`,
    );
    const parsed = parseThinCommand(["--root", outerRoot, "task", "list"], innerRoot);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;

    const target = await resolveLocalDaemonTarget({ rootDir: parsed.command.rootDir, userRoot, env: {} });

    assert.equal(target.repoId, "outer");
    assert.equal(target.canonicalRoot, canonicalOuterRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target ignores an environment repo id from another registered workspace", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const firstRoot = path.join(fixtureRoot, "first"),
    secondRoot = path.join(fixtureRoot, "second"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot);
    mkdirSync(userRoot);
    const canonicalFirstRoot = realpathSync.native(firstRoot),
      canonicalSecondRoot = realpathSync.native(secondRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("first", canonicalFirstRoot), repo("second", canonicalSecondRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({
      rootDir: firstRoot,
      userRoot,
      env: { HARNESS_DAEMON_REPO_ID: "second" },
    });

    assert.equal(target.repoId, "first");
    assert.equal(target.canonicalRoot, canonicalFirstRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon relay rejects a root outside the dispatched canonical root", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-relay-target-")),
    canonicalRoot = path.join(fixtureRoot, "workspace"),
    foreignRoot = path.join(fixtureRoot, "foreign"),
    userRoot = path.join(fixtureRoot, "user"),
    endpoint = path.join(perUserSocketRoot(), "r-000000000000000000000000.sock");
  try {
    mkdirSync(canonicalRoot);
    mkdirSync(foreignRoot);
    mkdirSync(userRoot);
    assert.equal(existsSync(endpoint), false);
    await assert.rejects(
      () =>
        resolveLocalDaemonTarget({
          rootDir: foreignRoot,
          userRoot,
          env: {
            HARNESS_CANONICAL_ROOT: realpathSync.native(canonicalRoot),
            HARNESS_DAEMON_REPO_ID: "unregistered-a",
            HARNESS_DAEMON_RELAY: "1",
            HARNESS_DAEMON_ENDPOINT: endpoint,
          },
        }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
        assert.match((error as Error).message, /outside the dispatched canonical root/u);
        assert.equal((error as { readonly params?: { readonly route?: string } }).params?.route, "relay");
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon relay resolves from the injected route when the host registry is unreadable", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-relay-unreadable-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    workerRoot = path.join(workspaceRoot, ".worktrees", "worker"),
    endpoint = path.join(perUserSocketRoot(), "r-0123456789abcdef01234567.sock");
  try {
    mkdirSync(workerRoot, { recursive: true });
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    mkdirSync(userRoot);
    // A registry.json that is a directory fails every read for any uid: the resolver must not open it.
    mkdirSync(path.join(userRoot, "registry.json"));
    const target = await resolveLocalDaemonTarget({
      rootDir: workerRoot,
      userRoot,
      env: {
        HARNESS_DAEMON_RELAY: "1",
        HARNESS_CANONICAL_ROOT: canonicalWorkspaceRoot,
        HARNESS_DAEMON_REPO_ID: "runtime-worker",
        HARNESS_DAEMON_ENDPOINT: endpoint,
      },
    });
    assert.deepEqual(target, {
      repoId: "runtime-worker",
      canonicalRoot: canonicalWorkspaceRoot,
      userRoot,
      daemonId: "default",
      socketPath: endpoint,
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon relay rejects a route missing its repo id or canonical root", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-relay-incomplete-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    endpoint = path.join(perUserSocketRoot(), "r-0123456789abcdef01234567.sock");
  try {
    mkdirSync(workspaceRoot);
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    mkdirSync(userRoot);
    for (const env of [
      {
        HARNESS_DAEMON_RELAY: "1",
        HARNESS_CANONICAL_ROOT: canonicalWorkspaceRoot,
        HARNESS_DAEMON_ENDPOINT: endpoint,
      },
      {
        HARNESS_DAEMON_RELAY: "1",
        HARNESS_DAEMON_REPO_ID: "runtime-worker",
        HARNESS_DAEMON_ENDPOINT: endpoint,
      },
    ])
      await assert.rejects(
        () => resolveLocalDaemonTarget({ rootDir: workspaceRoot, userRoot, env }),
        (error: unknown) => {
          assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
          assert.match((error as Error).message, /daemon_relay_route_required/u);
          return true;
        },
      );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon relay rejects a repo id override outside the dispatched scope", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-relay-scope-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    endpoint = path.join(perUserSocketRoot(), "r-0123456789abcdef01234567.sock");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    await assert.rejects(
      () =>
        resolveLocalDaemonTarget({
          rootDir: workspaceRoot,
          repoIdOverride: "other-repo",
          userRoot,
          env: {
            HARNESS_DAEMON_RELAY: "1",
            HARNESS_CANONICAL_ROOT: realpathSync.native(workspaceRoot),
            HARNESS_DAEMON_REPO_ID: "runtime-worker",
            HARNESS_DAEMON_ENDPOINT: endpoint,
          },
        }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
        assert.match((error as Error).message, /does not match the dispatched repo/u);
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target keeps a matching injected repo id", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(userRoot);
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("runtime-worker", canonicalWorkspaceRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({
      rootDir: workspaceRoot,
      userRoot,
      env: { HARNESS_DAEMON_REPO_ID: "runtime-worker" },
    });

    assert.equal(target.repoId, "runtime-worker");
    assert.equal(target.canonicalRoot, canonicalWorkspaceRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target keeps an explicit repo id override authoritative", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const firstRoot = path.join(fixtureRoot, "first"),
    secondRoot = path.join(fixtureRoot, "second"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot);
    mkdirSync(userRoot);
    const canonicalFirstRoot = realpathSync.native(firstRoot),
      canonicalSecondRoot = realpathSync.native(secondRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("first", canonicalFirstRoot), repo("second", canonicalSecondRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({ rootDir: firstRoot, repoIdOverride: "second", userRoot, env: {} });

    assert.equal(target.repoId, "second");
    assert.equal(target.canonicalRoot, canonicalSecondRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target rejects a path outside every registered workspace", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"),
    unrelatedRoot = path.join(fixtureRoot, "unrelated"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(unrelatedRoot);
    mkdirSync(userRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("workspace", realpathSync.native(workspaceRoot))]), null, 2)}\n`,
    );

    await assert.rejects(
      () => resolveLocalDaemonTarget({ rootDir: unrelatedRoot, userRoot, env: {} }),
      /workspace is not registered/u,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target routes a repository worktree to the canonical workspace local layer", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"),
    worktreeRoot = path.join(workspaceRoot, ".worktrees", "feature"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
    mkdirSync(path.join(worktreeRoot, "harness"), { recursive: true });
    mkdirSync(userRoot);
    writeFileSync(path.join(workspaceRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    writeFileSync(path.join(worktreeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("workspace", canonicalWorkspaceRoot)]), null, 2)}\n`,
    );

    const target = await resolveLocalDaemonTarget({ rootDir: worktreeRoot, userRoot, env: {} });
    const layout = resolveHarnessLayout(target.canonicalRoot);
    const presetProcess = createPresetProcessService({
      rootDir: target.canonicalRoot,
      userRoot: path.join(layout.localRoot, "presets"),
      readSettings: () => INITIAL_SETTINGS_V1,
    });
    await presetProcess.close();

    assert.equal(target.canonicalRoot, canonicalWorkspaceRoot);
    assert.equal(layout.localRoot, path.join(canonicalWorkspaceRoot, ".harness"));
    assert.equal(layout.cacheRoot, path.join(canonicalWorkspaceRoot, ".harness", "cache"));
    assert.equal(
      daemonRequestLogPath(target.canonicalRoot),
      path.join(canonicalWorkspaceRoot, ".harness", "requests", "requests.jsonl"),
    );
    assert.equal(existsSync(path.join(canonicalWorkspaceRoot, ".harness", "preset-runs")), true);
    assert.equal(
      `${target.canonicalRoot}.harness-anything-writer.lock`,
      `${canonicalWorkspaceRoot}.harness-anything-writer.lock`,
    );
    assert.notEqual(layout.localRoot, path.join(realpathSync.native(worktreeRoot), ".harness"));
    assert.equal(existsSync(path.join(worktreeRoot, ".harness")), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target keeps a matching injected endpoint across an isolated runtime temp directory", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-endpoint-")),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    userRoot = path.join(fixtureRoot, "user"),
    daemonId = "runtime-worker",
    derived = localUserDaemonEndpoint(userRoot, daemonId),
    endpoint = process.platform === "win32" ? derived : path.join(fixtureRoot, path.basename(derived));
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("runtime-worker", canonicalWorkspaceRoot)]), null, 2)}\n`,
    );
    const target = await resolveLocalDaemonTarget({
      rootDir: workspaceRoot,
      userRoot,
      daemonId,
      env: { HARNESS_DAEMON_ENDPOINT: endpoint, TMPDIR: path.join(fixtureRoot, "isolated-tmp") },
    });
    assert.equal(target.socketPath, endpoint);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace relay resolves a worktree under the dispatched canonical root", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-relay-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    workerRoot = path.join(workspaceRoot, ".worktrees", "worker"),
    endpoint = path.join(perUserSocketRoot(), "r-0123456789abcdef01234567.sock");
  try {
    mkdirSync(workerRoot, { recursive: true });
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    mkdirSync(userRoot);
    // The registry names a different repo on purpose: the injected route, not this file, decides.
    writeFileSync(
      path.join(userRoot, "registry.json"),
      JSON.stringify(registry([repo("registered-elsewhere", canonicalWorkspaceRoot)])),
    );
    const target = await resolveLocalDaemonTarget({
      rootDir: workerRoot,
      userRoot,
      env: {
        HARNESS_DAEMON_RELAY: "1",
        HARNESS_CANONICAL_ROOT: canonicalWorkspaceRoot,
        HARNESS_DAEMON_REPO_ID: "runtime-worker",
        HARNESS_DAEMON_ENDPOINT: endpoint,
      },
    });
    assert.deepEqual(target, {
      repoId: "runtime-worker",
      canonicalRoot: canonicalWorkspaceRoot,
      userRoot,
      daemonId: "default",
      socketPath: endpoint,
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace relay rejects a missing endpoint instead of deriving a fallback socket", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-relay-missing-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    // No registry is written: a relayed route is complete without one, and the missing endpoint
    // must be refused before any host lookup instead of falling back to the implicit user socket.
    await assert.rejects(
      () =>
        resolveLocalDaemonTarget({
          rootDir: workspaceRoot,
          userRoot,
          env: {
            HARNESS_DAEMON_RELAY: "1",
            HARNESS_CANONICAL_ROOT: workspaceRoot,
            HARNESS_DAEMON_REPO_ID: "runtime-worker",
          },
        }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
        assert.match((error as Error).message, /HARNESS_DAEMON_ENDPOINT is not set/u);
        assert.deepEqual((error as { readonly params?: unknown }).params, {
          route: "relay",
          reason: "HARNESS_DAEMON_ENDPOINT is not set",
          endpoint: null,
          userRoot,
          daemonId: "default",
          repoId: "runtime-worker",
          canonicalRoot: workspaceRoot,
        });
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace relay rejects an endpoint that is not this dispatch's relay socket", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-relay-foreign-")),
    userRoot = path.join(fixtureRoot, "user"),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    foreignEndpoint = path.join(fixtureRoot, ".harness", "r-0123456789abcdef01234567.sock");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    await assert.rejects(
      () =>
        resolveLocalDaemonTarget({
          rootDir: workspaceRoot,
          userRoot,
          env: {
            HARNESS_DAEMON_RELAY: "1",
            HARNESS_CANONICAL_ROOT: realpathSync.native(workspaceRoot),
            HARNESS_DAEMON_REPO_ID: "runtime-worker",
            HARNESS_DAEMON_ENDPOINT: foreignEndpoint,
          },
        }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
        assert.match((error as Error).message, /per-dispatch relay socket/u);
        assert.equal((error as { readonly params?: { readonly route?: string } }).params?.route, "relay");
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target reports an unreadable registry instead of an unavailable daemon", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-registry-")),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    // A registry.json that is a directory fails every read for any uid.
    mkdirSync(path.join(userRoot, "registry.json"));
    await assert.rejects(
      () => resolveLocalDaemonTarget({ rootDir: workspaceRoot, userRoot, env: {} }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_registry_unreadable");
        assert.match((error as Error).message, /daemon registry at .*registry\.json could not be read/u);
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target rejects an injected endpoint owned by another user root", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-conflict-")),
    workspaceRoot = path.join(fixtureRoot, "workspace"),
    userRoot = path.join(fixtureRoot, "isolated-user"),
    parentUserRoot = path.join(fixtureRoot, "parent-user"),
    daemonId = "isolated",
    endpoint = localUserDaemonEndpoint(parentUserRoot, "parent");
  try {
    mkdirSync(workspaceRoot);
    mkdirSync(userRoot);
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify(registry([repo("runtime-worker", canonicalWorkspaceRoot)]), null, 2)}\n`,
    );

    await assert.rejects(
      () =>
        resolveLocalDaemonTarget({
          rootDir: workspaceRoot,
          userRoot,
          daemonId,
          env: { HARNESS_DAEMON_ENDPOINT: endpoint },
        }),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, "daemon_target_conflict");
        assert.deepEqual((error as { readonly params?: unknown }).params, {
          endpoint,
          expected: localUserDaemonEndpoint(userRoot, daemonId),
          userRoot,
          daemonId,
          repoId: "runtime-worker",
          canonicalRoot: canonicalWorkspaceRoot,
        });
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function repo(repoId: string, canonicalRoot: string, state = "enabled") {
  return {
    repoId,
    canonicalRoot,
    displayName: repoId,
    authoredBranch: "main",
    connectionId: "local",
    mode: "local",
    state,
    registeredAt: "2026-08-17T00:00:00.000Z",
  };
}
function registry(repos: readonly ReturnType<typeof repo>[]) {
  return {
    schema: "harness-daemon-registry/v2",
    connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
    repos,
  };
}
