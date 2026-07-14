export type SupplyChainReadinessStatus = "release-gate-without-published-artifacts";

export interface AuditCommandContract {
  readonly name: "npm-audit-all" | "npm-audit-production";
  readonly command: string;
  readonly auditLevel: "high";
  readonly requiredInDefaultCheck: true;
}

export interface SbomContract {
  readonly format: "CycloneDX";
  readonly specVersion: "1.5";
  readonly generationCommand: string;
  readonly releaseArtifactSbomRequiredBeforePublication: true;
  readonly requiresComponentPurl: true;
  readonly requiresComponentLicense: true;
  readonly requiresComponentHash: true;
}

export interface OsvContract {
  readonly liveScanCommand: "npx --yes osv-scanner@latest --lockfile=package-lock.json";
  readonly releaseEvidencePath: "release-evidence/osv/scan-result.json";
  readonly requiredInDefaultCheck: false;
  readonly releaseEvidenceRequiredBeforePublication: true;
  readonly deterministicDefaultGate: "package-lock-present-and-command-documented";
}

export interface NpmPublishDryRunContract {
  readonly packageName: "@harness-anything/cli";
  readonly packagePath: "packages/cli/package.json";
  readonly version: "0.1.0";
  readonly command: "npm publish --dry-run --workspace @harness-anything/cli --access public";
  readonly publishablePackages: readonly ["@harness-anything/cli"];
  readonly actualPublishPermitted: false;
  readonly requiredBeforePublication: true;
}

