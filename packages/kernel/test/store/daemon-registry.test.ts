// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  daemonRegistryPaths,
  daemonRegistrySchema,
  publishDaemonRegistryRuntimeProjection,
  readDaemonRegistry,
  registerDaemonRepo,
  resolveDaemonRepoByRoot,
  unregisterDaemonRepo
} from "../../src/daemon/registry.ts";

test("daemon registry reads missing registry as an empty v1 registry", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    assert.deepEqual(readDaemonRegistry({ userRoot }), {
      schema: daemonRegistrySchema,
      repos: []
    });
  });
});

test("register classifies a Windows lock-create EPERM after the lock disappears as contention", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-registry-eperm-"));
  const userRoot = path.join(root, "user-harness");
  const canonicalRoot = createHarnessRepo(path.join(root, "project"));
  const lockPath = `${daemonRegistryPaths({ userRoot }).registryPath}.lock`;
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(lockPath);

  const originalMkdirSync = fs.mkdirSync;
  let injectLockFailure = true;
  fs.mkdirSync = ((inputPath: Parameters<typeof fs.mkdirSync>[0], options?: Parameters<typeof fs.mkdirSync>[1]) => {
    if (inputPath === lockPath && injectLockFailure) {
      injectLockFailure = false;
      rmSync(lockPath, { recursive: true, force: true });
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    return Reflect.apply(originalMkdirSync, fs, [inputPath, options]);
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  context.after(() => {
    fs.mkdirSync = originalMkdirSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });

  const result = registerDaemonRepo({
    userRoot,
    canonicalRoot,
    repoId: "project",
    platform: "win32",
    createConvenienceLinks: false
  });

  assert.equal(result.repo.repoId, "project");
});

test("owner-record loss retries honor the registry lock acquisition deadline", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-registry-owner-loss-"));
  const userRoot = path.join(root, "user-harness");
  const canonicalRoot = createHarnessRepo(path.join(root, "project"));
  const lockPath = `${daemonRegistryPaths({ userRoot }).registryPath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const originalWriteFileSync = fs.writeFileSync;
  const originalDateNow = Date.now;
  let ownerRecordAttempts = 0;
  let clockReads = 0;
  fs.writeFileSync = ((
    inputPath: Parameters<typeof fs.writeFileSync>[0],
    data: Parameters<typeof fs.writeFileSync>[1],
    options?: Parameters<typeof fs.writeFileSync>[2]
  ) => {
    if (inputPath === ownerPath) {
      ownerRecordAttempts += 1;
      if (ownerRecordAttempts >= 3) throw new Error("owner-record retry bypassed registry lock deadline");
      rmSync(lockPath, { recursive: true, force: true });
    }
    return Reflect.apply(originalWriteFileSync, fs, [inputPath, data, options]);
  }) as typeof fs.writeFileSync;
  Date.now = () => {
    clockReads += 1;
    return clockReads <= 2 ? 0 : 5_000;
  };
  syncBuiltinESMExports();
  context.after(() => {
    fs.writeFileSync = originalWriteFileSync;
    Date.now = originalDateNow;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => registerDaemonRepo({
      userRoot,
      canonicalRoot,
      repoId: "project",
      createConvenienceLinks: false,
      mutationLockStaleMs: 0
    }),
    /timed out acquiring daemon registry mutation lock/u
  );
  assert.equal(ownerRecordAttempts, 1);
});

test("a stale registry lock owner cannot release a replacement owner's lock", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-registry-owner-"));
  const userRoot = path.join(root, "user-harness");
  const firstRoot = createHarnessRepo(path.join(root, "first"));
  const secondRoot = createHarnessRepo(path.join(root, "second"));
  const lockPath = `${daemonRegistryPaths({ userRoot }).registryPath}.lock`;
  const moduleUrl = pathToFileURL(path.resolve("packages/kernel/src/daemon/registry.ts")).href;
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4));
  const first = startPausedRegistryMutationWorker({
    moduleUrl, userRoot, canonicalRoot: firstRoot, repoId: "first", state, enteredIndex: 0, releaseIndex: 1
  });
  let second: ReturnType<typeof startPausedRegistryMutationWorker> | undefined;
  try {
    await waitForWorkerState(state, 0);
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    second = startPausedRegistryMutationWorker({
      moduleUrl,
      userRoot,
      canonicalRoot: secondRoot,
      repoId: "second",
      state,
      enteredIndex: 2,
      releaseIndex: 3,
      mutationLockStaleMs: 0
    });
    await waitForWorkerState(state, 2);

    releasePausedRegistryMutation(state, 1);
    await first.finished;

    assert.equal(existsSync(lockPath), true, "the stale owner removed the replacement owner's lock");
  } finally {
    releasePausedRegistryMutation(state, 1);
    releasePausedRegistryMutation(state, 3);
    await Promise.allSettled([first.finished, ...(second ? [second.finished] : [])]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncontended registry mutation changes the registry and releases its lock", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const lockPath = `${daemonRegistryPaths({ userRoot }).registryPath}.lock`;

    const registered = registerDaemonRepo({
      userRoot,
      canonicalRoot,
      repoId: "project",
      createConvenienceLinks: false
    });

    assert.equal(registered.changed, true);
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.state, "enabled");
    assert.equal(existsSync(lockPath), false);

    const unregistered = unregisterDaemonRepo("project", { userRoot, createConvenienceLinks: false });
    assert.equal(unregistered.changed, true);
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.state, "disabled");
    assert.equal(existsSync(lockPath), false);
  });
});

test("a registry mutation recovers a stale tokenless legacy lock", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const lockPath = `${daemonRegistryPaths({ userRoot }).registryPath}.lock`;
    mkdirSync(lockPath, { recursive: true });
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    const result = registerDaemonRepo({
      userRoot,
      canonicalRoot,
      repoId: "project",
      createConvenienceLinks: false,
      mutationLockStaleMs: 0
    });

    assert.equal(result.changed, true);
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.repoId, "project");
    assert.equal(existsSync(lockPath), false);
  });
});

test("daemon registry register realpaths canonical roots and writes registry-only when links are disabled", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "real-project"));
    const aliasRoot = path.join(root, "alias-project");
    symlinkSync(canonicalRoot, aliasRoot, "dir");

    const result = registerDaemonRepo({
      userRoot,
      canonicalRoot: aliasRoot,
      repoId: "brain",
      displayName: "Brain",
      createConvenienceLinks: false,
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });

    assert.equal(result.changed, true);
    assert.equal(result.repo.repoId, "brain");
    assert.equal(result.repo.canonicalRoot, canonicalRoot);
    assert.equal(result.repo.state, "enabled");
    assert.equal(result.repo.registeredAt, "2026-07-07T00:00:00.000Z");
    assert.equal(existsSync(daemonRegistryPaths({ userRoot }).registryPath), true);
    assert.equal(existsSync(daemonRegistryPaths({ userRoot }).reposRoot), false);
    assert.equal(resolveDaemonRepoByRoot(aliasRoot, { userRoot })?.repoId, "brain");
  });
});

test("legacy registry re-registration preserves the producer bytes", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const input = {
      userRoot,
      canonicalRoot,
      repoId: "canonical",
      displayName: "Project",
      createConvenienceLinks: false,
      now: () => new Date("2026-07-21T00:00:00.000Z")
    } as const;
    const before = Buffer.from(`{\n  "schema": "harness-daemon-registry/v1",\n  "repos": [\n    {\n      "repoId": "canonical",\n      "canonicalRoot": ${JSON.stringify(canonicalRoot)},\n      "displayName": "Project",\n      "state": "enabled",\n      "registeredAt": "2026-07-21T00:00:00.000Z"\n    }\n  ]\n}\n`);
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(daemonRegistryPaths({ userRoot }).registryPath, before);
    registerDaemonRepo(input);
    const after = readFileSync(daemonRegistryPaths({ userRoot }).registryPath);
    assert.equal(after.equals(before), true, "legacy registry producer bytes drifted");
  });
});

test("registry producer bytes match fixed omitted, partial, and full projection goldens", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const input = {
      userRoot,
      canonicalRoot,
      repoId: "canonical",
      displayName: "Project",
      createConvenienceLinks: false,
      now: () => new Date("2026-07-21T00:00:00.000Z")
    } as const;
    const stableRepo = `    {\n      "repoId": "canonical",\n      "canonicalRoot": ${JSON.stringify(canonicalRoot)},\n      "displayName": "Project",\n      "state": "enabled",\n      "registeredAt": "2026-07-21T00:00:00.000Z"`;
    const omitted = Buffer.from(`{\n  "schema": "harness-daemon-registry/v1",\n  "repos": [\n${stableRepo}\n    }\n  ]\n}\n`);
    const partial = Buffer.from(`{\n  "schema": "harness-daemon-registry/v1",\n  "machineId": "machine-installation-a",\n  "daemonGeneration": 7,\n  "repos": [\n${stableRepo}\n    }\n  ]\n}\n`);
    const full = Buffer.from(`{\n  "schema": "harness-daemon-registry/v1",\n  "machineId": "machine-installation-a",\n  "daemonGeneration": 7,\n  "repos": [\n${stableRepo},\n      "runtimeRegistrationId": "77777777-7777-4777-8777-777777777777",\n      "daemonGeneration": 7\n    }\n  ]\n}\n`);

    registerDaemonRepo(input);
    assert.equal(readFileSync(daemonRegistryPaths({ userRoot }).registryPath).equals(omitted), true);
    publishDaemonRegistryRuntimeProjection({ userRoot, machineId: "machine-installation-a", daemonGeneration: 7, registrations: [] });
    assert.equal(readFileSync(daemonRegistryPaths({ userRoot }).registryPath).equals(partial), true);
    publishDaemonRegistryRuntimeProjection({
      userRoot,
      machineId: "machine-installation-a",
      daemonGeneration: 7,
      registrations: [{ repoId: "canonical", runtimeRegistrationId: "77777777-7777-4777-8777-777777777777", daemonGeneration: 7 }]
    });
    assert.equal(readFileSync(daemonRegistryPaths({ userRoot }).registryPath).equals(full), true);
  });
});

test("daemon registry keeps the manifest authoritative when Windows convenience links are unavailable", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(path.join(userRoot, "repos"), "not a directory\n", "utf8");

    const result = registerDaemonRepo({
      userRoot,
      canonicalRoot,
      repoId: "canonical",
      platform: "win32",
      now: () => new Date("2026-07-07T00:00:00.000Z")
    });

    assert.equal(result.changed, true);
    assert.match(result.warnings.join("\n"), /could not create repo convenience link/u);
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.canonicalRoot, canonicalRoot);
    assert.equal(resolveDaemonRepoByRoot(canonicalRoot, { userRoot })?.repoId, "canonical");
    assert.equal(lstatSync(path.join(userRoot, "repos")).isFile(), true);
  });
});

test("daemon registry generated repoIds stay stable and get hash suffixes on basename conflicts", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const firstRoot = createHarnessRepo(path.join(root, "left", "project"));
    const secondRoot = createHarnessRepo(path.join(root, "right", "project"));

    const first = registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, createConvenienceLinks: false });
    const second = registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, createConvenienceLinks: false });

    assert.equal(first.repo.repoId, "project");
    assert.match(second.repo.repoId, /^project-[a-f0-9]{8}$/u);
    assert.deepEqual(readDaemonRegistry({ userRoot }).repos.map((repo) => repo.repoId), ["project", second.repo.repoId].sort());
  });
});

test("daemon registry rejects explicit repoId and canonical root conflicts", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const firstRoot = createHarnessRepo(path.join(root, "first"));
    const secondRoot = createHarnessRepo(path.join(root, "second"));

    registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "brain", createConvenienceLinks: false });

    assert.throws(
      () => registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "brain", createConvenienceLinks: false }),
      /repoId "brain" is already registered/u
    );
    assert.throws(
      () => registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "other", createConvenienceLinks: false }),
      /already registered as repoId "brain"/u
    );
    assert.throws(
      () => registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "Brain", createConvenienceLinks: false }),
      /repoId must use lowercase/u
    );
  });
});

test("daemon registry unregister disables a repo without deleting registry history", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));

    registerDaemonRepo({ userRoot, canonicalRoot, repoId: "canonical", createConvenienceLinks: false });
    const result = unregisterDaemonRepo("canonical", { userRoot, createConvenienceLinks: false });

    assert.equal(result.changed, true);
    assert.equal(result.repo.state, "disabled");
    assert.deepEqual(readDaemonRegistry({ userRoot }).repos.map((repo) => [repo.repoId, repo.state]), [["canonical", "disabled"]]);
  });
});

test("daemon registry replaces the operational runtime registration snapshot", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const firstRoot = createHarnessRepo(path.join(root, "first"));
    const secondRoot = createHarnessRepo(path.join(root, "second"));
    registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "first", createConvenienceLinks: false });
    registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "second", createConvenienceLinks: false });

    publishDaemonRegistryRuntimeProjection({
      userRoot,
      machineId: "machine-installation-a",
      daemonGeneration: 4,
      registrations: [
        { repoId: "first", runtimeRegistrationId: "11111111-1111-4111-8111-111111111111", daemonGeneration: 4 },
        { repoId: "second", runtimeRegistrationId: "22222222-2222-4222-8222-222222222222", daemonGeneration: 4 }
      ]
    });
    publishDaemonRegistryRuntimeProjection({
      userRoot,
      machineId: "machine-installation-a",
      daemonGeneration: 5,
      registrations: [{ repoId: "first", runtimeRegistrationId: "55555555-5555-4555-8555-555555555555", daemonGeneration: 5 }]
    });

    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.machineId, "machine-installation-a");
    assert.equal(registry.daemonGeneration, 5);
    assert.deepEqual(registry.repos.map((repo) => ({
      repoId: repo.repoId,
      runtimeRegistrationId: repo.runtimeRegistrationId,
      daemonGeneration: repo.daemonGeneration
    })), [
      { repoId: "first", runtimeRegistrationId: "55555555-5555-4555-8555-555555555555", daemonGeneration: 5 },
      { repoId: "second", runtimeRegistrationId: undefined, daemonGeneration: undefined }
    ]);
  });
});

test("registry create preserves generation projections", () => {
  withTempDir((root) => {
    const { userRoot } = seedProjectedRegistry(root);
    const secondRoot = createHarnessRepo(path.join(root, "second"));
    registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "second", createConvenienceLinks: false });
    assertRegistryProjection(readDaemonRegistry({ userRoot }), "enabled");
  });
});

test("registry update preserves generation projections", () => {
  withTempDir((root) => {
    const { userRoot, firstRoot } = seedProjectedRegistry(root);
    registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "first", displayName: "Renamed", createConvenienceLinks: false });
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.displayName, "Renamed");
    assertRegistryProjection(readDaemonRegistry({ userRoot }), "enabled");
  });
});

test("registry disable preserves generation projections", () => {
  withTempDir((root) => {
    const { userRoot } = seedProjectedRegistry(root);
    unregisterDaemonRepo("first", { userRoot, createConvenienceLinks: false });
    assertRegistryProjection(readDaemonRegistry({ userRoot }), "disabled");
  });
});

test("register does not erase an already-published runtime snapshot", () => {
  withTempDir((root) => {
    const { userRoot } = seedProjectedRegistry(root, 9);
    const secondRoot = createHarnessRepo(path.join(root, "second"));
    registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "second", createConvenienceLinks: false });
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 2, "register erased the published snapshot");
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.runtimeRegistrationId, "99999999-9999-4999-8999-999999999999");
  });
});

test("publish does not erase a concurrent register and stale generation cannot overwrite projection", () => {
  withTempDir((root) => {
    const { userRoot } = seedProjectedRegistry(root, 9);
    const secondRoot = createHarnessRepo(path.join(root, "second"));
    registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "second", createConvenienceLinks: false });
    publishDaemonRegistryRuntimeProjection({
      userRoot,
      machineId: "machine-installation-a",
      daemonGeneration: 9,
      registrations: [{ repoId: "first", runtimeRegistrationId: "99999999-9999-4999-8999-999999999999", daemonGeneration: 9 }]
    });
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 2, "publish erased the concurrent registration");
    publishDaemonRegistryRuntimeProjection({
      userRoot,
      machineId: "machine-installation-a",
      daemonGeneration: 8,
      registrations: []
    });
    const afterStalePublish = readDaemonRegistry({ userRoot });
    assert.equal(afterStalePublish.daemonGeneration, 9);
    assert.equal(afterStalePublish.repos.length, 2, "publish erased the concurrent registration");
    assert.equal(afterStalePublish.repos[0]?.runtimeRegistrationId, "99999999-9999-4999-8999-999999999999");
  });
});

test("cross-process publish and register serialize without losing either projection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-registry-race-"));
  try {
    const { userRoot } = seedProjectedRegistry(root, 9);
    const repoRoots = Array.from({ length: 12 }, (_, index) => createHarnessRepo(path.join(root, `repo-${index}`)));
    const moduleUrl = pathToFileURL(path.resolve("packages/kernel/src/daemon/registry.ts")).href;
    const registerSource = `
      const { registerDaemonRepo } = await import(${JSON.stringify(moduleUrl)});
      for (const [index, canonicalRoot] of ${JSON.stringify(repoRoots)}.entries()) {
        registerDaemonRepo({ userRoot: ${JSON.stringify(userRoot)}, canonicalRoot, repoId: \`repo-\${index}\`, createConvenienceLinks: false });
      }
    `;
    const publishSource = `
      const { publishDaemonRegistryRuntimeProjection } = await import(${JSON.stringify(moduleUrl)});
      for (let index = 0; index < 100; index += 1) {
        publishDaemonRegistryRuntimeProjection({
          userRoot: ${JSON.stringify(userRoot)},
          machineId: "machine-installation-a",
          daemonGeneration: 9,
          registrations: [{ repoId: "first", runtimeRegistrationId: "99999999-9999-4999-8999-999999999999", daemonGeneration: 9 }]
        });
      }
    `;

    await Promise.all([runRegistryMutationChild(registerSource), runRegistryMutationChild(publishSource)]);
    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.repos.length, 13, "periodic publish erased a concurrent register");
    assert.equal(
      registry.repos.find((repo) => repo.repoId === "first")?.runtimeRegistrationId,
      "99999999-9999-4999-8999-999999999999",
      "concurrent register erased the published snapshot"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry decoder rejects invalid UUIDs, mismatched generations, and orphan runtime registrations", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    mkdirSync(userRoot, { recursive: true });
    const registryPath = daemonRegistryPaths({ userRoot }).registryPath;
    const repo = { repoId: "repo", canonicalRoot: root, displayName: "Repo", state: "enabled", registeredAt: "2026-07-21T00:00:00.000Z" };
    for (const invalid of [
      { schema: daemonRegistrySchema, repos: [{ ...repo, runtimeRegistrationId: "not-a-uuid", daemonGeneration: 7 }], machineId: "m", daemonGeneration: 7 },
      { schema: daemonRegistrySchema, repos: [{ ...repo, runtimeRegistrationId: "77777777-7777-4777-8777-777777777777", daemonGeneration: 6 }], machineId: "m", daemonGeneration: 7 },
      { schema: daemonRegistrySchema, repos: [{ ...repo, runtimeRegistrationId: "77777777-7777-4777-8777-777777777777", daemonGeneration: 7 }] }
    ]) {
      writeFileSync(registryPath, `${JSON.stringify(invalid)}\n`, "utf8");
      assert.throws(() => readDaemonRegistry({ userRoot }), /invalid daemon registry/u);
    }
  });
});

