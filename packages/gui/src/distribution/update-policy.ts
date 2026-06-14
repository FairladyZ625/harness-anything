export type DistributionPlatform = "macos" | "windows" | "linux";
export type DistributionSurface = "desktopApp" | "localDaemon" | "remoteDaemon";
export type ReleaseStatus = "dev-only" | "planned" | "shipped";
export type UpdateMode = "manual" | "auto";
export type UpdateTransport = "source-checkout" | "package-manager" | "signed-feed" | "ssh-bootstrap";
export type UnsignedAllowance = "dev-only" | "never";

export interface SigningPolicy {
  readonly requiredForProduction: boolean;
  readonly notarizationRequired: boolean;
  readonly unsignedAllowance: UnsignedAllowance;
}

export interface UpdatePolicy {
  readonly mode: UpdateMode;
  readonly shipped: boolean;
  readonly transport: UpdateTransport;
  readonly requiresUserApproval: boolean;
  readonly rollback: "manual-redownload" | "package-manager-reinstall" | "remote-daemon-rebootstrap";
}

export interface RemoteDaemonBootstrapPolicy {
  readonly transport: "system-ssh-tunnel";
  readonly protocol: "daemon-api-v1";
  readonly installsGui: false;
  readonly tokenBootstrap: "one-time-attach-token";
}

export interface DistributionPolicyEntry {
  readonly surface: DistributionSurface;
  readonly platform: DistributionPlatform;
  readonly artifact: string;
  readonly releaseStatus: ReleaseStatus;
  readonly signing: SigningPolicy;
  readonly update: UpdatePolicy;
  readonly remoteBootstrap?: RemoteDaemonBootstrapPolicy;
  readonly notes: readonly string[];
}

export interface DistributionArchitecturePolicy {
  readonly schema: "distribution-update-policy/v1";
  readonly currentStatus: "source-and-package-smoke-only";
  readonly entries: readonly DistributionPolicyEntry[];
}

export type DistributionPolicyErrorCode =
  | "missing_required_surface"
  | "missing_desktop_platform"
  | "missing_local_daemon_platform"
  | "unsigned_production"
  | "missing_macos_notarization"
  | "unsupported_auto_update"
  | "manual_update_without_user_approval"
  | "manual_update_marked_shipped"
  | "remote_daemon_bootstrap_drift"
  | "remote_daemon_update_drift";

export interface DistributionPolicyValidationError {
  readonly code: DistributionPolicyErrorCode;
  readonly surface?: DistributionSurface;
  readonly platform?: DistributionPlatform;
  readonly message: string;
}

export interface DistributionPolicyValidationResult {
  readonly ok: boolean;
  readonly errors: readonly DistributionPolicyValidationError[];
}

export const harnessDistributionPolicy: DistributionArchitecturePolicy = {
  schema: "distribution-update-policy/v1",
  currentStatus: "source-and-package-smoke-only",
  entries: [
    desktopEntry("macos", "future-dmg-or-zip", {
      requiredForProduction: true,
      notarizationRequired: true,
      unsignedAllowance: "dev-only"
    }),
    desktopEntry("windows", "future-msi-or-exe", {
      requiredForProduction: true,
      notarizationRequired: false,
      unsignedAllowance: "dev-only"
    }),
    desktopEntry("linux", "future-appimage-deb-rpm-or-tarball", {
      requiredForProduction: true,
      notarizationRequired: false,
      unsignedAllowance: "dev-only"
    }),
    localDaemonEntry("macos", "future-launchd-or-bundled-sidecar-daemon", true),
    localDaemonEntry("windows", "future-windows-service-or-bundled-sidecar-daemon", false),
    localDaemonEntry("linux", "future-systemd-user-service-or-bundled-sidecar-daemon", false),
    {
      surface: "remoteDaemon",
      platform: "linux",
      artifact: "future-headless-daemon-archive",
      releaseStatus: "planned",
      signing: {
        requiredForProduction: true,
        notarizationRequired: false,
        unsignedAllowance: "dev-only"
      },
      update: manualUpdate("ssh-bootstrap", "remote-daemon-rebootstrap"),
      remoteBootstrap: {
        transport: "system-ssh-tunnel",
        protocol: "daemon-api-v1",
        installsGui: false,
        tokenBootstrap: "one-time-attach-token"
      },
      notes: ["Remote daemon bootstrap uses the same daemon API over a system SSH tunnel; it does not install a GUI remotely."]
    }
  ]
};

