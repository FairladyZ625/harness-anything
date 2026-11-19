import os from "node:os";
import path from "node:path";
import { exportCenterRelocation, importCenterRelocation, retireCenter } from "@harness-anything/storage";

export interface FleetCenterRelocationOutcome {
  readonly receipt: Record<string, unknown>;
  readonly exitCode: number;
}

export async function relocateFleetCenter(
  argv: readonly string[],
  defaultUserRoot: string = path.join(os.homedir(), ".harness"),
): Promise<FleetCenterRelocationOutcome> {
  const centerIndex = argv.indexOf("center"),
    operation = centerIndex < 0 ? undefined : argv[centerIndex + 1];
  if (operation === "export") return await exportBundle(argv);
  if (operation === "import") return importBundle(argv, defaultUserRoot);
  if (operation === "retire") return retireOldCenter(argv, defaultUserRoot);
  return failureOutcome(
    "fleet-center",
    "unsupported_command",
    "Use ha fleet center export|import|retire with the operation flags.",
  );
}

async function exportBundle(argv: readonly string[]): Promise<FleetCenterRelocationOutcome> {
  const missing = missingFlags(argv, ["--root", "--bundle", "--repo", "--writer-epoch"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-export",
      "missing_field",
      `Add ${missing.join(" ")} to export the center bundle.`,
    );
  const writerEpoch = nonnegativeIntFlag(argv, "--writer-epoch");
  if (writerEpoch === null || writerEpoch < 1)
    return failureOutcome("fleet-center-export", "invalid_field", "--writer-epoch must be a positive safe integer.");
  const root = flagValue(argv, "--root")!,
    bundle = flagValue(argv, "--bundle")!,
    repoId = flagValue(argv, "--repo")!,
    slots = flagValue(argv, "--slots"),
    exported = await exportCenterRelocation({
      rootInput: path.resolve(root),
      bundleDir: path.resolve(bundle),
      repoId,
      writerEpoch,
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
    });
  return appliedOutcome({
    command: "fleet-center-export",
    manifest: exported.manifest,
    bundleDir: path.resolve(bundle),
    summary: `fleet-center-export: exported ${repoId} at revision ${String(exported.manifest.finalRevision)}`,
    nextAction: "Run ha fleet center retire after the final edge acknowledgement, then import on the new center.",
  });
}

function importBundle(argv: readonly string[], defaultUserRoot: string): FleetCenterRelocationOutcome {
  const missing = missingFlags(argv, ["--bundle", "--destination"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-import",
      "missing_field",
      `Add ${missing.join(" ")} to import the center bundle.`,
    );
  const bundle = flagValue(argv, "--bundle")!,
    destination = flagValue(argv, "--destination")!,
    userRoot = flagValue(argv, "--user-root") ?? defaultUserRoot,
    stateRoot = flagValue(argv, "--state-root") ?? path.join(userRoot, "fleet"),
    slots = flagValue(argv, "--slots"),
    expectedRepoId = flagValue(argv, "--repo"),
    imported = importCenterRelocation({
      bundleDir: path.resolve(bundle),
      destinationRoot: path.resolve(destination),
      stateRoot: path.resolve(stateRoot),
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
      ...(expectedRepoId ? { expectedRepoId } : {}),
    });
  return appliedOutcome({
    command: "fleet-center-import",
    repoId: imported.manifest.repoId,
    finalRevision: imported.manifest.finalRevision,
    tipHash: imported.manifest.tipHash,
    oldEpoch: imported.manifest.writerEpoch,
    newEpoch: imported.newEpoch,
    restoredRoot: imported.restoredRoot,
    summary: `fleet-center-import: restored ${imported.manifest.repoId} at epoch ${String(imported.newEpoch)}`,
    nextAction: `Run ha edge repoint --external-url <new-url> --login-url <new-login-url> --epoch ${String(imported.newEpoch)}.`,
  });
}

function retireOldCenter(argv: readonly string[], defaultUserRoot: string): FleetCenterRelocationOutcome {
  const missing = missingFlags(argv, [
    "--repo",
    "--old-epoch",
    "--final-revision",
    "--tip-hash",
    "--new-external-url",
    "--new-login-url",
    "--spki-sha256",
  ]);
  if (missing.length > 0)
    return failureOutcome("fleet-center-retire", "missing_field", `Add ${missing.join(" ")} to retire the old center.`);
  const oldEpoch = nonnegativeIntFlag(argv, "--old-epoch"),
    finalRevision = nonnegativeIntFlag(argv, "--final-revision");
  if (oldEpoch === null || oldEpoch < 1 || finalRevision === null)
    return failureOutcome(
      "fleet-center-retire",
      "invalid_field",
      "--old-epoch must be positive and --final-revision must be a nonnegative safe integer.",
    );
  const userRoot = flagValue(argv, "--user-root") ?? defaultUserRoot,
    tombstone = retireCenter({
      userRoot,
      repoId: flagValue(argv, "--repo")!,
      oldEpoch,
      finalRevision,
      tipHash: flagValue(argv, "--tip-hash")!,
      newExternalUrl: flagValue(argv, "--new-external-url")!,
      newLoginUrl: flagValue(argv, "--new-login-url")!,
      spkiSha256: flagValue(argv, "--spki-sha256")!,
    });
  return appliedOutcome({
    command: "fleet-center-retire",
    tombstone,
    summary: `fleet-center-retire: fenced ${tombstone.repoId} epoch ${String(tombstone.oldEpoch)} -> ${String(tombstone.newEpoch)}`,
    nextAction: `Old-center writes are fenced. Run ha edge repoint --external-url ${tombstone.newExternalUrl}.`,
  });
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag),
    value = index < 0 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function missingFlags(argv: readonly string[], flags: readonly string[]): readonly string[] {
  return flags.filter((flag) => flagValue(argv, flag) === undefined);
}

function nonnegativeIntFlag(argv: readonly string[], flag: string): number | null {
  const raw = flagValue(argv, flag);
  if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function appliedOutcome(receipt: Record<string, unknown>): FleetCenterRelocationOutcome {
  return {
    receipt: { schema: "command-receipt/v2", ok: true, outcome: "applied", ...receipt },
    exitCode: 0,
  };
}

function failureOutcome(command: string, code: string, hint: string): FleetCenterRelocationOutcome {
  return {
    receipt: {
      schema: "command-receipt/v2",
      ok: false,
      command,
      outcome: "op_rejected",
      code,
      error: { code, hint },
    },
    exitCode: code === "missing_field" ? 2 : 2,
  };
}
