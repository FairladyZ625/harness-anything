import { runtimeReadinessStatusWords, type RuntimeReadinessStatus } from "./operational-status.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";
export type { RuntimeReadinessStatus } from "./operational-status.ts";
export type RuntimeReadinessSurface = "source-run" | "full-check" | "pr-check" | "package-smoke" | "gui-build";

export interface RuntimeCommandContract {
  readonly surface: RuntimeReadinessSurface;
  readonly command: string;
  readonly requiredInCi: boolean;
  readonly notes: readonly string[];
}

export interface ReleaseBoundaryContract {
  readonly packagesPrivateExceptPublicReady: true;
  readonly internalWorkspaceVersion: "0.0.1";
  readonly productVersion: "0.1.0";
  readonly publicReadyPackageVersion: "0.1.0";
  readonly npmReleaseClaimed: false;
  readonly signedInstallersShipped: false;
  readonly notarizedBuildsShipped: false;
  readonly autoUpdateShipped: false;
  readonly releaseFeedsShipped: false;
  readonly releaseArtifactsPublished: false;
}

export interface RuntimeReleaseReadinessPolicy {
  readonly schema: "runtime-release-readiness/v1";
  readonly currentStatus: RuntimeReadinessStatus;
  readonly supportedNodeMajors: readonly [24, 26];
  readonly minimumNodeMajor: 24;
  readonly ciWorkflowPath: ".github/workflows/rewrite-ci.yml";
  readonly commands: readonly RuntimeCommandContract[];
  readonly releaseBoundary: ReleaseBoundaryContract;
}

export type RuntimeReleaseReadinessErrorCode =
  | "missing_node_coverage"
  | "missing_required_surface"
  | "invalid_minimum_node"
  | "invalid_release_boundary";

export interface RuntimeReleaseReadinessValidationError {
  readonly code: RuntimeReleaseReadinessErrorCode;
  readonly surface?: RuntimeReadinessSurface;
  readonly message: string;
}

export interface RuntimeReleaseReadinessValidationResult {
  readonly ok: boolean;
  readonly errors: readonly RuntimeReleaseReadinessValidationError[];
}

export const runtimeReleasePolicy = {
  id: "runtime-release-readiness",
  ownerRef: "host",
  unit: "release capability and evidence requirements",
  bounds: "Existing readiness requirements; this declaration grants no publication permission.",
  defaultValue: {
    schema: "runtime-release-readiness/v1",
    currentStatus: runtimeReadinessStatusWords[0],
    supportedNodeMajors: [24, 26],
    minimumNodeMajor: 24,
    ciWorkflowPath: ".github/workflows/rewrite-ci.yml",
    commands: [
      {
        surface: "source-run",
        command: "node packages/cli/src/index.ts --help",
        requiredInCi: false,
        notes: [
          "The thin source entry renders its product catalog without loading daemon domain modules or starting a daemon.",
        ],
      },
      {
        surface: "full-check",
        command: "npm run check",
        requiredInCi: true,
        notes: ["Full local and push/scheduled gate; includes supply-chain and package smoke checks."],
      },
      {
        surface: "pr-check",
        command: "npm run check:pr",
        requiredInCi: false,
        notes: ["Local PR gate mirrors pull-request CI shards without supply-chain and smoke-only release checks."],
      },
      {
        surface: "package-smoke",
        command: "npm run harness:smoke-cli-package",
        requiredInCi: true,
        notes: [
          "Builds and packs the CLI workspace, installs the tarball into a temporary consumer, and exercises CLI JSON commands.",
        ],
      },
      {
        surface: "gui-build",
        command: "npm run -w @harness-anything/gui build",
        requiredInCi: true,
        notes: ["Builds the Vite renderer bundle; it is not a signed desktop installer."],
      },
    ],
    releaseBoundary: {
      packagesPrivateExceptPublicReady: true,
      internalWorkspaceVersion: "0.0.1",
      productVersion: "0.1.0",
      publicReadyPackageVersion: "0.1.0",
      npmReleaseClaimed: false,
      signedInstallersShipped: false,
      notarizedBuildsShipped: false,
      autoUpdateShipped: false,
      releaseFeedsShipped: false,
      releaseArtifactsPublished: false,
    },
  } satisfies RuntimeReleaseReadinessPolicy,
  version: 1,
  scope: "Product release readiness gates",
  reason: "Centralize the release boundary and its unique validator without changing accepted release claims.",
  fixtures: ["packages/gui/test/runtime-release-readiness.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#runtimeReleasePolicy.defaultValue.releaseBoundary.npmReleaseClaimed:223928c622f8bbc1fca0f3b0f206910f",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#runtimeReleasePolicy.defaultValue.releaseBoundary.releaseFeedsShipped:63e144b07c8e331b5a5b8ab10fddc845",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#runtimeReleasePolicy.defaultValue.releaseBoundary.releaseArtifactsPublished:acf9c0aca60c6cb9f9ffa5fa5c3ea91b",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#runtimeReleasePolicy.defaultValue.releaseBoundary:6834de4ec77b6833bb31c36adf13da00",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#validateRuntimeReleaseReadiness:b1fc308e28036817b570a1d47b77fb56",
  ].map((candidateId) => ({ candidateId, route: "runtimeReleasePolicy" })),
} as const satisfies OntologyPolicyDeclaration;
export const harnessRuntimeReleaseReadiness: RuntimeReleaseReadinessPolicy = runtimeReleasePolicy.defaultValue;

