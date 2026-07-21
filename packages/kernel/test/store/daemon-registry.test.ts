// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
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
