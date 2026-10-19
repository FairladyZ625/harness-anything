// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSettingsFacet } from "@harness-anything/kernel";

const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)),
  oldSample = readFileSync(
    new URL("../../kernel/fixtures/settings-migration/retired-settings-before.yaml", import.meta.url),
    "utf8",
  );

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "migrate", "settings", ...args, "--json"], { encoding: "utf8" });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) as Record<string, unknown> };
}

test("settings migration rejects the retired sample, preserves its source, and writes a reader-valid candidate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-migration-"));
  try {
    const source = path.join(root, "harness.yaml"),
      candidate = path.join(root, "candidate.yaml");
    writeFileSync(source, oldSample);
    assert.throws(() => readSettingsFacet(oldSample), /not declared/u);

    const dryRun = invoke("--source", source, "--mode", "dry-run", "--destination", candidate);
    assert.equal(dryRun.status, 0, JSON.stringify(dryRun));
    assert.deepEqual(dryRun.receipt.removedPaths, [
      "workerPermissions.ciRead",
      "workerPermissions.artifactRead",
      "workerPermissions.push",
      "workerPermissions.pullRequest",
      "workerPermissions.merge",
      "workerPermissions.repositorySettings",
      "workerPermissions.gitlab",
      "delivery.platform",
      "ci.workflows",
      "gates.ci",
    ]);
    assert.equal(readFileSync(source, "utf8"), oldSample);
    assert.throws(() => readFileSync(candidate, "utf8"), { code: "ENOENT" });

    const converted = invoke("--source", source, "--mode", "convert", "--destination", candidate);
    assert.equal(converted.status, 0, JSON.stringify(converted));
    assert.equal(readFileSync(source, "utf8"), oldSample);
    const current = readSettingsFacet(readFileSync(candidate, "utf8"));
    assert.equal(current.workerPermissions.mode, "restricted");
    assert.equal(current.delivery.requireMerged, true);
    assert.equal(current.delivery.targetBranch, "release/stable");
    assert.deepEqual(current.gates, [{ gateId: "human-review", adapter: "manual-attest" }]);
    assert.throws(() => invoke("--source", source, "--mode", "convert", "--destination", candidate), /EEXIST/u);
    assert.equal(readFileSync(source, "utf8"), oldSample);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings conversion requires a distinct new destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-migration-destination-"));
  try {
    const source = path.join(root, "harness.yaml");
    writeFileSync(source, oldSample);
    assert.throws(() => invoke("--source", source, "--mode", "convert"), /convert requires --destination/u);
    assert.throws(
      () => invoke("--source", source, "--mode", "convert", "--destination", source),
      /must differ from --source/u,
    );
    assert.equal(readFileSync(source, "utf8"), oldSample);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
