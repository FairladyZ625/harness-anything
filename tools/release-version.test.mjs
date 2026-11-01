// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("release version script bumps public workspaces, keeps private build workspaces, and aligns deps", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  try {
    writeJson(dir, "package.json", { name: "harness-anything", version: "0.0.1", workspaces: ["packages/*"] });
    writeJson(dir, "packages/kernel/package.json", { name: "@harness-anything/kernel", version: "0.0.1" });
    writeJson(dir, "packages/storage/package.json", {
      name: "@harness-anything/storage",
      version: "0.0.1",
      dependencies: { "@harness-anything/kernel": "0.0.1" },
    });
    writeJson(dir, "packages/cli/package.json", {
      name: "@harness-anything/cli",
      version: "0.0.1",
      dependencies: { "@harness-anything/storage": "0.0.1" },
    });
    writeJson(dir, "packages/adapter/package.json", {
      name: "@harness-anything/adapter",
      version: "0.0.1",
      private: true,
      dependencies: { "@harness-anything/kernel": "0.0.1" },
    });
    writeJson(dir, "packages/gui/package.json", {
      name: "@harness-anything/gui",
      version: "0.0.1",
      devDependencies: { "@harness-anything/adapter": "0.0.1" },
    });
    writeJson(dir, "package-lock.json", {
      lockfileVersion: 3,
      packages: {
        "": { name: "harness-anything", version: "0.0.1" },
        "packages/cli": { version: "0.0.1", dependencies: { "@harness-anything/storage": "0.0.1" } },
        "packages/adapter": { version: "0.0.1", dependencies: { "@harness-anything/kernel": "0.0.1" } },
        "node_modules/@harness-anything/cli": { version: "0.0.1" },
        "node_modules/@harness-anything/adapter": { version: "0.0.1" },
      },
    });

    execFileSync(process.execPath, [fileURLToPath(new URL("./release-version.mjs", import.meta.url)), "0.1.0-rc.1"], {
      env: { ...process.env, RELEASE_ROOT: dir },
    });

    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "0.1.0-rc.1");
    assert.equal(JSON.parse(readFileSync(join(dir, "packages/gui/package.json"))).version, "0.1.0-rc.1");
    assert.equal(JSON.parse(readFileSync(join(dir, "packages/storage/package.json"))).version, "0.1.0-rc.1");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/cli/package.json"))).dependencies["@harness-anything/storage"],
      "0.1.0-rc.1",
    );
    const adapter = JSON.parse(readFileSync(join(dir, "packages/adapter/package.json")));
    assert.equal(adapter.version, "0.0.1");
    assert.equal(adapter.dependencies["@harness-anything/kernel"], "0.1.0-rc.1");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/gui/package.json"))).devDependencies["@harness-anything/adapter"],
      "0.0.1",
    );
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json")));
    assert.equal(lock.packages[""].version, "0.1.0-rc.1");
    assert.equal(lock.packages["packages/cli"].version, "0.1.0-rc.1");
    assert.equal(lock.packages["packages/adapter"].version, "0.0.1");
    assert.equal(lock.packages["packages/adapter"].dependencies["@harness-anything/kernel"], "0.1.0-rc.1");
    assert.equal(lock.packages["node_modules/@harness-anything/cli"].version, "0.1.0-rc.1");
    assert.equal(lock.packages["node_modules/@harness-anything/adapter"].version, "0.0.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(root, relativePath, value) {
  const file = join(root, relativePath);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