export function validateDistributionPolicy(policy: DistributionArchitecturePolicy): DistributionPolicyValidationResult {
  const errors: DistributionPolicyValidationError[] = [];
  requireSurface(policy, "desktopApp", errors);
  requireSurface(policy, "localDaemon", errors);
  requireSurface(policy, "remoteDaemon", errors);
  requireDesktopPlatform(policy, "macos", errors);
  requireDesktopPlatform(policy, "windows", errors);
  requireDesktopPlatform(policy, "linux", errors);
  requireLocalDaemonPlatform(policy, "macos", errors);
  requireLocalDaemonPlatform(policy, "windows", errors);
  requireLocalDaemonPlatform(policy, "linux", errors);

  for (const entry of policy.entries) {
    if (entry.releaseStatus === "shipped" && !entry.signing.requiredForProduction) {
      errors.push(error("unsigned_production", entry, "Production distribution cannot ship without signing policy."));
    }
    if (entry.releaseStatus === "shipped" && entry.signing.unsignedAllowance !== "never") {
      errors.push(error("unsigned_production", entry, "Unsigned artifacts are allowed only before production shipping."));
    }
    if (entry.platform === "macos" && entry.releaseStatus === "shipped" && !entry.signing.notarizationRequired) {
      errors.push(error("missing_macos_notarization", entry, "macOS production distribution requires notarization policy."));
    }
    if (entry.update.mode === "auto" && entry.update.shipped) {
      errors.push(error("unsupported_auto_update", entry, "Auto-update is not a shipped M2.5 capability."));
    }
    if (entry.update.mode === "manual" && !entry.update.requiresUserApproval) {
      errors.push(error("manual_update_without_user_approval", entry, "Manual updates must require explicit user approval."));
    }
    if (entry.update.mode === "manual" && entry.update.shipped) {
      errors.push(error("manual_update_marked_shipped", entry, "Manual update planning is not a shipped updater capability."));
    }
    if (entry.surface === "remoteDaemon") validateRemoteDaemonEntry(entry, errors);
  }

  return { ok: errors.length === 0, errors };
}

function desktopEntry(platform: DistributionPlatform, artifact: string, signing: SigningPolicy): DistributionPolicyEntry {
  return {
    surface: "desktopApp",
    platform,
    artifact,
    releaseStatus: "planned",
    signing,
    update: manualUpdate("source-checkout", "manual-redownload"),
    notes: ["Desktop installers and auto-update are planned architecture surfaces, not shipped capabilities."]
  };
}

function localDaemonEntry(platform: DistributionPlatform, artifact: string, notarizationRequired: boolean): DistributionPolicyEntry {
  return {
    surface: "localDaemon",
    platform,
    artifact,
    releaseStatus: "planned",
    signing: {
      requiredForProduction: true,
      notarizationRequired,
      unsignedAllowance: "dev-only"
    },
    update: manualUpdate("source-checkout", "manual-redownload"),
    notes: ["Local daemon update is distinct from desktop shell update even if packaged together."]
  };
}

function manualUpdate(transport: UpdateTransport, rollback: UpdatePolicy["rollback"]): UpdatePolicy {
  return {
    mode: "manual",
    shipped: false,
    transport,
    requiresUserApproval: true,
    rollback
  };
}

function validateRemoteDaemonEntry(
  entry: DistributionPolicyEntry,
  errors: DistributionPolicyValidationError[]
): void {
  if (
    entry.remoteBootstrap?.transport !== "system-ssh-tunnel" ||
    entry.remoteBootstrap.protocol !== "daemon-api-v1" ||
    entry.remoteBootstrap.installsGui !== false ||
    entry.remoteBootstrap.tokenBootstrap !== "one-time-attach-token"
  ) {
    errors.push(error("remote_daemon_bootstrap_drift", entry, "Remote daemon bootstrap must stay on system SSH tunnel plus daemon API v1."));
  }
  if (entry.update.transport !== "ssh-bootstrap" || entry.update.mode !== "manual") {
    errors.push(error("remote_daemon_update_drift", entry, "Remote daemon update is manual re-bootstrap over SSH in P07."));
  }
}

function requireSurface(
  policy: DistributionArchitecturePolicy,
  surface: DistributionSurface,
  errors: DistributionPolicyValidationError[]
): void {
  if (!policy.entries.some((entry) => entry.surface === surface)) {
    errors.push({ code: "missing_required_surface", surface, message: `Missing distribution surface: ${surface}` });
  }
}

function requireDesktopPlatform(
  policy: DistributionArchitecturePolicy,
  platform: DistributionPlatform,
  errors: DistributionPolicyValidationError[]
): void {
  if (!policy.entries.some((entry) => entry.surface === "desktopApp" && entry.platform === platform)) {
    errors.push({ code: "missing_desktop_platform", surface: "desktopApp", platform, message: `Missing desktop platform: ${platform}` });
  }
}

function requireLocalDaemonPlatform(
  policy: DistributionArchitecturePolicy,
  platform: DistributionPlatform,
  errors: DistributionPolicyValidationError[]
): void {
  if (!policy.entries.some((entry) => entry.surface === "localDaemon" && entry.platform === platform)) {
    errors.push({
      code: "missing_local_daemon_platform",
      surface: "localDaemon",
      platform,
      message: `Missing local daemon platform: ${platform}`
    });
  }
}

function error(
  code: DistributionPolicyErrorCode,
  entry: DistributionPolicyEntry,
  message: string
): DistributionPolicyValidationError {
  return { code, surface: entry.surface, platform: entry.platform, message };
}
