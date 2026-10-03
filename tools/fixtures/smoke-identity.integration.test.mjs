// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { smokeIdentity, lastReceipt } from "./smoke-identity.mjs";
import { evaluateWindowsFirstRun } from "../gates/windows-first-run.mjs";
import { buildCliPackageArtifact, env } from "../smoke-cli-package.mjs";

test("first-run identity is required, then the complete real CLI smoke succeeds", async () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  buildCliPackageArtifact(repo);
  const daemonBuild = spawnSync("npm", ["run", "build", "--workspace", "@harness-anything/daemon"], {
    cwd: repo,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  assert.equal(daemonBuild.status, 0);
  const root = mkdtempSync(path.join(tmpdir(), "ha-first-run-negative-"));
  const entry = path.join(repo, "packages/cli/dist/cli/src/index.js");
  const environment = env(path.join(root, "daemon"), root);
  const cli = (args, input) =>
    spawnSync(process.execPath, [entry, "--root", root, "--json", ...args], {
      cwd: root,
      env: environment,
      input,
      encoding: "utf8",
      windowsHide: true,
    });
  const identity = await smokeIdentity(root, "different-repository");
  try {
    const unsigned = cli(["init", "--repo-id", "unsigned", "--person-id", "owner", "--display-name", "Owner"]);
    assert.notEqual(unsigned.status, 0, unsigned.stdout);
    assert.equal(lastReceipt(unsigned.stdout).configureVerify.causeCode, "authorization_denied");
    console.log("without identity: init configure_verify_failed / authorization_denied");
    identity.prepare((args, input) => {
      const result = cli(args, input);
      return { ...result, receipt: lastReceipt(result.stdout) };
    });
    const wrongScope = cli(["init", "--repo-id", "unsigned", "--person-id", "owner", "--display-name", "Owner"]);
    assert.notEqual(wrongScope.status, 0, wrongScope.stdout);
    assert.equal(lastReceipt(wrongScope.stdout).configureVerify.causeCode, "authorization_denied");
    console.log("signed in with another repository grant: init rejected / authorization_denied");
  } finally {
    cli(["daemon", "stop"]);
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
  const result = await evaluateWindowsFirstRun(repo);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.checks.length, 11);
});
