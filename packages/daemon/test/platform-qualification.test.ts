// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveWslViewId,
  detectWsl,
  metadataPolicyFields,
  parseLinuxMountInfo,
  platformCapabilityNames,
  platformQualificationMatrix,
  qualifyWritablePlatform,
  selectMountForPath,
  validatePlatformMetadataPolicy,
  type CapabilityProbeResult,
  type PlatformKind,
  type PlatformMetadataPolicy
} from "../src/index.ts";

function resolvedPolicy(platform: PlatformKind): PlatformMetadataPolicy {
  return {
    version: "test-policy/v1",
    platform,
    fields: Object.fromEntries(metadataPolicyFields[platform].map((field) => [field, { disposition: "required" }]))
  };
}

function passed(capabilities: ReadonlyArray<string> = platformCapabilityNames): ReadonlyArray<CapabilityProbeResult> {
  return capabilities.map((capability) => ({
    capability: capability as CapabilityProbeResult["capability"],
    passed: true,
    detail: "synthetic qualified primitive"
  }));
}

test("platform matrix declares APFS, ext4/XFS, WSL Linux reuse, and a deferred Windows-native gate", () => {
  assert.deepEqual(platformQualificationMatrix["macos-apfs"].acceptedFileSystems, ["apfs"]);
  assert.deepEqual(platformQualificationMatrix["linux-native"].acceptedFileSystems, ["ext4", "xfs"]);
  assert.equal(platformQualificationMatrix["wsl-linux"].reusesAdapter, "linux-native");
  assert.ok(platformQualificationMatrix["wsl-linux"].rejectedFileSystems.includes("drvfs"));
  assert.equal(platformQualificationMatrix["windows-native"].writableQualification, "deferred");
});

test("L-14 metadata policy fails closed until every declared field has an explicit disposition", () => {
  const incomplete = validatePlatformMetadataPolicy({
    version: "draft",
    platform: "macos",
    fields: { "ownership.uid-gid": { disposition: "required" }, unexpected: { disposition: "forbidden" } }
  });
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missingFields.includes("acl.entries-inheritance"));
  assert.deepEqual(incomplete.unknownFields, ["unexpected"]);
  assert.equal(validatePlatformMetadataPolicy(resolvedPolicy("linux")).complete, true);
});

test("Linux mountinfo parsing selects the deepest mount and preserves DrvFs semantics", () => {
  const mounts = parseLinuxMountInfo([
    "40 30 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
    "41 40 0:50 / /mnt/c rw,noatime - drvfs C:\\134 rw,case=off"
  ].join("\n"));
  assert.equal(selectMountForPath("/home/me/work", mounts)?.fileSystemType, "ext4");
  assert.deepEqual(selectMountForPath("/mnt/c/repo", mounts), {
    mountPoint: "/mnt/c",
    fileSystemType: "drvfs",
    source: "C:\\",
    options: ["rw", "noatime"]
  });
});

test("WSL detection derives a stable domain-separated view ID", () => {
  assert.deepEqual(detectWsl({
    hostPlatform: "linux",
    osRelease: "6.6.87.2-microsoft-standard-WSL2",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" }
  }), { isWsl: true, distroName: "Ubuntu-24.04" });
  const wslId = deriveWslViewId({
    workspaceId: "workspace-1",
    distroName: "Ubuntu-24.04",
    linuxMachineId: "machine-a"
  });
  assert.match(wslId, /^view_wsl_[0-9a-f]{32}$/u);
  assert.equal(wslId, deriveWslViewId({
    workspaceId: "workspace-1",
    distroName: "Ubuntu-24.04",
    linuxMachineId: "machine-a"
  }));
  assert.notEqual(wslId, deriveWslViewId({
    workspaceId: "workspace-1",
    distroName: "Ubuntu-24.04",
    linuxMachineId: "windows-host-identity"
  }));
});

test("WSL /mnt/c is rejected with a named exit and never downgraded", async () => {
  const result = await qualifyWritablePlatform({
    root: "/mnt/c/repo",
    hostPlatform: "linux",
    osRelease: "microsoft-standard-WSL2",
    procVersion: "Microsoft",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    mount: { source: "C:\\", mountPoint: "/mnt/c", fileSystemType: "DrvFs", options: ["rw"] },
    metadataPolicy: resolvedPolicy("wsl"),
    portableProbe: async () => passed(),
    nativeProbe: async (_root, capabilities) => passed(capabilities)
  });
  assert.equal(result.mode, "REJECTED");
  if (result.mode === "REJECTED") {
    assert.equal(result.failures.some((entry) => entry.symbol === "DRVFS_WRITABLE_VIEW_REJECTED" && entry.code === 72), true);
    assert.equal("readOnly" in result, false);
  }
});

