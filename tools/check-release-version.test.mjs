// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dirname, "check-release-version.mjs");

test("release version check accepts the lockstep public workspace version", () => {
  withFixture((root) => {
    assert.doesNotThrow(() => run(root, "v0.1.0"));
  });
});

test("release version check rejects a mismatched tag", () => {
  withFixture((root) => {
    assert.throws(() => run(root, "v0.1.1"), /mismatch/u);
  });
});

test("release version check covers storage, not only the former hand-written list", () => {
  withFixture((root) => {
    writeManifest(root, "packages/storage/package.json", {
      ...manifest(root, "packages/storage/package.json"),
      version: "0.0.1",
    });
    assert.throws(() => run(root, "v0.1.0"), /packages\/storage\/package\.json=0\.0\.1/u);
  });
});

test("release version check rejects an internal dependency that did not move with the release", () => {
  withFixture((root) => {
    writeManifest(root, "packages/daemon/package.json", {
      ...manifest(root, "packages/daemon/package.json"),
      dependencies: { "@harness-anything/storage": "0.0.1" },
    });
    assert.throws(() => run(root, "v0.1.0"), /dependencies\.@harness-anything\/storage=0\.0\.1/u);
  });
});

function run(root, tag) {
  return execFileSync(process.execPath, [scriptPath, tag], {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, RELEASE_ROOT: root },
    stdio: "pipe",
  });
}

function withFixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-release-version-"));
  try {
    writeManifest(root, "package.json", { name: "harness-anything", version: "0.1.0", workspaces: ["packages/*"] });
    for (const [directory, value] of Object.entries({
      "packages/kernel": { name: "@harness-anything/kernel", version: "0.1.0" },
      "packages/storage": {
        name: "@harness-anything/storage",
        version: "0.1.0",
        dependencies: { "@harness-anything/kernel": "0.1.0" },
      },
      "packages/application": {
        name: "@harness-anything/application",
        version: "0.1.0",
        dependencies: { "@harness-anything/kernel": "0.1.0" },
      },
      "packages/adapter": { name: "@harness-anything/adapter", version: "0.0.1", private: true },
      "packages/daemon": {
        name: "@harness-anything/daemon",
        version: "0.1.0",
        dependencies: {
          "@harness-anything/application": "0.1.0",
          "@harness-anything/storage": "0.1.0",
        },
      },
      "packages/cli": {
        name: "@harness-anything/cli",
        version: "0.1.0",
        dependencies: { "@harness-anything/daemon": "0.1.0" },
      },
      "packages/gui": {
        name: "@harness-anything/gui",
        version: "0.1.0",
        devDependencies: { "@harness-anything/adapter": "0.0.1" },
      },
    }))
      writeManifest(root, `${directory}/package.json`, value);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifest(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function writeManifest(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
