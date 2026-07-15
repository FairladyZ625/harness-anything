// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  preflightPresetManifest,
  type PresetManifest,
  type PresetManifestV3,
  type PresetRawFsEnforcementEvidence,
  type PresetRawFsGrant
} from "../../src/index.ts";
import {
  catalogPresetCapabilityProviders,
  type PresetPreflightOptions
} from "../../src/domain/preset-preflight.ts";

const packageDigest = `sha256:${"a".repeat(64)}`;
const decodedV3 = Schema.decodeUnknownSync(PresetManifestSchema)(JSON.parse(readFileSync(
  "packages/kernel/fixtures/schemas/preset-manifest/valid-v3.json",
  "utf8"
)));
if (decodedV3.schema !== "preset-manifest/v3") throw new Error("v3 fixture decoded as the wrong manifest variant");
const validV3 = decodedV3;

test("semantic preflight accepts catalog capabilities only when every exact provider exists", () => {
  const receipt = preflightPresetManifest(validV3, options({ providers: catalogPresetCapabilityProviders() }));

  assert.equal(receipt.valid, true);
  assert.equal(receipt.runtime, "semantic-capability-preflight/v1");
  assert.equal(receipt.semanticFailureFallback, "forbidden");
  assert.equal(receipt.entrypoints[0]?.capabilities.every((capability) => capability.provider === "ready"), true);
  assert.equal(receipt.warnings.some((warning) => warning.code === "broad-capability-selector"), true);
});

test("semantic preflight fails closed for unknown capability ids, versions, selectors, and missing providers", () => {
  const variants = [
    {
      request: { capability: "unknown-capability", version: "1", select: {} },
      code: "unknown_capability"
    },
    {
      request: { capability: "tasks", version: "2", select: { scope: "all", view: "identity-and-preset" } },
      code: "unknown_capability_version"
    },
    {
      request: { capability: "tasks", version: "1", select: { scope: "all", view: "full-filesystem" } },
      code: "unsupported_capability_selector"
    }
  ] as const;

  for (const variant of variants) {
    const manifest = withRequires([variant.request]);
    const receipt = preflightPresetManifest(manifest, options());
    assert.equal(receipt.valid, false);
    assert.equal(receipt.issues.some((issue) => issue.code === variant.code), true);
    assert.equal(receipt.issues.some((issue) => issue.code === "capability_provider_missing"), true);
    assert.equal(receipt.semanticFailureFallback, "forbidden");
  }
});

test("semantic preflight validates typed selector references and input defaults", () => {
  const manifest = structuredClone(validV3) as unknown as PresetManifestV3 & {
    entrypoints: Record<string, { inputs: Record<string, unknown>; requires: unknown[] }>;
  };
  const audit = manifest.entrypoints.audit!;
  audit.inputs.taskId = {
    type: "task-ref",
    required: true,
    default: "task_one",
    defaultFrom: "current-task"
  };
  audit.requires = [{ capability: "tasks", version: "1", select: { taskFrom: "missingTask", view: "intent-summary" } }];

  const receipt = preflightPresetManifest(manifest as unknown as PresetManifest, options({ providers: catalogPresetCapabilityProviders() }));
  assert.equal(receipt.issues.some((issue) => issue.code === "invalid_input_default"), true);
  assert.equal(receipt.issues.some((issue) => issue.code === "invalid_input_reference"), true);
});

test("legacy manifests remain valid through the isolated physical-scope adapter with a warning", () => {
  const legacy = Schema.decodeUnknownSync(PresetManifestSchema)(JSON.parse(readFileSync(
    "packages/cli/test/fixtures/preset-v3-canaries/doc-canon-sync/v2/preset.json",
    "utf8"
  )));
  const receipt = preflightPresetManifest(legacy, options());

  assert.equal(receipt.valid, true);
  assert.equal(receipt.runtime, "legacy-scope-adapter/v1");
  assert.equal(receipt.warnings.some((warning) => warning.code === "legacy-physical-scope"), true);
});

