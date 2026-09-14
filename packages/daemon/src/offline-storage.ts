import path from "node:path";
import {
  createLedgerBackup,
  drillLedgerBackup,
  readOfflineLedgerEvents,
  restoreDrillRetentionFor,
  resolveActiveGeneration,
  runGenerationTwoConversion,
} from "../../kernel/src/index.ts";
import { generationMigrationCommand } from "./offline-storage-command.ts";

export function runOfflineStorageCommand(argv: readonly string[]): number {
  try {
    const generationOption = option(argv, "--generation");
    if (generationOption !== undefined && generationOption !== "1" && generationOption !== "2")
      throw new Error("--generation must be 1 or 2");
    const rootInput = option(argv, "--root") ?? process.cwd();
    const generation =
      generationOption === undefined ? resolveActiveGeneration({ rootInput }) : (Number(generationOption) as 1 | 2);
    const commandIndex = firstCommandIndex(argv);
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "ledger") {
      if (argv.includes("--help")) {
        emitReceipt({ ok: true, usage: generationMigrationCommand.usage, hint: generationMigrationCommand.help });
        return 0;
      }
      const flags = migrationFlags(argv.slice(commandIndex + 2));
      const result = runGenerationTwoConversion({
        backupDir: flags.source,
        mode: flags.mode,
        ...(flags.destination ? { destinationRoot: flags.destination } : {}),
      });
      const exitCode = result.plan.ready ? 0 : 1;
      emitReceipt({ ok: result.plan.ready, exitCode, schema: "generation-conversion-receipt/v1", ...result });
      return exitCode;
    }
    if (argv[0] === "backup") {
      const backupDir = positional(argv, 1, "backup requires an absolute destination directory"),
        manifest = createLedgerBackup({ rootInput, backupDir, generation });
      emitReceipt({ ok: true, schema: "ledger-backup-receipt/v1", exitCode: 0, backupDir, manifest });
      return 0;
    }
    if (argv[0] === "restore" && argv[1] === "--drill") {
      const backupDir = positional(argv, 2, "restore --drill requires a backup directory"),
        shadowParent = option(argv, "--shadow-parent") ?? path.join(rootInput, ".harness", "restore-drills"),
        result = drillLedgerBackup({ backupDir, shadowParent, retention: restoreDrillRetentionFor(rootInput) });
      emitReceipt({ ok: true, schema: "ledger-restore-drill-receipt/v1", exitCode: 0, ...result });
      return 0;
    }
    if (argv[0] === "events" && argv[1] === "tail") {
      const since = option(argv, "--since"),
        numeric = since === undefined ? undefined : Number(since),
        events = readOfflineLedgerEvents({
          rootInput,
          generation,
          ...(since !== undefined && Number.isSafeInteger(numeric) ? { sinceRevision: numeric } : {}),
          ...(since !== undefined && !Number.isSafeInteger(numeric) ? { sinceTime: since } : {}),
          ...(option(argv, "--grep") ? { grep: option(argv, "--grep") } : {}),
        });
      emitReceipt({ ok: true, schema: "offline-ledger-events/v1", exitCode: 0, events });
      return 0;
    }
    throw new Error("use ha backup <absolute-dir>, ha restore --drill <backup>, or ha events tail");
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
  };
}
