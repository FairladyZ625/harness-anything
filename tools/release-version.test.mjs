// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("release version script accepts prerelease semver", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  try {
    for (const [name, body] of [
      ["package.json", { version: "0.0.1", workspaces: ["packages/*"] }],
      ["packages/application/package.json", { version: "0.0.1" }],
      ["packages/cli/package.json", { version: "0.0.1", dependencies: { "@harness-anything/application": "0.0.1" } }],
      ["packages/daemon/package.json", { version: "0.0.1" }],
      ["packages/gui/package.json", { version: "0.0.1" }],
      ["packages/kernel/package.json", { version: "0.0.1" }],
      ["packages/preset/package.json", { version: "0.0.1" }],
    ]) {
      const file = join(dir, name);
      const parent = file.slice(0, file.lastIndexOf("/"));
      if (name.includes("/")) execFileSync("mkdir", ["-p", parent]);
      writeFileSync(file, JSON.stringify(body));
    }
    execFileSync(process.execPath, [fileURLToPath(new URL("./release-version.mjs", import.meta.url)), "0.1.0-rc.1"], {
      env: { ...process.env, RELEASE_ROOT: dir },
    });
    assert.equal(JSON.parse(readFileSync(join(dir, "packages/gui/package.json"))).version, "0.1.0-rc.1");
    assert.equal(
      JSON.parse(readFileSync(join(dir, "packages/cli/package.json"))).dependencies["@harness-anything/application"],
      "0.1.0-rc.1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