test("daemon registry durably preserves the authority manifest pointer across ordinary re-registration", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const authorityManifestPath = path.join(root, "authority-production.json");
    writeFileSync(authorityManifestPath, "{}\n", "utf8");

    registerDaemonRepo({
      userRoot, canonicalRoot, repoId: "canonical", authorityManifestPath, createConvenienceLinks: false
    });
    registerDaemonRepo({
      userRoot, canonicalRoot, repoId: "canonical", displayName: "Renamed", createConvenienceLinks: false
    });

    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.authorityManifestPath, realpathSync.native(authorityManifestPath));
  });
});

test("daemon registry fails closed for malformed registries and uninitialized roots", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(path.join(userRoot, "registry.json"), "{\"schema\":\"wrong\",\"repos\":[]}\n", "utf8");

    assert.throws(() => readDaemonRegistry({ userRoot }), /invalid daemon registry/u);
  });
  withTempDir((root) => {
    assert.throws(
      () => registerDaemonRepo({
        userRoot: path.join(root, "user-harness"),
        canonicalRoot: path.join(root, "not-harness"),
        createConvenienceLinks: false
      }),
      /canonicalRoot must be an initialized harness repository/u
    );
  });
});

function withTempDir<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-registry-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createHarnessRepo(rootDir: string): string {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
  return realpathSync.native(path.resolve(rootDir));
}

