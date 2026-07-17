// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { authorityManifestFromRegistry, type DaemonServeRepo } from "../src/index.ts";
import { createProductionAuthorityLifecycle } from "../src/daemon/production-authority-lifecycle.ts";

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
