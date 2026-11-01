// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPublicDependencyClosure,
  publicWorkspaceNamesTopologically,
  readWorkspacePackages,
} from "./public-workspaces.mjs";

test("public workspace order is derived from workspace metadata and dependency edges", () => {
  const root = fixture();
  try {
    writeManifest(root, "package.json", { workspaces: ["packages/*"] });
    writeManifest(root, "packages/kernel/package.json", { name: "@harness-anything/kernel" });
    writeManifest(root, "packages/application/package.json", {
      name: "@harness-anything/application",
      dependencies: { "@harness-anything/kernel": "0.1.0" },
    });
    writeManifest(root, "packages/cli/package.json", {
      name: "@harness-anything/cli",
      dependencies: { "@harness-anything/application": "0.1.0", external: "1.0.0" },
    });
    writeManifest(root, "packages/adapter/package.json", {
      name: "@harness-anything/adapter",
      private: true,
      dependencies: { "@harness-anything/kernel": "0.1.0" },
    });
    writeManifest(root, "packages/gui/package.json", {
      name: "@harness-anything/gui",
      devDependencies: { "@harness-anything/adapter": "0.0.1" },
    });

    assert.deepEqual(publicWorkspaceNamesTopologically(root), [
      "@harness-anything/kernel",
      "@harness-anything/application",
      "@harness-anything/cli",
      "@harness-anything/gui",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace that turns public enters the publish list without a second list", () => {
  const root = fixture();
  try {
    writeManifest(root, "package.json", { workspaces: ["packages/*"] });
    writeManifest(root, "packages/kernel/package.json", { name: "@harness-anything/kernel" });
    writeManifest(root, "packages/dsh-plugin/package.json", {
      name: "@harness-anything/dsh-plugin",
      private: true,
      dependencies: { "@harness-anything/kernel": "0.1.0" },
    });

    assert.deepEqual(publicWorkspaceNamesTopologically(root), ["@harness-anything/kernel"]);

    writeManifest(root, "packages/dsh-plugin/package.json", {
      name: "@harness-anything/dsh-plugin",
      dependencies: { "@harness-anything/kernel": "0.1.0" },
    });

    assert.deepEqual(publicWorkspaceNamesTopologically(root), [
      "@harness-anything/kernel",
      "@harness-anything/dsh-plugin",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a public package depending on a private workspace is rejected with the exact edge", () => {
  const root = fixture();
  try {
    writeManifest(root, "package.json", { workspaces: ["packages/*"] });
    writeManifest(root, "packages/daemon/package.json", {
      name: "@harness-anything/daemon",
      dependencies: { "@harness-anything/adapter": "0.0.1" },
    });
    writeManifest(root, "packages/adapter/package.json", {
      name: "@harness-anything/adapter",
      private: true,
    });

    assert.throws(
      () => assertPublicDependencyClosure(root),
      /public workspace @harness-anything\/daemon declares dependencies\.@harness-anything\/adapter but @harness-anything\/adapter is private/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace manifests are read from the declared globs, not a hardcoded package list", () => {
  const root = fixture();
  try {
    writeManifest(root, "package.json", { workspaces: ["packages/*"] });
    writeManifest(root, "packages/kernel/package.json", { name: "@harness-anything/kernel" });
    writeManifest(root, "packages/new-package/package.json", { name: "@harness-anything/new-package" });

    assert.deepEqual(
      readWorkspacePackages(root).map((entry) => entry.manifest.name),
      ["@harness-anything/kernel", "@harness-anything/new-package"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  return mkdtempSync(path.join(tmpdir(), "ha-public-workspaces-"));
}

function writeManifest(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
