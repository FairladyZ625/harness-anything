export type RuntimeReadinessStatus = "source-checkout-and-package-smoke-only";
export type RuntimeReadinessSurface = "source-run" | "full-check" | "pr-check" | "package-smoke" | "gui-build";

export interface RuntimeCommandContract {
  readonly surface: RuntimeReadinessSurface;
  readonly command: string;
  readonly requiredInCi: boolean;
  readonly notes: readonly string[];
}

export interface ReleaseBoundaryContract {
  readonly packagesPrivate: true;
  readonly workspaceVersion: "0.0.0";
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

export const harnessRuntimeReleaseReadiness: RuntimeReleaseReadinessPolicy = {
  schema: "runtime-release-readiness/v1",
  currentStatus: "source-checkout-and-package-smoke-only",
  supportedNodeMajors: [24, 26],
  minimumNodeMajor: 24,
  ciWorkflowPath: ".github/workflows/rewrite-ci.yml",
  commands: [
    {
      surface: "source-run",
      command: "node packages/cli/src/index.ts --json doctor",
      requiredInCi: false,
      notes: ["Source-entry commands rely on Node 24+ built-in TypeScript execution."]
    },
    {
      surface: "full-check",
      command: "npm run check",
      requiredInCi: true,
      notes: ["Full local and push/scheduled gate; includes supply-chain and package smoke checks."]
    },
    {
      surface: "pr-check",
      command: "npm run check:pr",
      requiredInCi: false,
      notes: ["Local PR gate mirrors pull-request CI shards without supply-chain and smoke-only release checks."]
    },
    {
      surface: "package-smoke",
      command: "npm run harness:smoke-cli-package",
      requiredInCi: true,
      notes: ["Builds and packs the CLI workspace, installs the tarball into a temporary consumer, and exercises CLI JSON commands."]
    },
    {
      surface: "gui-build",
      command: "npm run -w @harness-anything/gui build",
      requiredInCi: true,
      notes: ["Builds the Vite renderer bundle; it is not a signed desktop installer."]
    }
  ],
  releaseBoundary: {
    packagesPrivate: true,
    workspaceVersion: "0.0.0",
    npmReleaseClaimed: false,
    signedInstallersShipped: false,
    notarizedBuildsShipped: false,
    autoUpdateShipped: false,
    releaseFeedsShipped: false,
    releaseArtifactsPublished: false
  }
};

export function validateRuntimeReleaseReadiness(
  policy: RuntimeReleaseReadinessPolicy
): RuntimeReleaseReadinessValidationResult {
  const errors: RuntimeReleaseReadinessValidationError[] = [];
  if (policy.minimumNodeMajor !== 24) {
    errors.push({ code: "invalid_minimum_node", message: "Runtime source execution requires Node 24 as the minimum major." });
  }
  if (!policy.supportedNodeMajors.includes(24) || !policy.supportedNodeMajors.includes(26)) {
    errors.push({ code: "missing_node_coverage", message: "Runtime readiness must cover Node 24 and Node 26." });
  }

  for (const surface of ["source-run", "full-check", "pr-check", "package-smoke", "gui-build"] as const) {
    if (!policy.commands.some((command) => command.surface === surface)) {
      errors.push({ code: "missing_required_surface", surface, message: `Missing runtime readiness surface: ${surface}` });
    }
  }

  const boundary = policy.releaseBoundary;
  if (
    boundary.packagesPrivate !== true ||
    boundary.workspaceVersion !== "0.0.0" ||
    boundary.npmReleaseClaimed !== false ||
    boundary.signedInstallersShipped !== false ||
    boundary.notarizedBuildsShipped !== false ||
    boundary.autoUpdateShipped !== false ||
    boundary.releaseFeedsShipped !== false ||
    boundary.releaseArtifactsPublished !== false
  ) {
    errors.push({
      code: "invalid_release_boundary",
      message: "P10 runtime readiness cannot claim package release, signed installers, notarized builds, auto-update, release feeds, or release artifacts."
    });
  }

  return { ok: errors.length === 0, errors };
}
