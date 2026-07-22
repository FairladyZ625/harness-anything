// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  completeReplicaReadAuthorityStatement,
  detectFullVolumeEncryption,
  resolveFdeProbeBudget,
  evaluateAtRestProfile,
  revokeResidualStatement,
  strictWritableAtRestProfile,
  type AtRestProfile,
  type FdeCommandRunner
} from "../src/index.ts";

test("FDE probe budget resolves environment overrides and rejects invalid values", () => {
  assert.deepEqual(resolveFdeProbeBudget({}), { timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 });
  assert.deepEqual(resolveFdeProbeBudget({
    HARNESS_FDE_PROBE_TIMEOUT_MS: "20000",
    HARNESS_FDE_PROBE_MAX_BUFFER_BYTES: "2097152"
  }), { timeoutMs: 20_000, maxBufferBytes: 2_097_152 });
  assert.throws(() => resolveFdeProbeBudget({ HARNESS_FDE_PROBE_TIMEOUT_MS: "0" }), /HARNESS_FDE_PROBE_TIMEOUT_MS/u);
  assert.throws(() => resolveFdeProbeBudget({ HARNESS_FDE_PROBE_MAX_BUFFER_BYTES: "unbounded" }), /HARNESS_FDE_PROBE_MAX_BUFFER_BYTES/u);
});

test("FileVault detector distinguishes encrypted, plaintext, and failed probes", async () => {
  assert.equal((await detectFullVolumeEncryption({
    platform: "darwin",
    runner: runner({ stdout: "FileVault is On.\n" })
  })).state, "encrypted");
  assert.equal((await detectFullVolumeEncryption({
    platform: "darwin",
    runner: runner({ stdout: "FileVault is Off.\n" })
  })).state, "not-encrypted");
  assert.equal((await detectFullVolumeEncryption({
    platform: "darwin",
    runner: runner({ exitCode: 1, stderr: "unavailable" })
  })).state, "indeterminate");
});

test("LUKS detector follows the root block-device ancestry", async () => {
  const encrypted = await detectFullVolumeEncryption({
    platform: "linux",
    runner: runner({ stdout: JSON.stringify({
      blockdevices: [{
        name: "nvme0n1p3",
        type: "part",
        fstype: "crypto_LUKS",
        mountpoints: [null],
        children: [{ name: "cryptroot", type: "crypt", fstype: "ext4", mountpoints: ["/"] }]
      }]
    }) })
  });
  const plaintext = await detectFullVolumeEncryption({
    platform: "linux",
    runner: runner({ stdout: JSON.stringify({
      blockdevices: [{ name: "vda1", type: "part", fstype: "ext4", mountpoints: ["/"] }]
    }) })
  });

  assert.equal(encrypted.state, "encrypted");
  assert.equal(encrypted.evidenceCode, "luks_root_chain");
  assert.equal(plaintext.state, "not-encrypted");
  assert.equal(plaintext.evidenceCode, "plain_root_chain");
});

test("generic dm-crypt type without a LUKS header does not satisfy the LUKS profile", async () => {
  const evidence = await detectFullVolumeEncryption({
    platform: "linux",
    runner: runner({ stdout: JSON.stringify({
      blockdevices: [{ name: "cryptroot", type: "crypt", fstype: "ext4", mountpoints: ["/"] }]
    }) })
  });

  assert.equal(evidence.state, "not-encrypted");
  assert.equal(evidence.evidenceCode, "plain_root_chain");
});

test("AtRestProfile makes writable denial and read-only degradation explicit", () => {
  const plaintextEvidence = {
    schema: "fde-evidence/v1" as const,
    platform: "linux" as const,
    mechanism: "luks" as const,
    state: "not-encrypted" as const,
    evidenceCode: "plain_root_chain"
  };
  const strict = evaluateAtRestProfile(strictWritableAtRestProfile, plaintextEvidence);
  const readOnlyProfile: AtRestProfile = {
    ...strictWritableAtRestProfile,
    profileId: "fixture-read-only-degradation",
    onNotEncrypted: "read-only"
  };
  const downgraded = evaluateAtRestProfile(readOnlyProfile, plaintextEvidence);

  assert.deepEqual({ mode: strict.accessMode, writable: strict.writableAllowed, degraded: strict.degraded }, {
    mode: "disabled",
    writable: false,
    degraded: true
  });
  assert.deepEqual({ mode: downgraded.accessMode, writable: downgraded.writableAllowed, degraded: downgraded.degraded }, {
    mode: "read-only",
    writable: false,
    degraded: true
  });
});

test("user-facing security statements are honest about read authority and revoke residuals", () => {
  assert.match(completeReplicaReadAuthorityStatement, /entire workspace/u);
  assert.match(completeReplicaReadAuthorityStatement, /does not provide path-level confidentiality/u);
  assert.match(revokeResidualStatement, /stops new data/u);
  assert.match(revokeResidualStatement, /cannot be recalled or remotely erased/u);
});

function runner(result: { readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string }): FdeCommandRunner {
  return {
    run: async () => ({
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    })
  };
}
