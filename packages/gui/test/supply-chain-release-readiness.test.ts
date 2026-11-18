// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessSupplyChainReleaseReadiness,
  validateSupplyChainReleaseReadiness,
  type SupplyChainReleaseReadinessPolicy,
} from "../src/index.ts";

const reviewTime = Date.parse("2026-11-19T00:00:00.000Z");
const registration = {
  packageName: "picomatch",
  ghsaId: "GHSA-fc5q-39xc-vjpf",
  maxUnpatchedVersion: "4.0.7",
  reviewedAt: "2026-11-18T01:04:11.526Z",
  expiresAt: "2026-12-17T00:00:00.000Z",
  rationale: "Reviewed under dec_BCA5A4DEE5D184BE8F3B14E800.",
};

test("supply-chain policy registers the exact reviewed advisory and audit routes", () => {
  const policy = harnessSupplyChainReleaseReadiness;
  assert.deepEqual(policy.auditCommands.map(({ name, command }) => [name, command]).sort(), [
    ["npm-audit-all", "npm audit --audit-level=high --json"],
    ["npm-audit-production", "npm audit --omit=dev --audit-level=high --json"],
  ]);
  assert.deepEqual(policy.reviewedUnpatchedDevAdvisories, [registration]);
});

test("supply-chain policy rejects malformed, overlong and expired registrations", () => {
  for (const [override, now] of [
    [{ packageName: " " }, reviewTime],
    [{ packageName: "picomatch; echo extra" }, reviewTime],
    [{ ghsaId: "GHSA-fc5q-39xc-vjp" }, reviewTime],
    [{ maxUnpatchedVersion: "4.0.07" }, reviewTime],
    [{ maxUnpatchedVersion: "4.0.7-rc.01" }, reviewTime],
    [{ reviewedAt: "2026-11-18" }, reviewTime],
    [{ reviewedAt: "2026-11-31T00:00:00.000Z" }, reviewTime],
    [{ expiresAt: "2026-11-18T01:04:11.526Z" }, reviewTime],
    [{ expiresAt: "2026-12-18T01:04:11.527Z" }, reviewTime],
    [{ rationale: " " }, reviewTime],
    [{}, Date.parse(registration.expiresAt) + 1],
  ] as const) {
    const policy = {
      ...harnessSupplyChainReleaseReadiness,
      reviewedUnpatchedDevAdvisories: [{ ...registration, ...override }],
    };
    assert.deepEqual(
      validateSupplyChainReleaseReadiness(policy, now).errors.map(({ code }) => code),
      ["invalid_audit_contract"],
      JSON.stringify({ override, now }),
    );
  }
});

test("supply-chain policy accepts a 30 day registration at its exact expiry", () => {
  const expiresAt = "2026-12-18T01:04:11.526Z";
  const policy = {
    ...harnessSupplyChainReleaseReadiness,
    reviewedUnpatchedDevAdvisories: [{ ...registration, expiresAt }],
  };
  assert.equal(validateSupplyChainReleaseReadiness(policy, Date.parse(expiresAt)).ok, true);
});

test("supply-chain release readiness covers audit SBOM OSV license and release boundaries", () => {
  const result = validateSupplyChainReleaseReadiness(harnessSupplyChainReleaseReadiness, reviewTime);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.requiredInDefaultCheck, false);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.releaseEvidenceRequiredBeforePublication, true);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.releaseEvidencePath, "release-evidence/osv/scan-result.json");
  assert.equal(harnessSupplyChainReleaseReadiness.workspacePackagePaths.includes("packages/daemon/package.json"), true);
  assert.equal(harnessSupplyChainReleaseReadiness.npmPublishDryRun.requiredBeforePublication, true);
  assert.equal(harnessSupplyChainReleaseReadiness.npmPublishDryRun.actualPublishPermitted, false);
  assert.equal(harnessSupplyChainReleaseReadiness.sbom.releaseArtifactSbomRequiredBeforePublication, true);
  assert.equal(harnessSupplyChainReleaseReadiness.licensePolicy.projectLicense, "AGPL-3.0-or-later");
  assert.equal(harnessSupplyChainReleaseReadiness.licensePolicy.networkServiceReleaseChecklist.length, 5);
  assert.equal(harnessSupplyChainReleaseReadiness.releaseBoundary.releaseArtifactsPublished, false);
});

test("supply-chain release readiness rejects missing OSV and release artifact gates", () => {
  const invalid: SupplyChainReleaseReadinessPolicy = {
    ...harnessSupplyChainReleaseReadiness,
    osv: {
      ...harnessSupplyChainReleaseReadiness.osv,
      releaseEvidencePath: "release-evidence/osv/result.txt" as "release-evidence/osv/scan-result.json",
      requiredInDefaultCheck: true,
      releaseEvidenceRequiredBeforePublication: false,
    },
    sbom: {
      ...harnessSupplyChainReleaseReadiness.sbom,
      releaseArtifactSbomRequiredBeforePublication: false,
    },
    npmPublishDryRun: {
      ...harnessSupplyChainReleaseReadiness.npmPublishDryRun,
      actualPublishPermitted: true,
    },
    releaseBoundary: {
      ...harnessSupplyChainReleaseReadiness.releaseBoundary,
      releaseArtifactsPublished: true,
    },
  };

  const result = validateSupplyChainReleaseReadiness(invalid, reviewTime);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [
      "invalid_sbom_contract",
      "invalid_osv_contract",
      "invalid_npm_publish_dry_run_contract",
      "invalid_release_boundary",
    ],
  );
});

test("supply-chain readiness rejects each release claim and preserves its minimum coverage contract", () => {
  for (const [field, value] of [
    ["packagesPrivateExceptPublicReady", false],
    ["internalWorkspaceVersion", "0.0.2"],
    ["productVersion", "0.2.0"],
    ["publicReadyPackageVersion", "0.2.0"],
    ["npmReleaseClaimed", true],
    ["releaseArtifactsPublished", true],
    ["signedInstallersShipped", true],
    ["autoUpdateShipped", true],
  ] as const) {
    const candidate = {
      ...harnessSupplyChainReleaseReadiness,
      releaseBoundary: { ...harnessSupplyChainReleaseReadiness.releaseBoundary, [field]: value },
    } as SupplyChainReleaseReadinessPolicy;
    assert.deepEqual(
      validateSupplyChainReleaseReadiness(candidate, reviewTime).errors.map(({ code }) => code),
      ["invalid_release_boundary"],
      field,
    );
  }
  const minimum = {
    ...harnessSupplyChainReleaseReadiness,
    workspacePackagePaths: [
      "package.json",
      "packages/cli/package.json",
      "packages/daemon/package.json",
      "packages/gui/package.json",
    ],
    licensePolicy: {
      ...harnessSupplyChainReleaseReadiness.licensePolicy,
      allowedDependencyLicenses: ["BlueOak-1.0.0", "MIT"],
    },
  } as unknown as SupplyChainReleaseReadinessPolicy;
  assert.equal(validateSupplyChainReleaseReadiness(minimum, reviewTime).ok, true);
});
