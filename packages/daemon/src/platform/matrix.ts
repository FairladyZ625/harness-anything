import type { PlatformAdapterDeclaration, PlatformCapabilityName } from "./types.ts";

const runtimeProbeCapabilities = [
  "exclusiveCreate",
  "fileFsync",
  "parentDirectoryFsync",
  "modeRoundTrip"
] as const satisfies ReadonlyArray<PlatformCapabilityName>;

const nativeAdapterCapabilities = [
  "atomicNoReplace",
  "atomicNamespaceExchange",
  "rootAnchoredResolution",
  "stableMountIdentity",
  "restrictiveStagingPolicy",
  "accessPolicyRoundTrip",
  "watcherOverflowFence",
  "bootIdentity"
] as const satisfies ReadonlyArray<PlatformCapabilityName>;

function capabilities(
  names: ReadonlyArray<PlatformCapabilityName>,
  source: "runtime-probe" | "native-adapter-probe"
) {
  return names.map((name) => ({ name, source })) as ReadonlyArray<{
    readonly name: PlatformCapabilityName;
    readonly source: "runtime-probe" | "native-adapter-probe";
  }>;
}

const linuxCapabilities = [
  ...capabilities(runtimeProbeCapabilities, "runtime-probe"),
  ...capabilities(nativeAdapterCapabilities, "native-adapter-probe")
];

export const platformQualificationMatrix = {
  "macos-apfs": {
    adapterId: "macos-apfs",
    platform: "macos",
    acceptedFileSystems: ["apfs"],
    rejectedFileSystems: ["nfs", "smbfs", "webdav", "autofs"],
    writableQualification: "implemented",
    requiredCapabilities: [
      ...linuxCapabilities,
      { name: "fullFsync", source: "native-adapter-probe" }
    ]
  },
  "linux-native": {
    adapterId: "linux-native",
    platform: "linux",
    acceptedFileSystems: ["ext4", "xfs"],
    rejectedFileSystems: ["overlay", "nfs", "nfs4", "cifs", "smb3", "fuse.sshfs", "drvfs"],
    writableQualification: "implemented",
    requiredCapabilities: linuxCapabilities
  },
  "wsl-linux": {
    adapterId: "wsl-linux",
    platform: "wsl",
    acceptedFileSystems: ["ext4", "xfs"],
    rejectedFileSystems: ["drvfs", "9p", "overlay", "nfs", "cifs", "fuse.sshfs"],
    reusesAdapter: "linux-native",
    writableQualification: "implemented",
    requiredCapabilities: linuxCapabilities
  },
  "windows-native": {
    adapterId: "windows-native",
    platform: "windows-native",
    acceptedFileSystems: ["ntfs", "refs"],
    rejectedFileSystems: [],
    writableQualification: "deferred",
    requiredCapabilities: capabilities(nativeAdapterCapabilities, "native-adapter-probe")
  }
} as const satisfies Record<string, PlatformAdapterDeclaration>;