export interface LicensePolicyContract {
  readonly projectLicense: "AGPL-3.0-or-later";
  readonly allowedDependencyLicenses: readonly ["0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "OFL-1.1"];
  readonly reviewedDependencyLicenseChoices: readonly ReviewedDependencyLicenseChoice[];
  readonly networkServiceReleaseNotesRequired: true;
  readonly networkServiceReleaseChecklist: readonly [
    "public source offer and license notice",
    "modified source corresponding to the network service",
    "deployment and service docs preserve AGPL notices",
    "release notes identify user-visible network-service changes",
    "third-party license notices included with release evidence"
  ];
  readonly agplNoticeRequired: true;
}

export interface ReviewedDependencyLicenseChoice {
  readonly packageName: string;
  readonly declaredLicenseExpression: string;
  readonly electedLicense: string;
  readonly reviewedAt: string;
  readonly rationale: string;
}

export interface DependabotCoverageContract {
  readonly ecosystem: "npm";
  readonly directories: readonly ["/"];
  readonly requiredLabels: readonly ["dependencies", "security"];
}

export interface ElectronUpgradeContract {
  readonly packageName: "electron";
  readonly upgradeRequiresSecurityReview: true;
  readonly reviewDoc: "docs-release/release-posture.md";
}

export interface SupplyChainReleaseBoundaryContract {
  readonly packagesPrivateExceptCli: true;
  readonly privateWorkspaceVersion: "0.0.0";
  readonly cliPublishDryRunVersion: "0.1.0";
  readonly npmReleaseClaimed: false;
  readonly releaseArtifactsPublished: false;
  readonly signedInstallersShipped: false;
  readonly autoUpdateShipped: false;
}

export interface SupplyChainReleaseReadinessPolicy {
  readonly schema: "supply-chain-release-readiness/v1";
  readonly currentStatus: SupplyChainReadinessStatus;
  readonly workspacePackagePaths: readonly [
    "package.json",
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
    "packages/adapters/local/package.json",
    "packages/adapters/multica/package.json",
    "packages/adapters/github-issues/package.json",
    "packages/adapters/linear/package.json"
  ];
  readonly auditCommands: readonly [AuditCommandContract, AuditCommandContract];
  readonly sbom: SbomContract;
  readonly osv: OsvContract;
  readonly npmPublishDryRun: NpmPublishDryRunContract;
  readonly licensePolicy: LicensePolicyContract;
  readonly dependabot: DependabotCoverageContract;
  readonly electronUpgrade: ElectronUpgradeContract;
  readonly releaseBoundary: SupplyChainReleaseBoundaryContract;
}

export type SupplyChainReleaseReadinessErrorCode =
  | "missing_workspace_package"
  | "invalid_audit_contract"
  | "invalid_sbom_contract"
  | "invalid_osv_contract"
  | "invalid_npm_publish_dry_run_contract"
  | "invalid_license_policy"
  | "invalid_dependabot_contract"
  | "invalid_electron_upgrade_contract"
  | "invalid_release_boundary";

export interface SupplyChainReleaseReadinessValidationError {
  readonly code: SupplyChainReleaseReadinessErrorCode;
  readonly message: string;
}

export interface SupplyChainReleaseReadinessValidationResult {
  readonly ok: boolean;
  readonly errors: readonly SupplyChainReleaseReadinessValidationError[];
}

export const harnessSupplyChainReleaseReadiness: SupplyChainReleaseReadinessPolicy = {
  schema: "supply-chain-release-readiness/v1",
  currentStatus: "release-gate-without-published-artifacts",
  workspacePackagePaths: [
    "package.json",
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
    "packages/adapters/local/package.json",
    "packages/adapters/multica/package.json",
    "packages/adapters/github-issues/package.json",
    "packages/adapters/linear/package.json"
  ],
  auditCommands: [
    {
      name: "npm-audit-all",
      command: "npm audit --audit-level=high",
      auditLevel: "high",
      requiredInDefaultCheck: true
    },
    {
      name: "npm-audit-production",
      command: "npm audit --omit=dev --audit-level=high",
      auditLevel: "high",
      requiredInDefaultCheck: true
    }
  ],
  sbom: {
    format: "CycloneDX",
    specVersion: "1.5",
    generationCommand: "npm sbom --sbom-format=cyclonedx --sbom-type=application",
    releaseArtifactSbomRequiredBeforePublication: true,
    requiresComponentPurl: true,
    requiresComponentLicense: true,
    requiresComponentHash: true
  },
  osv: {
    liveScanCommand: "npx --yes osv-scanner@latest --lockfile=package-lock.json",
    releaseEvidencePath: "release-evidence/osv/scan-result.json",
    requiredInDefaultCheck: false,
    releaseEvidenceRequiredBeforePublication: true,
    deterministicDefaultGate: "package-lock-present-and-command-documented"
  },
  npmPublishDryRun: {
    packageName: "@harness-anything/cli",
    packagePath: "packages/cli/package.json",
    version: "0.1.0",
    command: "npm publish --dry-run --workspace @harness-anything/cli --access public",
    publishablePackages: ["@harness-anything/cli"],
    actualPublishPermitted: false,
    requiredBeforePublication: true
  },
  licensePolicy: {
    projectLicense: "AGPL-3.0-or-later",
    allowedDependencyLicenses: ["0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "OFL-1.1"],
    reviewedDependencyLicenseChoices: [
      {
        packageName: "elkjs",
        declaredLicenseExpression: "EPL-2.0",
        electedLicense: "EPL-2.0",
        reviewedAt: "2026-07-14",
        rationale: "Runtime dependency of the GUI relationship graph: elkjs (Eclipse Layout Kernel JS) performs the orthogonal edge routing adopted for the ego/spotlight view (dec_01KXFABST0E47G3MJX9MQ2C72Q). EPL-2.0 is weak file-level copyleft in the same tier as the already-allowed MPL-2.0; as an unmodified bundled dependency it does not impose copyleft on the project's AGPL-3.0-or-later source. Reviewed and accepted by CEO-principal."
      },
      {
        packageName: "expand-template",
        declaredLicenseExpression: "(MIT OR WTFPL)",
        electedLicense: "MIT",
        reviewedAt: "2026-07-04",
        rationale: "Transitive dependency of @effect/sql-sqlite-node via better-sqlite3/prebuild tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch."
      },
      {
        packageName: "rc",
        declaredLicenseExpression: "(BSD-2-Clause OR MIT OR Apache-2.0)",
        electedLicense: "MIT",
        reviewedAt: "2026-07-04",
        rationale: "Transitive dependency of @effect/sql-sqlite-node via better-sqlite3/prebuild tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch."
      },
      {
        packageName: "argparse",
        declaredLicenseExpression: "Python-2.0",
        electedLicense: "Python-2.0",
        reviewedAt: "2026-07-08",
        rationale: "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. Python-2.0 is a permissive license and this package is used for local build tooling, not the Harness runtime distribution."
      },
      {
        packageName: "sanitize-filename",
        declaredLicenseExpression: "WTFPL OR ISC",
        electedLicense: "ISC",
        reviewedAt: "2026-07-08",
        rationale: "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. The SPDX OR expression includes ISC; project elects the permissive ISC branch and the package is not part of the Harness runtime distribution."
      },
      {
        packageName: "truncate-utf8-bytes",
        declaredLicenseExpression: "WTFPL",
        electedLicense: "WTFPL",
        reviewedAt: "2026-07-08",
        rationale: "DevDependency-only transitive dependency introduced by electron-builder packaging tooling through sanitize-filename. WTFPL is permissive and this package is used only in local build tooling, not the Harness runtime distribution."
      },
      {
        packageName: "type-fest",
        declaredLicenseExpression: "(MIT OR CC0-1.0)",
        electedLicense: "MIT",
        reviewedAt: "2026-07-08",
        rationale: "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch and the package is not part of the Harness runtime distribution."
      },
      {
        packageName: "utf8-byte-length",
        declaredLicenseExpression: "(WTFPL OR MIT)",
        electedLicense: "MIT",
        reviewedAt: "2026-07-08",
        rationale: "DevDependency-only transitive dependency introduced by electron-builder packaging tooling through truncate-utf8-bytes. The SPDX OR expression includes MIT; project elects the permissive MIT branch and the package is not part of the Harness runtime distribution."
      }
    ],
    networkServiceReleaseNotesRequired: true,
    networkServiceReleaseChecklist: [
      "public source offer and license notice",
      "modified source corresponding to the network service",
      "deployment and service docs preserve AGPL notices",
      "release notes identify user-visible network-service changes",
      "third-party license notices included with release evidence"
    ],
    agplNoticeRequired: true
  },
  dependabot: {
    ecosystem: "npm",
    directories: ["/"],
    requiredLabels: ["dependencies", "security"]
  },
  electronUpgrade: {
    packageName: "electron",
    upgradeRequiresSecurityReview: true,
    reviewDoc: "docs-release/release-posture.md"
  },
  releaseBoundary: {
    packagesPrivateExceptCli: true,
    privateWorkspaceVersion: "0.0.0",
    cliPublishDryRunVersion: "0.1.0",
    npmReleaseClaimed: false,
    releaseArtifactsPublished: false,
    signedInstallersShipped: false,
    autoUpdateShipped: false
  }
};

export function validateSupplyChainReleaseReadiness(
  policy: SupplyChainReleaseReadinessPolicy
): SupplyChainReleaseReadinessValidationResult {
  const errors: SupplyChainReleaseReadinessValidationError[] = [];

  if (
    !policy.workspacePackagePaths.includes("package.json") ||
    !policy.workspacePackagePaths.includes("packages/cli/package.json") ||
    !policy.workspacePackagePaths.includes("packages/daemon/package.json") ||
    !policy.workspacePackagePaths.includes("packages/gui/package.json")
  ) {
    errors.push({ code: "missing_workspace_package", message: "Supply-chain readiness must cover the root, CLI, daemon, and GUI workspace packages." });
  }

  if (
    policy.auditCommands.length !== 2 ||
    !policy.auditCommands.some((command) => command.command === "npm audit --audit-level=high") ||
    !policy.auditCommands.some((command) => command.command === "npm audit --omit=dev --audit-level=high")
  ) {
    errors.push({ code: "invalid_audit_contract", message: "Supply-chain readiness must include full and production-only high-severity npm audit gates." });
  }

  if (
    policy.sbom.format !== "CycloneDX" ||
    policy.sbom.specVersion !== "1.5" ||
    policy.sbom.generationCommand !== "npm sbom --sbom-format=cyclonedx --sbom-type=application" ||
    policy.sbom.releaseArtifactSbomRequiredBeforePublication !== true
  ) {
    errors.push({ code: "invalid_sbom_contract", message: "Supply-chain readiness must require CycloneDX 1.5 SBOM generation and release artifact SBOM gating." });
  }

  if (
    policy.osv.liveScanCommand !== "npx --yes osv-scanner@latest --lockfile=package-lock.json" ||
    policy.osv.releaseEvidencePath !== "release-evidence/osv/scan-result.json" ||
    policy.osv.requiredInDefaultCheck !== false ||
    policy.osv.releaseEvidenceRequiredBeforePublication !== true
  ) {
    errors.push({ code: "invalid_osv_contract", message: "OSV readiness must be explicit release evidence without becoming a flaky default local network gate." });
  }

  if (
    policy.npmPublishDryRun.packageName !== "@harness-anything/cli" ||
    policy.npmPublishDryRun.packagePath !== "packages/cli/package.json" ||
    policy.npmPublishDryRun.version !== "0.1.0" ||
    policy.npmPublishDryRun.command !== "npm publish --dry-run --workspace @harness-anything/cli --access public" ||
    policy.npmPublishDryRun.publishablePackages.length !== 1 ||
    !policy.npmPublishDryRun.publishablePackages.includes("@harness-anything/cli") ||
    policy.npmPublishDryRun.actualPublishPermitted !== false ||
    policy.npmPublishDryRun.requiredBeforePublication !== true
  ) {
    errors.push({
      code: "invalid_npm_publish_dry_run_contract",
      message: "NPM publish readiness must stay limited to a CLI-only dry-run command with no real publish permission."
    });
  }

  if (
    policy.licensePolicy.projectLicense !== "AGPL-3.0-or-later" ||
    !policy.licensePolicy.allowedDependencyLicenses.includes("BlueOak-1.0.0") ||
    !policy.licensePolicy.allowedDependencyLicenses.includes("MIT") ||
    !policy.licensePolicy.reviewedDependencyLicenseChoices.every((choice) =>
      choice.packageName.length > 0 &&
      choice.declaredLicenseExpression.length > 0 &&
      choice.electedLicense.length > 0 &&
      choice.reviewedAt.length > 0 &&
      choice.rationale.length > 0
    ) ||
    policy.licensePolicy.networkServiceReleaseNotesRequired !== true ||
    policy.licensePolicy.networkServiceReleaseChecklist.length !== 5 ||
    policy.licensePolicy.agplNoticeRequired !== true
  ) {
    errors.push({ code: "invalid_license_policy", message: "License readiness must preserve AGPL project licensing and network-service release-note obligations." });
  }

  if (policy.dependabot.directories.length !== 1 || !policy.dependabot.directories.includes("/")) {
    errors.push({ code: "invalid_dependabot_contract", message: "Dependabot npm coverage must use the workspace root lockfile entry." });
  }

  if (policy.electronUpgrade.packageName !== "electron" || policy.electronUpgrade.upgradeRequiresSecurityReview !== true) {
    errors.push({ code: "invalid_electron_upgrade_contract", message: "Electron upgrades must remain explicit security-review events." });
  }

  const boundary = policy.releaseBoundary;
  if (
    boundary.packagesPrivateExceptCli !== true ||
    boundary.privateWorkspaceVersion !== "0.0.0" ||
    boundary.cliPublishDryRunVersion !== "0.1.0" ||
    boundary.npmReleaseClaimed !== false ||
    boundary.releaseArtifactsPublished !== false ||
    boundary.signedInstallersShipped !== false ||
    boundary.autoUpdateShipped !== false
  ) {
    errors.push({
      code: "invalid_release_boundary",
      message: "P11 supply-chain readiness cannot claim real npm release, release artifacts, signed installers, or auto-update."
    });
  }

  return { ok: errors.length === 0, errors };
}
