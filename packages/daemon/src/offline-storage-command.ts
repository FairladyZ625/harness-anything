export const generationMigrationCommand = {
  id: "migrate-ledger",
  path: ["migrate", "ledger"],
  usage: "ha migrate ledger --source <backup> --mode <dry-run|convert|verify|activate> [--destination <absolute-path>]",
  summary: "Convert a verified immutable generation N backup to an offline generation N+1 candidate.",
  help: "    Destination may be a drained repository or a new rehearsal copy; activation retires its source after a cut check.",
  helpCommand: "ha migrate ledger --help",
  inputs: [
    { name: "--source", kind: "single", required: true, error: { code: "missing_field" } },
    {
      name: "--mode",
      kind: "single",
      required: true,
      enum: ["dry-run", "convert", "verify", "activate"],
      error: { code: "invalid_field" },
    },
    { name: "--destination", kind: "single", required: false, error: { code: "invalid_field" } },
  ],
} as const;