test("raw-fs admission requires external trust, exact binding, active approval, physical proof, host enforcement, and coordinator ingest", () => {
  const manifest = rawFsManifest();
  const grant = rawFsGrant();
  const enforcement = rawFsEnforcement();
  const admitted = preflightPresetManifest(manifest, options({ rawFsGrants: [grant], rawFsEnforcement: [enforcement] }));
  assert.equal(admitted.valid, true);
  assert.equal(admitted.entrypoints[0]?.escapeHatches[0]?.admitted, true);
  assert.deepEqual(admitted.entrypoints[0]?.escapeHatches[0]?.normalizedScopeCeiling, ["output:artifacts/**"]);
  assert.deepEqual(admitted.entrypoints[0]?.escapeHatches[0]?.normalizedPhysicalScopes, ["/stage/output/artifacts/**"]);
  assert.equal(admitted.entrypoints[0]?.escapeHatches[0]?.policyGrant, "raw-fs/architecture-source-scan");
  assert.deepEqual(admitted.entrypoints[0]?.escapeHatches[0]?.denialCodes, []);

  const cases: ReadonlyArray<{
    readonly code: string;
    readonly grants?: ReadonlyArray<PresetRawFsGrant>;
    readonly enforcement?: ReadonlyArray<PresetRawFsEnforcementEvidence>;
  }> = [
    { code: "raw_fs_grant_missing", grants: [], enforcement: [enforcement] },
    { code: "raw_fs_source_untrusted", grants: [{ ...grant, packageDigest: `sha256:${"b".repeat(64)}` }], enforcement: [enforcement] },
    { code: "raw_fs_grant_mismatch", grants: [{ ...grant, presetVersion: "2.0.0" }], enforcement: [enforcement] },
    { code: "raw_fs_approval_invalid", grants: [{ ...grant, decisionState: "proposed" }], enforcement: [enforcement] },
    { code: "raw_fs_scope_unverified", grants: [grant], enforcement: [{ ...enforcement, toctouProtected: false }] },
    { code: "raw_fs_scope_unverified", grants: [grant], enforcement: [{ ...enforcement, forbiddenRootSafe: false }] },
    { code: "raw_fs_host_unenforced", grants: [grant], enforcement: [{ ...enforcement, hostEnforced: false }] },
    { code: "raw_fs_coordinator_required", grants: [grant], enforcement: [{ ...enforcement, coordinatorEnforced: false }] }
  ];
  for (const candidate of cases) {
    const receipt = preflightPresetManifest(manifest, options({
      rawFsGrants: candidate.grants,
      rawFsEnforcement: candidate.enforcement
    }));
    assert.equal(receipt.valid, false, candidate.code);
    assert.equal(receipt.issues.some((issue) => issue.code === candidate.code), true, candidate.code);
    assert.equal(receipt.entrypoints[0]?.escapeHatches[0]?.admitted, false, candidate.code);
  }
});

function withRequires(requires: ReadonlyArray<unknown>): PresetManifest {
  const manifest = structuredClone(validV3) as unknown as PresetManifestV3 & {
    entrypoints: Record<string, { requires: ReadonlyArray<unknown> }>;
  };
  manifest.entrypoints.audit!.requires = requires;
  return manifest as unknown as PresetManifest;
}

function rawFsManifest(): PresetManifestV3 {
  const decoded = Schema.decodeUnknownSync(PresetManifestSchema)({
    schema: "preset-manifest/v3",
    id: "raw-fs-fixture",
    title: "Raw FS Fixture",
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      audit: {
        type: "script",
        command: "scripts/audit.mjs",
        intent: { verb: "audit", subject: "raw-fs-fixture" },
        inputs: {},
        requires: [],
        produces: [],
        sideEffects: [{
          effect: "raw-fs",
          id: "architecture-source-scan",
          access: "staged-write",
          scopes: [{ root: "output", pattern: "artifacts/**" }],
          justification: "The detector needs a staged diagnostic output not represented by a canonical projection.",
          approval: {
            owner: "person_zeyu",
            decisionRef: "dec_RAWFS1",
            policyGrant: "raw-fs/architecture-source-scan",
            expiresAt: "2026-08-01T00:00:00Z"
          }
        }]
      }
    },
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
    defaultProfile: "baseline"
  });
  if (decoded.schema !== "preset-manifest/v3") throw new Error("raw-fs fixture decoded as the wrong manifest variant");
  return decoded;
}

function rawFsGrant(): PresetRawFsGrant {
  return {
    policyGrant: "raw-fs/architecture-source-scan",
    presetId: "raw-fs-fixture",
    presetVersion: "1.0.0",
    entrypoint: "audit",
    packageDigest,
    sourceTrust: "independent-policy-grant",
    access: "staged-write",
    scopes: [{ root: "output", pattern: "artifacts/**" }],
    owner: "person_zeyu",
    decisionRef: "dec_RAWFS1",
    decisionState: "accepted",
    expiresAt: "2026-08-01T00:00:00Z"
  };
}

function rawFsEnforcement(): PresetRawFsEnforcementEvidence {
  return {
    policyGrant: "raw-fs/architecture-source-scan",
    effectId: "architecture-source-scan",
    normalizedScopes: ["output:artifacts/**"],
    normalizedPhysicalScopes: ["/stage/output/artifacts/**"],
    lexicalContainment: true,
    realpathContainment: true,
    symlinkLeafSafe: true,
    forbiddenRootSafe: true,
    toctouProtected: true,
    hostEnforced: true,
    coordinatorEnforced: true
  };
}

function options(overrides: Partial<PresetPreflightOptions> = {}): PresetPreflightOptions {
  return {
    layer: "project",
    packageDigest,
    now: "2026-07-15T00:00:00Z",
    providers: [],
    ...overrides
  };
}
