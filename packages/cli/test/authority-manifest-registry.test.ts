// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  readDaemonRegistry,
  registerDaemonRepo,
  unregisterDaemonRepo
} from "../../kernel/src/index.ts";
import {
  authorityManifestServeRepos,
  persistAuthorityManifestPointer
} from "../src/daemon/authority-manifest-registry.ts";
import { initializeHarness } from "../src/commands/init.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

test("authority manifest projection rejects a root registered under another repoId without writing", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  try {
    registerDaemonRepo({
      userRoot,
      repoId: "existing",
      canonicalRoot: fixture.repoRoot,
      createConvenienceLinks: false
    });
    const before = readDaemonRegistry({ userRoot });

    assert.throws(
      () => authorityManifestServeRepos(fixture.manifestPath, userRoot),
      /canonical root is already registered as repoId "existing"/u
    );
    assert.deepEqual(readDaemonRegistry({ userRoot }), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority manifest projection re-enables a disabled matching root without writing", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  try {
    registerDaemonRepo({
      userRoot,
      repoId: "canonical",
      canonicalRoot: fixture.repoRoot,
      createConvenienceLinks: false
    });
    unregisterDaemonRepo("canonical", { userRoot, createConvenienceLinks: false });
    const before = readDaemonRegistry({ userRoot });

    const projected = authorityManifestServeRepos(fixture.manifestPath, userRoot);

    assert.deepEqual(projected.map((repo) => repo.repoId), ["canonical"]);
    assert.equal(projected[0]?.canonicalRoot, realpathSync.native(fixture.repoRoot));
    assert.equal(projected[0]?.authorityManifestPath, realpathSync.native(fixture.manifestPath));
    assert.deepEqual(readDaemonRegistry({ userRoot }), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority manifest projection canonicalizes a harness subdirectory to the registered root", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  try {
    registerDaemonRepo({
      userRoot,
      repoId: "canonical",
      canonicalRoot: fixture.repoRoot,
      createConvenienceLinks: false
    });
    const nestedRoot = path.join(fixture.authoredRoot, "tasks");
    rewriteManifest(fixture.manifestPath, (manifest) => {
      manifest.repos[0].canonicalRoot = nestedRoot;
    });

    const projected = authorityManifestServeRepos(fixture.manifestPath, userRoot);

    assert.deepEqual(projected.map((repo) => repo.repoId), ["canonical"]);
    assert.equal(projected[0]?.canonicalRoot, realpathSync.native(fixture.repoRoot));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority manifest projection rejects an invalid explicit repoId before writing", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  try {
    rewriteManifest(fixture.manifestPath, (manifest) => {
      manifest.repos[0].repoId = "Canonical";
    });
    const before = readDaemonRegistry({ userRoot });

    assert.throws(
      () => authorityManifestServeRepos(fixture.manifestPath, userRoot),
      /repoId must use lowercase letters/u
    );
    assert.deepEqual(readDaemonRegistry({ userRoot }), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority manifest projection uses daemon registry ordering", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  const zetaRoot = path.join(fixture.root, "zeta-repo");
  try {
    mkdirSync(zetaRoot);
    initializeHarness({ rootDir: zetaRoot }, false, "Zeta");
    registerDaemonRepo({
      userRoot,
      repoId: "zeta",
      canonicalRoot: zetaRoot,
      createConvenienceLinks: false
    });

    assert.deepEqual(
      authorityManifestServeRepos(fixture.manifestPath, userRoot).map((repo) => repo.repoId),
      ["canonical", "zeta"]
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("authority manifest persistence validates every repo before its first registry write", () => {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "user-root");
  try {
    rewriteManifest(fixture.manifestPath, (manifest) => {
      manifest.repos.push({
        ...manifest.repos[0],
        repoId: "Invalid",
        canonicalRoot: fixture.auxiliaryRoot
      });
    });
    const before = readDaemonRegistry({ userRoot });

    assert.throws(
      () => persistAuthorityManifestPointer(fixture.manifestPath, userRoot),
      /repoId must use lowercase letters/u
    );
    assert.deepEqual(readDaemonRegistry({ userRoot }), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface MutableManifest {
  repos: Array<Record<string, unknown>>;
}

function rewriteManifest(manifestPath: string, mutate: (manifest: MutableManifest) => void): void {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MutableManifest;
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
