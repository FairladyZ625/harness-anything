// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  daemonRegistryPaths,
  daemonRegistrySchema,
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
      repos: [],
      invalidRepos: []
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
    assert.equal(result.repo.authoredBranch, "ledger-main");
    assert.equal(result.repo.mode, "local");
    assert.equal(result.repo.state, "enabled");
    assert.equal(result.repo.registeredAt, "2026-07-07T00:00:00.000Z");
    assert.equal(existsSync(daemonRegistryPaths({ userRoot }).registryPath), true);
    assert.equal(existsSync(daemonRegistryPaths({ userRoot }).reposRoot), false);
    assert.equal(resolveDaemonRepoByRoot(aliasRoot, { userRoot })?.repoId, "brain");
  });
});

test("daemon registry persists explicit modes and defaults legacy rows to local", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness"), canonicalRoot = createHarnessRepo(path.join(root, "project"));
    const center = registerDaemonRepo({ userRoot, canonicalRoot, repoId: "center", mode: "remote-center", createConvenienceLinks: false });
    assert.equal(center.repo.mode, "remote-center");
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.mode, "remote-center");
    const registryPath = daemonRegistryPaths({ userRoot }).registryPath, persisted = JSON.parse(readFileSync(registryPath, "utf8")) as { repos: Record<string, unknown>[] };
    delete persisted.repos[0]!.mode; writeFileSync(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    assert.equal(readDaemonRegistry({ userRoot }).repos[0]?.mode, "local");
    assert.throws(() => registerDaemonRepo({ userRoot, canonicalRoot, repoId: "center", mode: "invalid" as never, createConvenienceLinks: false }), /mode must be one of/u);
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

test("daemon registry rebinds an unregistered repoId to a new canonical root", () => {
  withTempDir((root) => {
    const userRoot = path.join(root, "user-harness");
    const firstRoot = createHarnessRepo(path.join(root, "before-move"));
    const secondRoot = createHarnessRepo(path.join(root, "after-move"));

    registerDaemonRepo({ userRoot, canonicalRoot: firstRoot, repoId: "land", createConvenienceLinks: false });
    assert.throws(
      () => registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "land", createConvenienceLinks: false }),
      /already registered for/u
    );

    unregisterDaemonRepo("land", { userRoot, createConvenienceLinks: false });
    const rebound = registerDaemonRepo({ userRoot, canonicalRoot: secondRoot, repoId: "land", createConvenienceLinks: false });

    assert.equal(rebound.repo.canonicalRoot, secondRoot);
    assert.equal(rebound.repo.state, "enabled");
    assert.deepEqual(
      readDaemonRegistry({ userRoot }).repos.map((repo) => [repo.repoId, repo.canonicalRoot, repo.state]),
      [["land", secondRoot, "enabled"]]
    );
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
  execFileSync("git", ["-C", rootDir, "init", "-q", "-b", "ledger-main"]); execFileSync("git", ["-C", rootDir, "config", "user.name", "Registry Test"]); execFileSync("git", ["-C", rootDir, "config", "user.email", "registry@example.invalid"]); execFileSync("git", ["-C", rootDir, "add", "harness/harness.yaml"]); execFileSync("git", ["-C", rootDir, "commit", "-qm", "init"]);
  return realpathSync.native(path.resolve(rootDir));
}
