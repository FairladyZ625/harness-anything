// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessSupplyChainReleaseReadiness,
  validateSupplyChainReleaseReadiness,
  type SupplyChainReleaseReadinessPolicy,
} from "../src/index.ts";

test("supply-chain release readiness covers audit SBOM OSV license and release boundaries", () => {
  const result = validateSupplyChainReleaseReadiness(harnessSupplyChainReleaseReadiness);

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

  const result = validateSupplyChainReleaseReadiness(invalid);

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
      validateSupplyChainReleaseReadiness(candidate).errors.map(({ code }) => code),
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
  assert.equal(validateSupplyChainReleaseReadiness(minimum).ok, true);
});
