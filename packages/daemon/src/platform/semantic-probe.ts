import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CapabilityProbeResult, PlatformCapabilityName } from "./types.ts";

export type NativeSemanticProbe = (
  root: string,
  capabilities: ReadonlyArray<PlatformCapabilityName>
) => Promise<ReadonlyArray<CapabilityProbeResult>>;

function result(capability: PlatformCapabilityName, passed: boolean, detail: string): CapabilityProbeResult {
  return { capability, passed, detail };
}

export async function probePortableFileSemantics(root: string): Promise<ReadonlyArray<CapabilityProbeResult>> {
  const probeRoot = path.join(root, `.ha-platform-probe-${process.pid}-${Date.now().toString(36)}`);
  const file = path.join(probeRoot, "candidate");
  const results: CapabilityProbeResult[] = [];
  try {
    await mkdir(probeRoot, { mode: 0o700 });
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile("platform-probe\n");
      await handle.sync();
      results.push(result("fileFsync", true, "file fsync succeeded"));
    } finally {
      await handle.close();
    }
    let existingCreateRejected = false;
    try {
      const duplicateHandle = await open(file, "wx", 0o600);
      await duplicateHandle.close();
    } catch {
      existingCreateRejected = true;
    }
    results.push(result("exclusiveCreate", existingCreateRejected, "exclusive sibling create rejected an existing leaf"));
    await chmod(file, 0o700);
    const mode = (await stat(file)).mode & 0o777;
    results.push(result("modeRoundTrip", mode === 0o700, `observed mode ${mode.toString(8)}`));
    const directory = await open(probeRoot, "r");
    try {
      await directory.sync();
      results.push(result("parentDirectoryFsync", true, "directory fsync succeeded"));
    } finally {
      await directory.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const capability of ["exclusiveCreate", "fileFsync", "modeRoundTrip", "parentDirectoryFsync"] as const) {
      if (!results.some((entry) => entry.capability === capability)) results.push(result(capability, false, detail));
    }
  } finally {
    try {
      await rm(probeRoot, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push(result("restrictiveStagingPolicy", false, `probe cleanup failed: ${detail}`));
    }
  }
  return results;
}

export function unboundNativeSemanticProbes(capabilities: ReadonlyArray<PlatformCapabilityName>): ReadonlyArray<CapabilityProbeResult> {
  return capabilities.map((capability) => result(
    capability,
    false,
    "native adapter semantic probe is not bound; capability is not inferred from the OS name"
  ));
}
