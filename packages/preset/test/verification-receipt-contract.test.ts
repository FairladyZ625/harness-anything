// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, resolveCompletionContract } from "@harness-anything/kernel";
import { createRuntime, validatePresetPackage, validateVerticalSource } from "../src/preset-resolver.ts";
import { defaultAssets, defaultBundled } from "../src/preset-resolver-common.ts";

test("software/coding vertical and standard-task verified profile pass validation and preserve baseline", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-verified-preset-contract-"));
  try {
    const presetReport = validatePresetPackage({ source: path.join(defaultBundled, "standard-task") });
    assert.equal(presetReport.valid, true, JSON.stringify(presetReport.issues));

    const verticalReport = validateVerticalSource({
      source: defaultAssets,
      presetId: "standard-task",
      userRoot,
    });
    assert.equal(verticalReport.valid, true, JSON.stringify(verticalReport.issues));

    const runtime = createRuntime({ userRoot });
    const baseline = await runtime.resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(baseline.ok, true);
    if (baseline.ok) {
      assert.deepEqual(baseline.snapshot.profile.completionGateIds, []);
    }

    const verified = await runtime.resolver.resolve({
      presetId: "standard-task",
      verticalId: "software/coding",
      profileId: "verified",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;

    assert.deepEqual(verified.snapshot.profile.completionGateIds, ["verification-receipt"]);
    assert.ok(verified.snapshot.completionPackages["software-coding/verification-receipt"]);

    const resolvedContract = resolveCompletionContract(
      verified.snapshot.profile.completionGateIds,
      { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
      { digest: verified.snapshot.digest, completion: verified.snapshot.completion },
    );
    assert.equal(resolvedContract.ok, true);
    if (!resolvedContract.ok) return;

    assert.equal(resolvedContract.contract.gates.length, 1);
    const gate = resolvedContract.contract.gates[0]!;
    assert.equal(gate.gateId, "verification-receipt");
    assert.equal(gate.appliesTo, "submission");
    assert.equal(gate.witness.kind, "command");
    assert.deepEqual(Object.keys(gate.bindings ?? {}).sort(), [
      "commitSha",
      "failed",
      "passed",
      "timedOut",
      "total",
      "unexecuted",
    ]);

    const presetDoc = readFileSync(path.join(defaultBundled, "standard-task", "PRESET.md"), "utf8");
    assert.match(presetDoc, /--profile verified/u);
    assert.match(presetDoc, /artifacts\/verification-receipt\.json/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
