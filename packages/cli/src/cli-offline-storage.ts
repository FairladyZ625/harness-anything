import path from "node:path";
// dec_4944EEC7EE3618CEFDD210DC6B/CH1 requires this named offline-maintenance edge
// instead of the kernel public barrel; G30 pins its exact transitive runtime closure.
// eslint-disable-next-line no-restricted-imports
import {
  createLedgerBackup,
  drillLedgerBackup,
  readOfflineLedgerEvents,
  resolveActiveGeneration,
  runGenerationTwoConversion,
} from "../../kernel/src/store/ledger-backup.ts";

import { generationMigrationCommand, firstCliCommandIndex } from "./cli/thin-command-help.ts";
import { readFlags } from "./cli/thin-command-flags.ts";

type Emit = (receipt: Record<string, unknown>, json: boolean) => void;

export function runOfflineStorageCommand(argv: readonly string[], emit: Emit): number {
  const json = argv.includes("--json"),
    rootInput = option(argv, "--root") ?? process.cwd();
  try {
    const generationOption = option(argv, "--generation");
    if (generationOption !== undefined && generationOption !== "1" && generationOption !== "2")
      throw new Error("--generation must be 1 or 2");
    // Offline commands follow the same activation certificate the daemon writer and reader follow.
    // An explicit --generation still reads the retained one so the old ledger stays auditable.
    const generation =
      generationOption === undefined ? resolveActiveGeneration({ rootInput }) : (Number(generationOption) as 1 | 2);
    const commandIndex = firstCliCommandIndex(argv);
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "ledger") {
      if (argv.includes("--help")) {
        emit({ ok: true, usage: generationMigrationCommand.usage, hint: generationMigrationCommand.help }, json);
        return 0;
      }
      const tokens = argv.slice(commandIndex + 2).filter((token) => token !== "--json"),
        flags = readFlags(
          generationMigrationCommand.id,
          tokens,
          new Map([[generationMigrationCommand.id, generationMigrationCommand]]),
        );
      if (!flags.ok) throw new Error(flags.nextAction);
      const result = runGenerationTwoConversion({
        backupDir: flags.one.get("--source")!,
        mode: flags.one.get("--mode")! as "dry-run" | "convert" | "verify" | "activate",
        ...(flags.one.has("--destination") ? { destinationRoot: flags.one.get("--destination")! } : {}),
      });
      const exitCode = result.plan.ready ? 0 : 1;
      emit({ ok: result.plan.ready, exitCode, schema: "generation-conversion-receipt/v1", ...result }, json);
      return exitCode;
    }
    if (argv[0] === "backup") {
      const backupDir = positional(argv, 1, "backup requires an absolute destination directory"),
        manifest = createLedgerBackup({ rootInput, backupDir, generation });
      emit({ ok: true, schema: "ledger-backup-receipt/v1", exitCode: 0, backupDir, manifest }, json);
      return 0;
    }
    if (argv[0] === "restore" && argv[1] === "--drill") {
      const backupDir = positional(argv, 2, "restore --drill requires a backup directory"),
        shadowParent = option(argv, "--shadow-parent") ?? path.join(rootInput, ".harness", "restore-drills"),
        result = drillLedgerBackup({ backupDir, shadowParent });
      emit({ ok: true, schema: "ledger-restore-drill-receipt/v1", exitCode: 0, ...result }, json);
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
      if (json) emit({ ok: true, schema: "offline-ledger-events/v1", exitCode: 0, events }, true);
      else for (const event of events) console.log(JSON.stringify(event));
      return 0;
    }
    throw new Error("use ha backup <absolute-dir>, ha restore --drill <backup>, or ha events tail");
  } catch (error) {
    emit(
      {
        ok: false,
        schema: "offline-storage-failure/v1",
        exitCode: 1,
        code: "offline_storage_failed",
        hint: message(error),
      },
      json,
    );
    return 1;
  }
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
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
