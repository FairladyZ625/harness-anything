import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { MountObservation } from "./types.ts";

function unescapeMountField(value: string): string {
  return value.replace(/\\040/gu, " ").replace(/\\011/gu, "\t").replace(/\\012/gu, "\n").replace(/\\134/gu, "\\");
}

export function parseLinuxMountInfo(source: string): ReadonlyArray<MountObservation> {
  const mounts: MountObservation[] = [];
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    if (before.length < 6 || after.length < 2) continue;
    mounts.push({
      mountPoint: unescapeMountField(before[4]!),
      fileSystemType: after[0]!.toLowerCase(),
      source: unescapeMountField(after[1]!),
      options: before[5]!.split(",")
    });
  }
  return mounts;
}

export function parseDarwinMountOutput(source: string): ReadonlyArray<MountObservation> {
  const mounts: MountObservation[] = [];
  for (const line of source.split("\n")) {
    const match = /^(.*?) on (.*?) \(([^,()]+)(?:, ([^()]+))?\)$/u.exec(line);
    if (match === null) continue;
    mounts.push({
      source: match[1]!,
      mountPoint: match[2]!,
      fileSystemType: match[3]!.toLowerCase(),
      options: match[4]?.split(", ") ?? []
    });
  }
  return mounts;
}

export function selectMountForPath(root: string, mounts: ReadonlyArray<MountObservation>): MountObservation | undefined {
  const normalizedRoot = path.resolve(root);
  return [...mounts]
    .filter((mount) => {
      if (normalizedRoot === mount.mountPoint) return true;
      const prefix = mount.mountPoint.endsWith(path.sep) ? mount.mountPoint : `${mount.mountPoint}${path.sep}`;
      return normalizedRoot.startsWith(prefix);
    })
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

function dfMount(root: string): { readonly source: string; readonly mountPoint: string } {
  const lines = execFileSync("df", ["-P", root], { encoding: "utf8" }).trim().split("\n");
  const columns = lines.at(-1)?.trim().split(/\s+/u) ?? [];
  if (columns.length < 6) throw new Error(`Unable to determine mount point for ${root}`);
  return { source: columns[0]!, mountPoint: columns.slice(5).join(" ") };
}

export function observeRuntimeMount(root: string, hostPlatform: NodeJS.Platform = process.platform): MountObservation {
  const realRoot = realpathSync(root);
  if (hostPlatform === "linux") {
    const mountInfo = execFileSync("cat", ["/proc/self/mountinfo"], { encoding: "utf8" });
    const selected = selectMountForPath(realRoot, parseLinuxMountInfo(mountInfo));
    if (selected === undefined) throw new Error(`No Linux mount contains ${realRoot}`);
    return selected;
  }
  if (hostPlatform === "darwin") {
    const target = dfMount(realRoot);
    const mounts = parseDarwinMountOutput(execFileSync("mount", [], { encoding: "utf8" }));
    const selected = mounts.find((mount) => mount.source === target.source || mount.mountPoint === target.mountPoint);
    if (selected === undefined) throw new Error(`No macOS mount matches ${target.mountPoint}`);
    return selected;
  }
  return { source: "unknown", mountPoint: path.parse(realRoot).root, fileSystemType: "unknown", options: [] };
}
