import os from "node:os";
import path from "node:path";
import {
  exportCenterRelocation,
  importCenterRelocation,
  retireCenter,
} from "../../storage/src/center-relocation.ts";

export async function runCenterRelocationCommand(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json"),
    operation = argv[2];
  try {
    if (operation === "export") return await runExport(argv, json);
    if (operation === "import") return runImport(argv, json);
    if (operation === "retire") return runRetire(argv, json);
    return emitFailure(json, "invalid_field", "Use ha fleet center export|import|retire with the operation flags.");
  } catch (error) {
    return emitFailure(json, "relocation_failed", error instanceof Error ? error.message : String(error));
  }
}

async function runExport(argv: readonly string[], json: boolean): Promise<number> {
  const root = required(argv, "--root"),
    bundle = required(argv, "--bundle"),
    repoId = required(argv, "--repo"),
    writerEpoch = integer(argv, "--writer-epoch"),
    slots = optional(argv, "--slots"),
    result = await exportCenterRelocation({
      rootInput: path.resolve(root),
      bundleDir: path.resolve(bundle),
      repoId,
      writerEpoch,
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
    });
  return emit(
    json,
    {
      schema: "command-receipt/v2",
      ok: true,
      command: "fleet-center-export",
      outcome: "applied",
      manifest: result.manifest,
      bundleDir: path.resolve(bundle),
      nextAction: "Run ha fleet center retire after the final edge acknowledgement, then import on the new center.",
    },
  );
}

function runImport(argv: readonly string[], json: boolean): number {
  const bundle = required(argv, "--bundle"),
    destination = required(argv, "--destination"),
    userRoot = optional(argv, "--user-root") ?? path.join(os.homedir(), ".harness"),
    stateRoot = optional(argv, "--state-root") ?? path.join(userRoot, "fleet"),
    slots = optional(argv, "--slots"),
    result = importCenterRelocation({
      bundleDir: path.resolve(bundle),
      destinationRoot: path.resolve(destination),
      stateRoot: path.resolve(stateRoot),
      ...(slots ? { replicationSlotsPath: path.resolve(slots) } : {}),
      ...(optional(argv, "--repo") ? { expectedRepoId: optional(argv, "--repo") } : {}),
    });
  return emit(
    json,
    {
      schema: "command-receipt/v2",
      ok: true,
      command: "fleet-center-import",
      outcome: "applied",
      repoId: result.manifest.repoId,
      finalRevision: result.manifest.finalRevision,
      tipHash: result.manifest.tipHash,
      oldEpoch: result.manifest.writerEpoch,
      newEpoch: result.newEpoch,
      restoredRoot: result.restoredRoot,
      nextAction: `Run ha edge repoint --external-url <new-url> --login-url <new-login-url> --epoch ${result.newEpoch}.`,
    },
  );
}

function runRetire(argv: readonly string[], json: boolean): number {
  const userRoot = optional(argv, "--user-root") ?? path.join(os.homedir(), ".harness"),
    tombstone = retireCenter({
      userRoot,
      repoId: required(argv, "--repo"),
      oldEpoch: integer(argv, "--old-epoch"),
      finalRevision: integer(argv, "--final-revision"),
      tipHash: required(argv, "--tip-hash"),
      newExternalUrl: required(argv, "--new-external-url"),
      newLoginUrl: required(argv, "--new-login-url"),
      spkiSha256: required(argv, "--spki-sha256"),
    });
  return emit(
    json,
    {
      schema: "command-receipt/v2",
      ok: true,
      command: "fleet-center-retire",
      outcome: "applied",
      tombstone,
      nextAction: `Old-center writes are fenced. Run ha edge repoint --external-url ${tombstone.newExternalUrl}.`,
    },
  );
}

function required(argv: readonly string[], flag: string): string {
  const value = optional(argv, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function integer(argv: readonly string[], flag: string): number {
  const value = Number(required(argv, flag));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a nonnegative safe integer`);
  return value;
}

function optional(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function emit(json: boolean, receipt: Record<string, unknown>): number {
  if (json) console.log(JSON.stringify(receipt));
  else console.log(String(receipt.summary ?? receipt.nextAction ?? receipt.command));
  return 0;
}

function emitFailure(json: boolean, code: string, hint: string): number {
  return emit(json, {
    schema: "command-receipt/v2",
    ok: false,
    outcome: "op_rejected",
    code,
    error: { code, hint },
  });
}
