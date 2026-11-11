import { supplyChainReadinessStatusWords, type SupplyChainReadinessStatus } from "./operational-status.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";
export type { SupplyChainReadinessStatus } from "./operational-status.ts";

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
  readonly actualPublishPermitted: false;
  readonly requiredBeforePublication: true;
}

export interface LicensePolicyContract {
  readonly projectLicense: "AGPL-3.0-or-later";
  readonly allowedDependencyLicenses: readonly [
    "0BSD",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MIT",
    "MPL-2.0",
    "OFL-1.1",
  ];
  readonly reviewedDependencyLicenseChoices: readonly ReviewedDependencyLicenseChoice[];
  readonly networkServiceReleaseNotesRequired: true;
  readonly networkServiceReleaseChecklist: readonly [
    "public source offer and license notice",
    "modified source corresponding to the network service",
    "deployment and service docs preserve AGPL notices",
    "release notes identify user-visible network-service changes",
    "third-party license notices included with release evidence",
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
  readonly packagesPrivateExceptPublicReady: true;
  readonly internalWorkspaceVersion: "0.0.1";
  readonly productVersion: "0.1.0";
  readonly publicReadyPackageVersion: "0.1.0";
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

export const supplyChainReleasePolicy = {
  id: "supply-chain-release-readiness",
  ownerRef: "host",
  unit: "release capability and evidence requirements",
  bounds: "Existing readiness requirements; this declaration grants no publication permission.",
  defaultValue: {
    schema: "supply-chain-release-readiness/v1",
    currentStatus: supplyChainReadinessStatusWords[0],
    workspacePackagePaths: [
      "package.json",
      "packages/kernel/package.json",
      "packages/application/package.json",
      "packages/daemon/package.json",
      "packages/cli/package.json",
      "packages/gui/package.json",
    ],
    auditCommands: [
      {
        name: "npm-audit-all",
        command: "npm audit --audit-level=high",
        auditLevel: "high",
        requiredInDefaultCheck: true,
      },
      {
        name: "npm-audit-production",
        command: "npm audit --omit=dev --audit-level=high",
        auditLevel: "high",
        requiredInDefaultCheck: true,
      },
    ],
    sbom: {
      format: "CycloneDX",
      specVersion: "1.5",
      generationCommand: "npm sbom --sbom-format=cyclonedx --sbom-type=application",
      releaseArtifactSbomRequiredBeforePublication: true,
      requiresComponentPurl: true,
      requiresComponentLicense: true,
      requiresComponentHash: true,
    },
    osv: {
      liveScanCommand: "npx --yes osv-scanner@latest --lockfile=package-lock.json",
      releaseEvidencePath: "release-evidence/osv/scan-result.json",
      requiredInDefaultCheck: false,
      releaseEvidenceRequiredBeforePublication: true,
      deterministicDefaultGate: "package-lock-present-and-command-documented",
    },
    npmPublishDryRun: {
      actualPublishPermitted: false,
      requiredBeforePublication: true,
    },
    licensePolicy: {
      projectLicense: "AGPL-3.0-or-later",
      allowedDependencyLicenses: [
        "0BSD",
        "Apache-2.0",
        "BlueOak-1.0.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "MIT",
        "MPL-2.0",
        "OFL-1.1",
      ],
      reviewedDependencyLicenseChoices: [
        {
          packageName: "caniuse-lite",
          declaredLicenseExpression: "CC-BY-4.0",
          electedLicense: "CC-BY-4.0",
          reviewedAt: "2026-10-19",
          rationale:
            "Reviewed caniuse-lite 1.0.30001816 package.json and README. Browserslist browser-compatibility data package, transitively introduced as a devDependency via @babel/core → @babel/helper-compilation-targets → browserslist; CC-BY-4.0 applies to the data, which is not linked into the Harness runtime. Reviewed under decision dec_10FAEB2487C3165EDCCC8453BF; re-review on version upgrade.",
        },
        {
          packageName: "dompurify",
          declaredLicenseExpression: "(MPL-2.0 OR Apache-2.0)",
          electedLicense: "Apache-2.0",
          reviewedAt: "2026-10-02",
          rationale:
            "Reviewed dompurify 3.4.16 package.json and LICENSE. Elect its Apache-2.0 branch; preserve that license and notices. npm SBOM omits the compound expression.",
        },
        {
          packageName: "jszip",
          declaredLicenseExpression: "(MIT OR GPL-3.0-or-later)",
          electedLicense: "MIT",
          reviewedAt: "2026-10-02",
          rationale:
            "Reviewed jszip 3.10.2 package.json and LICENSE.markdown. Elect the MIT branch explicitly offered for this DOCX dependency; preserve copyright and permission notices.",
        },
        {
          packageName: "khroma",
          declaredLicenseExpression: "MIT",
          electedLicense: "MIT",
          reviewedAt: "2026-10-02",
          rationale:
            "Reviewed khroma 2.1.0 license file: MIT text and copyright notice are shipped, although package.json omits the license field. Preserve those notices.",
        },
        {
          packageName: "pako",
          declaredLicenseExpression: "(MIT AND Zlib)",
          electedLicense: "MIT AND Zlib",
          reviewedAt: "2026-10-02",
          rationale:
            "Reviewed pako 1.0.11 LICENSE and lib/zlib/deflate.js header. Both MIT and Zlib apply; this is not an OR election. Preserve both notices and mark any modified zlib source.",
        },
        {
          packageName: "robust-predicates",
          declaredLicenseExpression: "Unlicense",
          electedLicense: "Unlicense",
          reviewedAt: "2026-10-02",
          rationale:
            "Reviewed robust-predicates 3.0.3 LICENSE public-domain dedication and unrestricted use grant. Record this exact package only; do not add Unlicense to the general allowlist. Preserve the supplied license with distribution notices.",
        },
        {
          packageName: "expand-template",
          declaredLicenseExpression: "(MIT OR WTFPL)",
          electedLicense: "MIT",
          reviewedAt: "2026-07-04",
          rationale:
            "Transitive dependency of @effect/sql-sqlite-node via better-sqlite3/prebuild tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch.",
        },
        {
          packageName: "rc",
          declaredLicenseExpression: "(BSD-2-Clause OR MIT OR Apache-2.0)",
          electedLicense: "MIT",
          reviewedAt: "2026-07-04",
          rationale:
            "Transitive dependency of @effect/sql-sqlite-node via better-sqlite3/prebuild tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch.",
        },
        {
          packageName: "argparse",
          declaredLicenseExpression: "Python-2.0",
          electedLicense: "Python-2.0",
          reviewedAt: "2026-07-08",
          rationale:
            "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. Python-2.0 is a permissive license and this package is used for local build tooling, not the Harness runtime distribution.",
        },
        {
          packageName: "sanitize-filename",
          declaredLicenseExpression: "WTFPL OR ISC",
          electedLicense: "ISC",
          reviewedAt: "2026-07-08",
          rationale:
            "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. The SPDX OR expression includes ISC; project elects the permissive ISC branch and the package is not part of the Harness runtime distribution.",
        },
        {
          packageName: "truncate-utf8-bytes",
          declaredLicenseExpression: "WTFPL",
          electedLicense: "WTFPL",
          reviewedAt: "2026-07-08",
          rationale:
            "DevDependency-only transitive dependency introduced by electron-builder packaging tooling through sanitize-filename. WTFPL is permissive and this package is used only in local build tooling, not the Harness runtime distribution.",
        },
        {
          packageName: "type-fest",
          declaredLicenseExpression: "(MIT OR CC0-1.0)",
          electedLicense: "MIT",
          reviewedAt: "2026-07-08",
          rationale:
            "DevDependency-only transitive dependency introduced by electron-builder packaging tooling. The SPDX OR expression includes MIT; project elects the permissive MIT branch and the package is not part of the Harness runtime distribution.",
        },
        {
          packageName: "utf8-byte-length",
          declaredLicenseExpression: "(WTFPL OR MIT)",
          electedLicense: "MIT",
          reviewedAt: "2026-07-08",
          rationale:
            "DevDependency-only transitive dependency introduced by electron-builder packaging tooling through truncate-utf8-bytes. The SPDX OR expression includes MIT; project elects the permissive MIT branch and the package is not part of the Harness runtime distribution.",
        },
      ],
      networkServiceReleaseNotesRequired: true,
      networkServiceReleaseChecklist: [
        "public source offer and license notice",
        "modified source corresponding to the network service",
        "deployment and service docs preserve AGPL notices",
        "release notes identify user-visible network-service changes",
        "third-party license notices included with release evidence",
      ],
      agplNoticeRequired: true,
    },
    dependabot: {
      ecosystem: "npm",
      directories: ["/"],
      requiredLabels: ["dependencies", "security"],
    },
    electronUpgrade: {
      packageName: "electron",
      upgradeRequiresSecurityReview: true,
      reviewDoc: "docs-release/release-posture.md",
    },
    releaseBoundary: {
      packagesPrivateExceptPublicReady: true,
      internalWorkspaceVersion: "0.0.1",
      productVersion: "0.1.0",
      publicReadyPackageVersion: "0.1.0",
      npmReleaseClaimed: false,
      releaseArtifactsPublished: false,
      signedInstallersShipped: false,
      autoUpdateShipped: false,
    },
  } satisfies SupplyChainReleaseReadinessPolicy,
  version: 1,
  scope: "Product release readiness gates",
  reason: "Centralize the release boundary and its unique validator without changing accepted release claims.",
  fixtures: ["packages/gui/test/supply-chain-release-readiness.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.sbom.releaseArtifactSbomRequiredBeforePublication:a3ad05f450e78a531a1a57d447defdd1",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.osv.releaseEvidencePath:e7b1f34427e05e57a17086c0db2306a9",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.osv.releaseEvidenceRequiredBeforePublication:8dbb1038e6634de873515b261a66d904",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.licensePolicy.networkServiceReleaseNotesRequired:c542e6e04a0300e2d0a7f555987fd3f0",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.licensePolicy:9ce286e4530700615fbb4217b3935fef",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.releaseBoundary.npmReleaseClaimed:223928c622f8bbc1fca0f3b0f206910f",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.releaseBoundary.releaseArtifactsPublished:acf9c0aca60c6cb9f9ffa5fa5c3ea91b",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#supplyChainReleasePolicy.defaultValue.releaseBoundary:c237aff9ee0760d31901440244ef7cb0",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#validateSupplyChainReleaseReadiness:7570eeb0f85cc69afe859cde6b58096e",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#validateSupplyChainReleaseReadiness:289587dd09266e3fe92f5b4a70a9d8aa",
    "policy:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#validateSupplyChainReleaseReadiness:40d6cd74474573b4694d65a79c533d5e",
  ].map((candidateId) => ({ candidateId, route: "supplyChainReleasePolicy" })),
} as const satisfies OntologyPolicyDeclaration;
export const harnessSupplyChainReleaseReadiness: SupplyChainReleaseReadinessPolicy =
  supplyChainReleasePolicy.defaultValue;

export function validateSupplyChainReleaseReadiness(
  policy: SupplyChainReleaseReadinessPolicy,
): SupplyChainReleaseReadinessValidationResult {
  const expected = supplyChainReleasePolicy.defaultValue;
  const errors: SupplyChainReleaseReadinessValidationError[] = [];

  if (
    !policy.workspacePackagePaths.includes("package.json") ||
    !policy.workspacePackagePaths.includes("packages/cli/package.json") ||
    !policy.workspacePackagePaths.includes("packages/daemon/package.json") ||
    !policy.workspacePackagePaths.includes("packages/gui/package.json")
  ) {
    errors.push({
      code: "missing_workspace_package",
      message: "Supply-chain readiness must cover the root, CLI, daemon, and GUI workspace packages.",
    });
  }

  if (
    policy.auditCommands.length !== expected.auditCommands.length ||
    expected.auditCommands.some(
      (required) => !policy.auditCommands.some((command) => command.command === required.command),
    )
  ) {
    errors.push({
      code: "invalid_audit_contract",
      message: "Supply-chain readiness must include full and production-only high-severity npm audit gates.",
    });
  }

  if (
    policy.sbom.format !== expected.sbom.format ||
    policy.sbom.specVersion !== expected.sbom.specVersion ||
    policy.sbom.generationCommand !== expected.sbom.generationCommand ||
    policy.sbom.releaseArtifactSbomRequiredBeforePublication !==
      expected.sbom.releaseArtifactSbomRequiredBeforePublication
  ) {
    errors.push({
      code: "invalid_sbom_contract",
      message: "Supply-chain readiness must require CycloneDX 1.5 SBOM generation and release artifact SBOM gating.",
    });
  }

  if (
    policy.osv.liveScanCommand !== expected.osv.liveScanCommand ||
    policy.osv.releaseEvidencePath !== expected.osv.releaseEvidencePath ||
    policy.osv.requiredInDefaultCheck !== expected.osv.requiredInDefaultCheck ||
    policy.osv.releaseEvidenceRequiredBeforePublication !== expected.osv.releaseEvidenceRequiredBeforePublication
  ) {
    errors.push({
      code: "invalid_osv_contract",
      message: "OSV readiness must be explicit release evidence without becoming a flaky default local network gate.",
    });
  }

  if (
    policy.npmPublishDryRun.actualPublishPermitted !== expected.npmPublishDryRun.actualPublishPermitted ||
    policy.npmPublishDryRun.requiredBeforePublication !== expected.npmPublishDryRun.requiredBeforePublication
  ) {
    errors.push({
      code: "invalid_npm_publish_dry_run_contract",
      message: "NPM publish readiness must require dry-run evidence with no real publish permission.",
    });
  }

  if (
    policy.licensePolicy.projectLicense !== expected.licensePolicy.projectLicense ||
    !policy.licensePolicy.allowedDependencyLicenses.includes("BlueOak-1.0.0") ||
    !policy.licensePolicy.allowedDependencyLicenses.includes("MIT") ||
    !policy.licensePolicy.reviewedDependencyLicenseChoices.every(
      (choice) =>
        choice.packageName.length > 0 &&
        choice.declaredLicenseExpression.length > 0 &&
        choice.electedLicense.length > 0 &&
        choice.reviewedAt.length > 0 &&
        choice.rationale.length > 0,
    ) ||
    policy.licensePolicy.networkServiceReleaseNotesRequired !==
      expected.licensePolicy.networkServiceReleaseNotesRequired ||
    policy.licensePolicy.networkServiceReleaseChecklist.length !==
      expected.licensePolicy.networkServiceReleaseChecklist.length ||
    policy.licensePolicy.agplNoticeRequired !== expected.licensePolicy.agplNoticeRequired
  ) {
    errors.push({
      code: "invalid_license_policy",
      message: "License readiness must preserve AGPL project licensing and network-service release-note obligations.",
    });
  }

  if (
    policy.dependabot.directories.length !== expected.dependabot.directories.length ||
    !policy.dependabot.directories.includes(expected.dependabot.directories[0])
  ) {
    errors.push({
      code: "invalid_dependabot_contract",
      message: "Dependabot npm coverage must use the workspace root lockfile entry.",
    });
  }

  if (
    policy.electronUpgrade.packageName !== expected.electronUpgrade.packageName ||
    policy.electronUpgrade.upgradeRequiresSecurityReview !== expected.electronUpgrade.upgradeRequiresSecurityReview
  ) {
    errors.push({
      code: "invalid_electron_upgrade_contract",
      message: "Electron upgrades must remain explicit security-review events.",
    });
  }

  const boundary = policy.releaseBoundary;
  if (
    Object.entries(expected.releaseBoundary).some(([key, value]) => boundary[key as keyof typeof boundary] !== value)
  ) {
    errors.push({
      code: "invalid_release_boundary",
      message:
        "P11 supply-chain readiness cannot claim real npm release, release artifacts, signed installers, or auto-update.",
    });
  }

  return { ok: errors.length === 0, errors };
}

export const supplyChainReleasePolicyJudgment = {
  id: "validateSupplyChainReleaseReadiness",
  symbol: "packages/kernel/src/domain/supply-chain-release-readiness.ts#validateSupplyChainReleaseReadiness",
  inputs: ["SupplyChainReleaseReadinessPolicy"],
  output: "validation result with ordered errors",
  failureCodes: [
    "missing_workspace_package",
    "invalid_audit_contract",
    "invalid_sbom_contract",
    "invalid_osv_contract",
    "invalid_npm_publish_dry_run_contract",
    "invalid_license_policy",
    "invalid_dependabot_contract",
    "invalid_electron_upgrade_contract",
    "invalid_release_boundary",
  ],
  explain: "Validate existing supply-chain-release-readiness claims against the declared release boundary.",
  consumers: ["tools/check-supply-chain.mjs"],
  sources: [
    {
      candidateId:
        "judgment:packages/kernel:packages/kernel/src/domain/supply-chain-release-readiness.ts#validateSupplyChainReleaseReadiness:788ba63487699aa2e9670ab5bded485e",
      route: "supply-chain-release-readiness",
    },
  ],
} as const satisfies OntologyJudgmentDeclaration;
