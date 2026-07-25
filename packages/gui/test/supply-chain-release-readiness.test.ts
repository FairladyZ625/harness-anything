// harness-test-tier: contract
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
  assert.equal(harnessSupplyChainReleaseReadiness.workspacePackagePaths.includes("packages/api-contracts/package.json"), true);
  assert.equal(harnessSupplyChainReleaseReadiness.workspacePackagePaths.includes("packages/daemon-client/package.json"), true);
  assert.equal(harnessSupplyChainReleaseReadiness.workspacePackagePaths.includes("packages/vscode-ext/package.json"), true);
  assert.equal(harnessSupplyChainReleaseReadiness.npmPublishDryRun.command, "npm publish --dry-run --workspace @harness-anything/cli --access public");
  assert.deepEqual(harnessSupplyChainReleaseReadiness.npmPublishDryRun.publishablePackages, ["@harness-anything/cli"]);
  assert.equal(harnessSupplyChainReleaseReadiness.npmPublishDryRun.actualPublishPermitted, false);
  assert.equal(harnessSupplyChainReleaseReadiness.sbom.releaseArtifactSbomRequiredBeforePublication, true);
  assert.equal(harnessSupplyChainReleaseReadiness.licensePolicy.projectLicense, "AGPL-3.0-or-later");
  assert.deepEqual(harnessSupplyChainReleaseReadiness.licensePolicy.allowedDependencyLicenses, [
    "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "OFL-1.1"
  ]);
  const jszipReview = harnessSupplyChainReleaseReadiness.licensePolicy.reviewedDependencyLicenseChoices
    .find((choice) => choice.packageName === "jszip");
  assert.equal(jszipReview?.declaredLicenseExpression, "(MIT OR GPL-3.0-or-later)");
  assert.equal(jszipReview?.electedLicense, "MIT");
  assert.match(jszipReview?.rationale ?? "", /Build-only/u);
  assert.equal(harnessSupplyChainReleaseReadiness.licensePolicy.networkServiceReleaseChecklist.length, 5);
  assert.equal(harnessSupplyChainReleaseReadiness.releaseBoundary.releaseArtifactsPublished, false);
});

test("live npm audit stays an advisory signal instead of a required merge gate", () => {
  // A required gate whose verdict follows upstream advisory data fails on a repository that
  // did not change, and blocks main and every open pull request at once
  // (dec_01KYB7TMSPAASW4XTAAA0CVH5W, CH2). Both audit commands must stay out of that gate.
  const audits = harnessSupplyChainReleaseReadiness.auditCommands;

  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.equal(audit.requiredInDefaultCheck, false);
    assert.equal(audit.deterministicDefaultGate, "lockfile-license-and-sbom-structure");
    assert.equal(audit.advisoryLane, "nightly-supply-chain-advisory");
  }

  // Coverage must move lanes, not disappear: both audit paths still have to be declared.
  const commands = audits.map((audit) => audit.command);
  assert.equal(commands.includes("npm audit --audit-level=high"), true);
  assert.equal(commands.includes("npm audit --omit=dev --audit-level=high"), true);
});

test("supply-chain release readiness rejects re-promoting live audit into the required gate", () => {
  const invalid: SupplyChainReleaseReadinessPolicy = {
    ...harnessSupplyChainReleaseReadiness,
    auditCommands: [
      {
        ...harnessSupplyChainReleaseReadiness.auditCommands[0],
        requiredInDefaultCheck: true as unknown as false
      },
      harnessSupplyChainReleaseReadiness.auditCommands[1]
    ]
  };

  const result = validateSupplyChainReleaseReadiness(invalid);

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_audit_contract"), true);
});

test("supply-chain release readiness rejects dropping the advisory lane declaration", () => {
  // Marking audit non-required while naming no lane would silently delete live audit
  // coverage rather than relocate it.
  const invalid: SupplyChainReleaseReadinessPolicy = {
    ...harnessSupplyChainReleaseReadiness,
    auditCommands: [
      {
        ...harnessSupplyChainReleaseReadiness.auditCommands[0],
        advisoryLane: "" as unknown as "nightly-supply-chain-advisory"
      },
      harnessSupplyChainReleaseReadiness.auditCommands[1]
    ]
  };

  const result = validateSupplyChainReleaseReadiness(invalid);

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_audit_contract"), true);
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
