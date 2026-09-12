// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-package-policy.mjs");

test("package policy accepts the approved CLI and daemon npm publish set", async () => {
  await withFixtureRepo((root) => {
    writeValidFixture(root);
    makeDaemonPublicReady(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package policy check passed/u);
  });
});

test("package policy accepts a daemon that remains private", async () => {
  await withFixtureRepo((root) => {
    writeValidFixture(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package policy check passed/u);
  });
});

test("package policy rejects GUI as an npm package", async () => {
  await withFixtureRepo((root) => {
    writeValidFixture(root);
    writeJson(root, "packages/gui/package.json", {
      name: "@harness-anything/gui",
      version: "0.0.1",
      publishConfig: { access: "public" },
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the approved npm publish set/u);
  });
});

test("package policy rejects a public daemon without its independent bin", async () => {
  await withFixtureRepo((root) => {
    writeValidFixture(root);
    makeDaemonPublicReady(root);
    const daemon = JSON.parse(readFileSync(path.join(root, "packages/daemon/package.json"), "utf8"));
    delete daemon.bin;
    writeJson(root, "packages/daemon/package.json", daemon);

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must declare bin harness-anything-daemon/u);
  });
});

test("package policy rejects an internal library made public", async () => {
  await withFixtureRepo((root) => {
    writeValidFixture(root);
    writeJson(root, "packages/kernel/package.json", {
      name: "@harness-anything/kernel",
      version: "0.0.0",
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the approved npm publish set/u);
  });
});

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-package-policy-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeValidFixture(root) {
  writeJson(root, "package.json", {
    name: "harness-anything",
    version: "0.0.1",
    private: true,
    workspaces: ["packages/*", "packages/adapters/*"],
  });
  const packages = new Map([
    ["packages/kernel/package.json", "@harness-anything/kernel"],
    ["packages/application/package.json", "@harness-anything/application"],
    ["packages/daemon/package.json", "@harness-anything/daemon"],
    ["packages/gui/package.json", "@harness-anything/gui"],
    ["packages/adapters/local/package.json", "@harness-anything/adapter-local"],
    ["packages/adapters/multica/package.json", "@harness-anything/adapter-multica"],
  ]);
  for (const [packagePath, name] of packages)
    writeJson(root, packagePath, {
      name,
      version: packagePath === "packages/gui/package.json" ? "0.0.1" : "0.0.0",
      private: true,
    });
  writeJson(root, "packages/cli/package.json", {
    name: "@harness-anything/cli",
    version: "0.0.1",
    publishConfig: { access: "public" },
    repository: { directory: "packages/cli" },
    engines: { node: ">=24" },
    bin: {
      "harness-anything": "dist/cli/src/index.js",
      ha: "dist/cli/src/index.js",
    },
  });
}

function makeDaemonPublicReady(root) {
  writeJson(root, "packages/daemon/package.json", {
    name: "@harness-anything/daemon",
    version: "0.0.1",
    publishConfig: { access: "public" },
    repository: { directory: "packages/daemon" },
    engines: { node: ">=24" },
    bin: { "harness-anything-daemon": "dist/index.js" },
  });
}

function writeJson(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
