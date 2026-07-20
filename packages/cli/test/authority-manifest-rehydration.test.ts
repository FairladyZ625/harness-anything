// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { authorityManifestFromRegistry, main, type DaemonServeRepo } from "../src/index.ts";
import { initializeHarness } from "../src/commands/init.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "../src/composition/production-authority-lifecycle.ts";

const protectedRepo: DaemonServeRepo = {
  repoId: "canonical",
  canonicalRoot: "/fixture/canonical",
  displayName: "Canonical",
  authorityManifestPath: "/fixture/service/authority-production.json"
};

test("daemon restart rehydrates the persisted production authority manifest", () => {
  assert.equal(
    authorityManifestFromRegistry([protectedRepo]),
    "/fixture/service/authority-production.json"
  );
});

test("daemon restart fails closed for mixed or conflicting authority registry pointers", () => {
  assert.throws(() => authorityManifestFromRegistry([protectedRepo, {
    repoId: "classic", canonicalRoot: "/fixture/classic", displayName: "Classic"
  }]), /AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE/u);
  assert.throws(() => authorityManifestFromRegistry([protectedRepo, {
    repoId: "other", canonicalRoot: "/fixture/other", displayName: "Other",
    authorityManifestPath: "/fixture/service/other-authority.json"
  }]), /AUTHORITY_MANIFEST_REGISTRY_CONFLICT/u);
  assert.throws(
    () => createProductionAuthorityLifecycle({ manifestPath: "/fixture/service/missing-authority.json" }),
    /ENOENT/u
  );
});

test("daemon serve check reuses mixed-registry startup validation without taking endpoint ownership", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-preflight-"));
  try {
    const userRoot = path.join(fixtureRoot, "user-root");
    const protectedRoot = path.join(fixtureRoot, "protected");
    const classicRoot = path.join(fixtureRoot, "classic");
    mkdirSync(protectedRoot, { recursive: true });
    mkdirSync(classicRoot, { recursive: true });
    initializeHarness({ rootDir: protectedRoot }, false, "Protected");
    initializeHarness({ rootDir: classicRoot }, false, "Classic");
    const manifestPath = path.join(fixtureRoot, "authority-production.json");
    writeFileSync(manifestPath, "{}\n", "utf8");
    registerDaemonRepo({
      userRoot,
      repoId: "protected",
      canonicalRoot: protectedRoot,
      authorityManifestPath: manifestPath
    });
    registerDaemonRepo({ userRoot, repoId: "classic", canonicalRoot: classicRoot });
    const endpoint = localUserDaemonEndpoint(userRoot);

    await assert.rejects(
      main(["--root", protectedRoot, "daemon", "serve", "--repo", "protected", "--user-root", userRoot, "--check"]),
      /AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE/u
    );
    assert.equal(existsSync(endpoint), false);
    assert.equal(existsSync(`${endpoint}.owner`), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
