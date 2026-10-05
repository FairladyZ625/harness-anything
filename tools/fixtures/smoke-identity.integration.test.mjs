// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { smokeIdentity, lastReceipt } from "./smoke-identity.mjs";
import { evaluateWindowsFirstRun } from "../gates/windows-first-run.mjs";
import { buildCliPackageArtifact, env } from "../smoke-cli-package.mjs";

test("first-run identity is required, then the complete real CLI smoke succeeds", async () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const daemonMarker = path.join(repo, "packages/daemon/dist/build-id.txt");
  const daemonBuildId = readFileSync(daemonMarker, "utf8");
  buildCliPackageArtifact(repo);
  // The runner prepares the daemon before spawning test files. Rebuilding here replaces the
  // shared build-id and makes daemons in concurrent CLI tests exit for build supersession.
  assert.equal(
    readFileSync(daemonMarker, "utf8"),
    daemonBuildId,
    "smoke must preserve the runner-prepared daemon build used by concurrent tests",
  );
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
    // The init attempts above are refused before any workspace registration, so the plain
    // stop is refused the same way and the resident daemon would keep the tree open. The
    // sanitized smoke environment fixes the daemon id; bounded retries absorb the window
    // between a confirmed stop and Windows releasing the last handle.
    cli(["daemon", "stop", "--daemon-id", "default"]);
    await identity.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const result = await evaluateWindowsFirstRun(repo);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.checks.length, 11);
});