function assertRegistryProjection(registry: ReturnType<typeof readDaemonRegistry>, state: "enabled" | "disabled"): void {
  assert.equal(registry.machineId, "machine-installation-a");
  assert.equal(registry.daemonGeneration, 7);
  assert.equal(registry.repos.find((repo) => repo.repoId === "first")?.state, state);
  assert.equal(
    registry.repos.find((repo) => repo.repoId === "first")?.runtimeRegistrationId,
    "77777777-7777-4777-8777-777777777777"
  );
}

function seedProjectedRegistry(root: string, generation = 7): { readonly userRoot: string; readonly firstRoot: string } {
  const userRoot = path.join(root, "user-harness");
  const firstRoot = createHarnessRepo(path.join(root, "first"));
  registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "first", createConvenienceLinks: false });
  publishDaemonRegistryRuntimeProjection({
    userRoot,
    machineId: "machine-installation-a",
    daemonGeneration: generation,
    registrations: [{
      repoId: "first",
      runtimeRegistrationId: generation === 9
        ? "99999999-9999-4999-8999-999999999999"
        : "77777777-7777-4777-8777-777777777777",
      daemonGeneration: generation
    }]
  });
  return { userRoot, firstRoot };
}

async function runRegistryMutationChild(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`registry mutation child exited ${String(code)}: ${stderr}`)));
  });
}

