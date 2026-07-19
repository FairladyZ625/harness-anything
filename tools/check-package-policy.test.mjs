// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPackagePolicy } from "./check-package-policy.mjs";

test("package policy derives and rejects an unregistered shell workspace package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-package-policy-"));
  try {
    writeJson(root, "package.json", {
      name: "harness-anything",
      private: true,
      workspaces: ["packages/*"]
    });
    writeJson(root, "packages/cli/package.json", {
      name: "@harness-anything/cli",
      version: "0.1.0",
      publishConfig: { access: "public" },
      repository: { directory: "packages/cli" },
      engines: { node: ">=24" }
    });
    writeJson(root, "packages/newcomer/package.json", {
      name: "@harness-anything/newcomer",
      version: "0.1.0",
      private: true
    });
    writeJson(root, "package-lock.json", {
      packages: {
        "packages/cli": { name: "@harness-anything/cli", version: "0.1.0" }
      }
    });

    const result = checkPackagePolicy(root);

    assert.equal(result.ok, false);
    assert.equal(result.workspaceCount, 2);
    assert.match(result.violations.join("\n"), /packages\/newcomer\/package\.json is a workspace package but is missing from package-lock\.json/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
