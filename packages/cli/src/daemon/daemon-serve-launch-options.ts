import path from "node:path";
import type { ParsedDaemonLaunchArgv } from "./daemon-launch-spec.ts";

export function daemonRuntimeLayoutOverrides(
  rootDir: string,
  authoredRoot: string | undefined
): { readonly authoredRoot: string } | undefined {
  return authoredRoot === undefined ? undefined : {
    authoredRoot: path.relative(path.resolve(rootDir), authoredRoot) || "."
  };
}

export function daemonServeArgsWithResolvedOptions(
  args: ReadonlyArray<string>,
  options: ParsedDaemonLaunchArgv
): ReadonlyArray<string> {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["--authority-manifest", "--socket", "--user-root"].includes(args[index] ?? "")) {
      index += 1;
      continue;
    }
    normalized.push(args[index]!);
  }
  return [
    ...normalized,
    ...(options.socketPath ? ["--socket", options.socketPath] : []),
    ...(options.userRoot ? ["--user-root", options.userRoot] : []),
    ...(options.authorityManifest ? ["--authority-manifest", options.authorityManifest] : [])
  ];
}