test("a fully proven WSL ext4 view reuses the Linux adapter and is writable", async () => {
  const result = await qualifyWritablePlatform({
    root: "/home/me/repo",
    hostPlatform: "linux",
    osRelease: "microsoft-standard-WSL2",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    mount: { source: "/dev/sdc", mountPoint: "/", fileSystemType: "ext4", options: ["rw"] },
    metadataPolicy: resolvedPolicy("wsl"),
    portableProbe: async () => passed(),
    nativeProbe: async (_root, capabilities) => passed(capabilities)
  });
  assert.equal(result.mode, "WRITABLE");
  assert.equal(result.adapter.adapterId, "wsl-linux");
  assert.equal(result.adapter.reusesAdapter, "linux-native");
});

test("native Windows remains an explicit deferred qualification gate", async () => {
  const result = await qualifyWritablePlatform({
    root: "C:\\repo",
    hostPlatform: "win32",
    mount: { source: "C:", mountPoint: "C:\\", fileSystemType: "ntfs", options: ["rw"] },
    metadataPolicy: resolvedPolicy("windows-native"),
    portableProbe: async () => passed(),
    nativeProbe: async (_root, capabilities) => passed(capabilities)
  });
  assert.equal(result.mode, "REJECTED");
  if (result.mode === "REJECTED") {
    assert.equal(result.failures.some((entry) => entry.symbol === "WINDOWS_NATIVE_WRITABLE_DEFERRED"), true);
  }
});

test("read-only, noexec, and noowners mounts fail rather than becoming partial views", async () => {
  const result = await qualifyWritablePlatform({
    root: "/workspace",
    hostPlatform: "linux",
    osRelease: "generic-linux",
    env: {},
    mount: { source: "/dev/sda1", mountPoint: "/", fileSystemType: "ext4", options: ["rw", "noexec"] },
    metadataPolicy: resolvedPolicy("linux"),
    portableProbe: async () => passed(),
    nativeProbe: async (_root, capabilities) => passed(capabilities)
  });
  assert.equal(result.mode, "REJECTED");
  if (result.mode === "REJECTED") {
    assert.equal(result.failures.some((entry) => entry.symbol === "UNSUPPORTED_MOUNT_OPTIONS" && entry.code === 76), true);
  }
});

test("mount and semantic probe exceptions become named rejections", async () => {
  const result = await qualifyWritablePlatform({
    root: "/missing",
    hostPlatform: "linux",
    osRelease: "generic-linux",
    env: {},
    metadataPolicy: resolvedPolicy("linux"),
    portableProbe: async () => { throw new Error("portable probe unavailable"); },
    nativeProbe: async () => { throw new Error("native probe unavailable"); }
  });
  assert.equal(result.mode, "REJECTED");
  if (result.mode === "REJECTED") {
    assert.equal(result.failures.some((entry) => entry.symbol === "MOUNT_OBSERVATION_FAILED" && entry.code === 77), true);
    assert.equal(result.failures.some((entry) => entry.symbol === "REQUIRED_SEMANTIC_PROBE_FAILED"), true);
  }
});

test("macOS real-volume probe identifies local APFS and reports unresolved native/L-14 gates honestly", {
  skip: process.platform !== "darwin"
}, async () => {
  const result = await qualifyWritablePlatform({ root: process.cwd() });
  assert.equal(result.observation.platform, "macos");
  assert.equal(result.observation.mount.fileSystemType, "apfs");
  assert.equal(result.observation.capabilities.some((entry) => entry.capability === "fileFsync" && entry.passed), true);
  assert.equal(result.mode, "REJECTED");
  if (result.mode === "REJECTED") {
    assert.equal(result.failures.some((entry) => entry.symbol === "METADATA_POLICY_UNRESOLVED"), true);
    assert.equal(result.failures.some((entry) => entry.symbol === "REQUIRED_SEMANTIC_PROBE_FAILED"), true);
  }
});
