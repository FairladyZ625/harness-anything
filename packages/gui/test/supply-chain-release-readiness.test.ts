import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessSupplyChainReleaseReadiness,
  validateSupplyChainReleaseReadiness,
  type SupplyChainReleaseReadinessPolicy
} from "../src/distribution/supply-chain-release-readiness.ts";

test("supply-chain release readiness covers audit SBOM OSV license and release boundaries", () => {
  const result = validateSupplyChainReleaseReadiness(harnessSupplyChainReleaseReadiness);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.requiredInDefaultCheck, false);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.releaseEvidenceRequiredBeforePublication, true);
  assert.equal(harnessSupplyChainReleaseReadiness.osv.releaseEvidencePath, "release-evidence/osv/scan-result.json");
  assert.equal(harnessSupplyChainReleaseReadiness.workspacePackagePaths.includes("packages/daemon/package.json"), true);
  assert.equal(harnessSupplyChainReleaseReadiness.npmPublishDryRun.command, "npm publish --dry-run --workspace @harness-anything/cli --access public");
  assert.deepEqual(harnessSupplyChainReleaseReadiness.npmPublishDryRun.publishablePackages, ["@harness-anything/cli"]);
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
      releaseEvidenceRequiredBeforePublication: false
    },
    sbom: {
      ...harnessSupplyChainReleaseReadiness.sbom,
      releaseArtifactSbomRequiredBeforePublication: false
    },
    npmPublishDryRun: {
      ...harnessSupplyChainReleaseReadiness.npmPublishDryRun,
      actualPublishPermitted: true
    },
    releaseBoundary: {
      ...harnessSupplyChainReleaseReadiness.releaseBoundary,
      releaseArtifactsPublished: true
    }
  };

  const result = validateSupplyChainReleaseReadiness(invalid);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["invalid_sbom_contract", "invalid_osv_contract", "invalid_npm_publish_dry_run_contract", "invalid_release_boundary"]
  );
});
