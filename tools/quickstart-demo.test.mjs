// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawnKeycloak, signInAt } from "../packages/daemon/test/keycloak.fixtures.ts";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoScript = path.join(repoRoot, "scripts/quickstart-demo.mjs");
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");

const realm = await spawnKeycloak();
after(() => realm.close());
await realm.control({ op: "account", personId: "quickstart-owner" });
await realm.control({
  op: "permit",
  personId: "quickstart-owner",
  resource: "quickstart",
  actions: effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
});

test("quickstart demo runs daemon init to task to event-backed Fact show", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [demoScript, "--cli", cliEntry, "--root", rootDir], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);

    assert.equal(result.ok, true);
    assert.equal(result.schema, "quickstart-demo/v1");
    assert.match(result.taskId, /^task_[0-9a-f]{26}$/u);
    assert.match(result.factRef, /^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u);
  });
});

test("quickstart demo fails closed when a middle step is deliberately broken", () => {
  withTempRoot((rootDir) => {
    const result = spawnSync(
      process.execPath,
      [demoScript, "--cli", cliEntry, "--root", rootDir, "--break-step", "fact-record"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    assert.notEqual(result.status, 0);
    const failure = parseLastJsonObject(result.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.step, "fact record");
    assert.match(failure.error, /fact record .*exited non-zero/u);
  });
});

function withTempRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-quickstart-test-"));
  try {
    realm.bind(path.join(rootDir, ".daemon-user"));
    signInAt(path.join(rootDir, ".daemon-user"), "quickstart-owner");
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function parseLastJsonObject(output) {
  const start = output.lastIndexOf("{\n");
  assert.notEqual(start, -1, output);
  return JSON.parse(output.slice(start));
}

test("quickstart without a Keycloak session gives bootstrap guidance before init", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-quickstart-signed-out-"));
  try {
    const result = spawnSync(process.execPath, [demoScript, "--cli", cliEntry, "--root", rootDir], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(result.status, 0);
    const failure = parseLastJsonObject(result.stderr);
    assert.equal(failure.step, "Keycloak sign-in");
    assert.match(failure.error, /ha bootstrap.*ha bootstrap --operation login/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