function startPausedRegistryMutationWorker(input: {
  readonly moduleUrl: string;
  readonly userRoot: string;
  readonly canonicalRoot: string;
  readonly repoId: string;
  readonly state: Int32Array;
  readonly enteredIndex: number;
  readonly releaseIndex: number;
  readonly mutationLockStaleMs?: number;
}): { readonly finished: Promise<void> } {
  const source = `
    const fs = require("node:fs");
    const path = require("node:path");
    const { syncBuiltinESMExports } = require("node:module");
    const { workerData } = require("node:worker_threads");
    const state = new Int32Array(workerData.sharedState);
    const registryPath = path.join(workerData.userRoot, "registry.json");
    const originalExistsSync = fs.existsSync;
    let paused = false;
    fs.existsSync = (inputPath) => {
      if (!paused && inputPath === registryPath) {
        paused = true;
        Atomics.store(state, workerData.enteredIndex, 1);
        Atomics.notify(state, workerData.enteredIndex);
        Atomics.wait(state, workerData.releaseIndex, 0);
      }
      return originalExistsSync(inputPath);
    };
    syncBuiltinESMExports();
    void import(workerData.moduleUrl).then(({ registerDaemonRepo }) => {
      registerDaemonRepo({
        userRoot: workerData.userRoot,
        canonicalRoot: workerData.canonicalRoot,
        repoId: workerData.repoId,
        createConvenienceLinks: false,
        ...(workerData.mutationLockStaleMs === undefined
          ? {}
          : { mutationLockStaleMs: workerData.mutationLockStaleMs })
      });
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      moduleUrl: input.moduleUrl,
      userRoot: input.userRoot,
      canonicalRoot: input.canonicalRoot,
      repoId: input.repoId,
      sharedState: input.state.buffer,
      enteredIndex: input.enteredIndex,
      releaseIndex: input.releaseIndex,
      mutationLockStaleMs: input.mutationLockStaleMs
    }
  });
  const finished = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`registry mutation worker exited ${code}`)));
  });
  return { finished };
}

async function waitForWorkerState(state: Int32Array, index: number): Promise<void> {
  while (Atomics.load(state, index) === 0) {
    await Atomics.waitAsync(state, index, 0).value;
  }
}

function releasePausedRegistryMutation(state: Int32Array, index: number): void {
  Atomics.store(state, index, 1);
  Atomics.notify(state, index);
}
