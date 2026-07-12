export const platformCapabilityNames = [
  "exclusiveCreate",
  "fileFsync",
  "parentDirectoryFsync",
  "modeRoundTrip",
  "atomicNoReplace",
  "atomicNamespaceExchange",
  "rootAnchoredResolution",
  "stableMountIdentity",
  "restrictiveStagingPolicy",
  "accessPolicyRoundTrip",
  "watcherOverflowFence",
  "bootIdentity",
  "fullFsync"
] as const;

export type PlatformCapabilityName = typeof platformCapabilityNames[number];
export type PlatformAdapterId = "macos-apfs" | "linux-native" | "wsl-linux" | "windows-native";
export type PlatformKind = "macos" | "linux" | "wsl" | "windows-native";
export type WritableQualification = "implemented" | "deferred";

export interface PlatformCapabilityDeclaration {
  readonly name: PlatformCapabilityName;
  readonly source: "runtime-probe" | "native-adapter-probe";
}

export interface PlatformAdapterDeclaration {
  readonly adapterId: PlatformAdapterId;
  readonly platform: PlatformKind;
  readonly acceptedFileSystems: ReadonlyArray<string>;
  readonly rejectedFileSystems: ReadonlyArray<string>;
  readonly reusesAdapter?: PlatformAdapterId;
  readonly writableQualification: WritableQualification;
  readonly requiredCapabilities: ReadonlyArray<PlatformCapabilityDeclaration>;
}

export interface MountObservation {
  readonly mountPoint: string;
  readonly fileSystemType: string;
  readonly source: string;
  readonly options: ReadonlyArray<string>;
}

export interface CapabilityProbeResult {
  readonly capability: PlatformCapabilityName;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PlatformRuntimeObservation {
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: PlatformKind;
  readonly isWsl: boolean;
  readonly wslDistroName?: string;
  readonly mount: MountObservation;
  readonly capabilities: ReadonlyArray<CapabilityProbeResult>;
}

export const platformQualificationExitCodes = {
  UNSUPPORTED_PLATFORM: 70,
  UNSUPPORTED_FILESYSTEM: 71,
  DRVFS_WRITABLE_VIEW_REJECTED: 72,
  REQUIRED_SEMANTIC_PROBE_FAILED: 73,
  METADATA_POLICY_UNRESOLVED: 74,
  WINDOWS_NATIVE_WRITABLE_DEFERRED: 75,
  UNSUPPORTED_MOUNT_OPTIONS: 76,
  MOUNT_OBSERVATION_FAILED: 77
} as const;

export type PlatformQualificationExitSymbol = keyof typeof platformQualificationExitCodes;

export interface PlatformQualificationFailure {
  readonly symbol: PlatformQualificationExitSymbol;
  readonly code: typeof platformQualificationExitCodes[PlatformQualificationExitSymbol];
  readonly reason: string;
}

export type PlatformQualificationResult =
  | {
    readonly mode: "WRITABLE";
    readonly adapter: PlatformAdapterDeclaration;
    readonly observation: PlatformRuntimeObservation;
  }
  | {
    readonly mode: "REJECTED";
    readonly adapter?: PlatformAdapterDeclaration;
    readonly observation: PlatformRuntimeObservation;
    readonly failures: ReadonlyArray<PlatformQualificationFailure>;
  };