export function validateRuntimeReleaseReadiness(
  policy: RuntimeReleaseReadinessPolicy,
): RuntimeReleaseReadinessValidationResult {
  const expected = runtimeReleasePolicy.defaultValue;
  const errors: RuntimeReleaseReadinessValidationError[] = [];
  if (policy.minimumNodeMajor !== expected.minimumNodeMajor) {
    errors.push({
      code: "invalid_minimum_node",
      message: "Runtime source execution requires Node 24 as the minimum major.",
    });
  }
  if (expected.supportedNodeMajors.some((major) => !policy.supportedNodeMajors.includes(major))) {
    errors.push({ code: "missing_node_coverage", message: "Runtime readiness must cover Node 24 and Node 26." });
  }
  if (
    policy.commands.find((command) => command.surface === "source-run")?.command !==
    expected.commands.find((command) => command.surface === "source-run")?.command
  ) {
    errors.push({
      code: "missing_required_surface",
      surface: "source-run",
      message: "Source readiness must probe the thin CLI help surface.",
    });
  }

  for (const { surface } of expected.commands) {
    if (!policy.commands.some((command) => command.surface === surface)) {
      errors.push({
        code: "missing_required_surface",
        surface,
        message: `Missing runtime readiness surface: ${surface}`,
      });
    }
  }

  const boundary = policy.releaseBoundary;
  if (
    Object.entries(expected.releaseBoundary).some(([key, value]) => boundary[key as keyof typeof boundary] !== value)
  ) {
    errors.push({
      code: "invalid_release_boundary",
      message:
        "P10 runtime readiness cannot claim real package release, signed installers, notarized builds, auto-update, release feeds, or release artifacts.",
    });
  }

  return { ok: errors.length === 0, errors };
}

export const runtimeReleasePolicyJudgment = {
  id: "validateRuntimeReleaseReadiness",
  symbol: "packages/kernel/src/domain/runtime-release-readiness.ts#validateRuntimeReleaseReadiness",
  inputs: ["RuntimeReleaseReadinessPolicy"],
  output: "validation result with ordered errors",
  failureCodes: [
    "missing_node_coverage",
    "missing_required_surface",
    "invalid_minimum_node",
    "invalid_release_boundary",
  ],
  explain: "Validate existing runtime-release-readiness claims against the declared release boundary.",
  consumers: ["tools/check-runtime-release-readiness.mjs"],
  sources: [
    {
      candidateId:
        "judgment:packages/kernel:packages/kernel/src/domain/runtime-release-readiness.ts#validateRuntimeReleaseReadiness:01ee1469ab1b7ddb35188089485b48b3",
      route: "runtime-release-readiness",
    },
  ],
} as const satisfies OntologyJudgmentDeclaration;
