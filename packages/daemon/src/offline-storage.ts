import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  readOfflineLedgerEvents,
  restoreLedgerBackup,
  resolveActiveGeneration,
  runCompletionGenerationConversion,
} from "@harness-anything/kernel";
import { canonicalRoot } from "./protocol/daemon-protocol-identifiers.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import { openReplicationSlots } from "./fleet/replication-slot.ts";
import {
  agentDeclarationMigrationCommand,
  completionMigrationCommand,
  generationMigrationCommand,
  writerEpochMigrationCommand,
} from "./offline-storage-command.ts";
import { migrateAgentDeclarations } from "./agent-declaration-migration.ts";
import { migrateCompletion } from "@harness-anything/preset/internal/preset-resolver";
import { daemonUserRoot } from "./client/local-daemon-target.ts";
import { daemonProcessAlive } from "./daemon-singleton.ts";
import { migrateLegacyWriterEpochDatabase, WriterEpochError } from "./writer-epoch.ts";

export async function runOfflineStorageCommand(argv: readonly string[]): Promise<number> {
  try {
    const generationOption = option(argv, "--generation");
    if (generationOption !== undefined && generationOption !== "1" && generationOption !== "2")
      throw new Error("--generation must be 1 or 2");
    const rootInput = option(argv, "--root") ?? process.cwd();
    const commandIndex = firstCommandIndex(argv);
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "writer-epoch") {
      try {
        const trailing = argv.slice(commandIndex + 2).filter((argument) => argument !== "--json");
        if (trailing.some((argument) => argument !== "--help"))
          throw new Error("ha migrate writer-epoch does not accept arguments; run ha migrate writer-epoch --help");
        if (trailing.includes("--help")) {
          emitReceipt({ ok: true, usage: writerEpochMigrationCommand.usage, hint: writerEpochMigrationCommand.help });
          return 0;
        }
        const userRoot = daemonUserRoot();
        assertNoRunningDaemon(userRoot);
        const result = migrateLegacyWriterEpochDatabase(path.join(userRoot, "fleet")),
          exitCode = result.state === "partial" ? 1 : 0;
        emitReceipt({ ok: exitCode === 0, exitCode, ...result });
        return exitCode;
      } catch (error) {
        emitReceipt({
          ok: false,
          schema: "writer-epoch-migration-receipt/v1",
          exitCode: 1,
          code:
            error instanceof WriterEpochError
              ? error.code
              : isErrorCode(error)
                ? error.code
                : "writer_epoch_migration_failed",
          hint: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    }
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "completion") {
      if (argv.includes("--help")) {
        emitReceipt({ ok: true, usage: completionMigrationCommand.usage, hint: completionMigrationCommand.help });
        return 0;
      }
      const flags = commandFlags(argv.slice(commandIndex + 2), completionMigrationCommand),
        result = migrateCompletion({
          source: flags.get("--source")!,
          dryRun: flags.get("--mode") === "dry-run",
          ...(flags.has("--destination") ? { destination: flags.get("--destination")! } : {}),
        });
      emitReceipt({ ok: true, schema: "completion-migration-receipt/v1", ...result });
      return 0;
    }
    if (argv[commandIndex] === "migrate" && argv[commandIndex + 1] === "agent-declaration") {
      if (argv.includes("--help")) {
        emitReceipt({
          ok: true,
          usage: agentDeclarationMigrationCommand.usage,
          hint: agentDeclarationMigrationCommand.help,
        });
        return 0;
      }
      const flags = commandFlags(argv.slice(commandIndex + 2), agentDeclarationMigrationCommand),
        result = migrateAgentDeclarations({
          source: flags.get("--source")!,
          dryRun: flags.get("--mode") === "dry-run",
          ...(flags.has("--destination") ? { destination: flags.get("--destination")! } : {}),
        });
      const exitCode = result.ok ? 0 : 1;
      emitReceipt({ schema: "agent-declaration-migration-receipt/v1", exitCode, ...result });
      return exitCode;
    }
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
          invalidateDerivedState: (repoId, _root) => {
            const acknowledgements = openReplicationSlots(path.join(flags.fleetStateRoot!, "replication-slots.sqlite"));
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
function assertNoRunningDaemon(userRoot: string): void {
  if (!existsSync(userRoot)) return;
  const active = readdirSync(userRoot)
    .filter((name) => /^daemon-.+\.(?:singleton\.lock|pid)$/u.test(name))
    .map((name) => ({ name, pid: Number(readFileSync(path.join(userRoot, name), "utf8").trim()) }))
    .find(({ pid }) => Number.isSafeInteger(pid) && pid > 0 && daemonProcessAlive(pid));
  if (active)
    throw new WriterEpochError(
      "writer_epoch_daemon_running",
      `Cannot migrate writer epochs while daemon process ${active.pid} (${active.name}) is running. ` +
        "Run ha daemon stop for every daemon using this user root, then retry.",
    );
}
function isErrorCode(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
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
  const values = commandFlags(argv, generationMigrationCommand);
  return {
    source: values.get("--source")!,
    mode: values.get("--mode")! as "dry-run" | "convert" | "verify" | "activate",
    ...(values.has("--destination") ? { destination: values.get("--destination")! } : {}),
    ...(values.has("--fleet-state-root") ? { fleetStateRoot: values.get("--fleet-state-root")! } : {}),
    ...(values.has("--snapshot-gaps") ? { snapshotGaps: values.get("--snapshot-gaps")! } : {}),
  };
}
function commandFlags(
  argv: readonly string[],
  command:
    | typeof generationMigrationCommand
    | typeof completionMigrationCommand
    | typeof agentDeclarationMigrationCommand,
): Map<string, string> {
  const inputs = new Set<string>(command.inputs.map((input) => input.name)),
    values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--json") continue;
    if (!inputs.has(name)) throw new Error(`Unknown input ${name}. Run ${command.helpCommand}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Add a value for ${name}.`);
    if (values.has(name)) throw new Error(`Provide ${name} only once.`);
    values.set(name, value);
    index += 1;
  }
  const source = values.get("--source"),
    mode = values.get("--mode");
  if (!source) throw new Error(`Add --source. Run ${command.helpCommand}.`);
  if (!mode) throw new Error(`Add --mode. Run ${command.helpCommand}.`);
  const modes: readonly string[] = command.inputs.find((input) => input.name === "--mode")!.enum;
  if (!modes.includes(mode as (typeof modes)[number])) throw new Error(`Use ${modes.join(", ")} for --mode.`);
  return values;
}
