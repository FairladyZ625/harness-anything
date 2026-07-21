import path from "node:path";
import { daemonUserRoot } from "@harness-anything/daemon";
import { readOption } from "../../cli/parse-options.ts";
import type { DaemonCommandInput } from "./command-types.ts";
import { runDaemonControl } from "./control.ts";
import { installDaemonSnapshot, type InstalledDaemonSnapshot } from "./snapshot.ts";

export function installSnapshotCommand(
  input: DaemonCommandInput,
  sourceEntrypoint: () => string
): Record<string, unknown> {
  const subcommand = input.args[2] ?? "install";
  if (subcommand !== "install") throw new Error("Use ha daemon snapshot install [--ref <git-ref>] [--version <version>].");
  return snapshotResult(installSnapshotForCommand(input, sourceEntrypoint));
}

export async function upgradeDaemonSnapshot(
  input: DaemonCommandInput,
  sourceEntrypoint: () => string
): Promise<Record<string, unknown>> {
  const snapshot = installSnapshotForCommand(input, sourceEntrypoint);
  const result = await runDaemonControl({
    ...input,
    daemonEntryPath: sourceEntrypoint,
    replacementEntrypoint: snapshot.entrypoint
  }, "refresh");
  return { snapshot: snapshotResult(snapshot), ...result };
}

function installSnapshotForCommand(
  input: DaemonCommandInput,
  sourceEntrypoint: () => string
): InstalledDaemonSnapshot {
  const installer = input.installDaemonSnapshot ?? installDaemonSnapshot;
  const ref = readOption(input.args, "--ref");
  const version = readOption(input.args, "--version");
  return installer({
    sourceEntrypoint: (input.daemonSourceEntrypoint ?? sourceEntrypoint)(),
    userRoot: path.resolve(readDaemonUserRootOption(input.args) ?? daemonUserRoot()),
    ...(ref ? { ref } : {}),
    ...(version ? { version } : {})
  });
}

function snapshotResult(snapshot: InstalledDaemonSnapshot): Record<string, unknown> {
  return {
    installed: snapshot.installed,
    snapshotDir: snapshot.snapshotDir,
    entrypoint: snapshot.entrypoint,
    manifestPath: snapshot.manifestPath,
    manifest: snapshot.manifest
  };
}

function readDaemonUserRootOption(args: ReadonlyArray<string>): string | undefined {
  return readOption(args, "--user-root") ?? process.env.HARNESS_DAEMON_USER_ROOT;
}
