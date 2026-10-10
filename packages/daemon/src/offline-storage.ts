import { readFileSync } from "node:fs";
import path from "node:path";
import {
  readOfflineLedgerEvents,
  restoreLedgerBackup,
  resolveActiveGeneration,
  runCompletionGenerationConversion,
} from "@harness-anything/kernel";
import { canonicalRoot } from "./protocol/daemon-protocol-identifiers.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import { openReplicaAckStore } from "./fleet/replica-ack-store.ts";
import { invalidateReplicaCutsOffline } from "./fleet/replica-cut-store.ts";
import { generationMigrationCommand } from "./offline-storage-command.ts";

export async function runOfflineStorageCommand(argv: readonly string[]): Promise<number> {
  try {
    const generationOption = option(argv, "--generation");
    if (generationOption !== undefined && generationOption !== "1" && generationOption !== "2")
      throw new Error("--generation must be 1 or 2");
    const rootInput = option(argv, "--root") ?? process.cwd();
    const commandIndex = firstCommandIndex(argv);
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "ledger") {
      if (argv.includes("--help")) {
        emitReceipt({ ok: true, usage: generationMigrationCommand.usage, hint: generationMigrationCommand.help });
        return 0;
      }
      const flags = migrationFlags(argv.slice(commandIndex + 2));
      if (flags.mode === "activate" && !flags.fleetStateRoot)
        throw new Error("activation requires --fleet-state-root for the stopped center's copied replica state");
      const approvedSnapshotGaps = flags.snapshotGaps ? JSON.parse(readFileSync(flags.snapshotGaps, "utf8")) : [];
      if (
        !Array.isArray(approvedSnapshotGaps) ||
        approvedSnapshotGaps.some((value) => typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
      )
        throw new Error("--snapshot-gaps must contain the operator-approved JSON array of missing snapshot digests");
      const lock = flags.destination ? await acquireWorkspaceLock(canonicalRoot(flags.destination, true)) : null;
      let result;
      try {
        result = runCompletionGenerationConversion({
          backupDir: flags.source,
          mode: flags.mode,
          approvedSnapshotGaps: new Set<string>(approvedSnapshotGaps),
          ...(flags.destination ? { destinationRoot: flags.destination } : {}),
          invalidateDerivedState: (repoId, root) => {
            invalidateReplicaCutsOffline(path.join(root, ".harness"), repoId);
            const acknowledgements = openReplicaAckStore(flags.fleetStateRoot!);
            try {
              acknowledgements.invalidateOffline(repoId);
            } finally {
              acknowledgements.close();
            }
          },
        });
      } finally {
        await lock?.close();
      }
      const exitCode = result.plan.ready ? 0 : 1;
      emitReceipt({ ok: result.plan.ready, exitCode, schema: "generation-conversion-receipt/v1", ...result });
      return exitCode;
    }
    if (argv[commandIndex] === "restore") {
      const backupDir = positional(argv, commandIndex + 1, "restore requires a backup directory"),
        destinationRoot = option(argv, "--to");
      if (!destinationRoot) throw new Error("restore requires --to <absolute-directory>");
      const result = restoreLedgerBackup({ backupDir, destinationRoot }),
        registration = result.manifest.registration;
      emitReceipt({
        ok: true,
        schema: "ledger-restore-receipt/v1",
        exitCode: 0,
        ...backupReceipt(backupDir, result.manifest),
        restoredRoot: result.restoredRoot,
        registration,
        next:
          `ha --root ${JSON.stringify(result.restoredRoot)} init --repo-id ${registration?.repoId ?? "<repo-id>"} ` +
          "--person-id <owner-person-id> --display-name <owner-display-name>",
      });
      return 0;
    }
    if (argv[commandIndex] === "events" && argv[commandIndex + 1] === "tail") {
      const since = option(argv, "--since"),
        numeric = since === undefined ? undefined : Number(since),
        events = readOfflineLedgerEvents({
          rootInput,
          generation:
            generationOption === undefined
              ? resolveActiveGeneration({ rootInput })
              : (Number(generationOption) as 1 | 2),
          ...(since !== undefined && Number.isSafeInteger(numeric) ? { sinceRevision: numeric } : {}),
          ...(since !== undefined && !Number.isSafeInteger(numeric) ? { sinceTime: since } : {}),
          ...(option(argv, "--grep") ? { grep: option(argv, "--grep") } : {}),
        });
      emitReceipt({ ok: true, schema: "offline-ledger-events/v1", exitCode: 0, events });
      return 0;
    }
    throw new Error(
      "use ha backup <absolute-dir>, ha restore --drill <backup>, ha restore <backup> --to <absolute-dir>, or ha events tail",
    );
  } catch (error) {
    emitReceipt({
      ok: false,
      schema: "offline-storage-failure/v1",
      exitCode: 1,
      code: "offline_storage_failed",
      hint: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

function emitReceipt(receipt: Record<string, unknown>): void {
  console.log(JSON.stringify(receipt));
}
export function backupReceipt(
  backupDir: string,
  manifest: ReturnType<typeof import("@harness-anything/kernel").createLedgerBackup>,
): Record<string, unknown> {
  return {
    backupDir,
    manifestPath: path.join(backupDir, "manifest.json"),
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((total, file) => total + file.size, 0),
    sqlite: manifest.sqlite,
    accepted: manifest.accepted,
    registration: manifest.registration,
  };
}
function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function positional(argv: readonly string[], index: number, error: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(error);
  return value;
}
function firstCommandIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" || argv[index] === "--repo") index += 1;
    else if (!argv[index]?.startsWith("-")) return index;
  }
  return -1;
}
function migrationFlags(argv: readonly string[]): {
  readonly source: string;
  readonly mode: "dry-run" | "convert" | "verify" | "activate";
  readonly destination?: string;
  readonly fleetStateRoot?: string;
  readonly snapshotGaps?: string;
} {
  const inputs = new Set<string>(generationMigrationCommand.inputs.map((input) => input.name)),
    values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--json") continue;
    if (!inputs.has(name)) throw new Error(`Unknown input ${name}. Run ${generationMigrationCommand.helpCommand}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Add a value for ${name}.`);
    if (values.has(name)) throw new Error(`Provide ${name} only once.`);
    values.set(name, value);
    index += 1;
  }
  const source = values.get("--source"),
    mode = values.get("--mode");
  if (!source) throw new Error(`Add --source. Run ${generationMigrationCommand.helpCommand}.`);
  if (!mode) throw new Error(`Add --mode. Run ${generationMigrationCommand.helpCommand}.`);
  const modes = generationMigrationCommand.inputs.find((input) => input.name === "--mode")!.enum;
  if (!modes.includes(mode as (typeof modes)[number]))
    throw new Error("Use dry-run, convert, verify, or activate for --mode.");
  return {
    source,
    mode: mode as (typeof modes)[number],
    ...(values.has("--destination") ? { destination: values.get("--destination")! } : {}),
    ...(values.has("--fleet-state-root") ? { fleetStateRoot: values.get("--fleet-state-root")! } : {}),
    ...(values.has("--snapshot-gaps") ? { snapshotGaps: values.get("--snapshot-gaps")! } : {}),
  };
}
