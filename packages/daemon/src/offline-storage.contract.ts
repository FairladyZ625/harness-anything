export const generationMigrationCommand = {
  id: "migrate-ledger",
  path: ["migrate", "ledger"],
  usage: "ha migrate ledger --source <backup> --mode <dry-run|convert|verify|activate> [--destination <absolute-path>]",
  summary: "Convert a verified immutable generation 1 backup to an isolated generation 2 candidate.",
  help: "    Preserves the source; reports unsupported history and never activates the live repository.",
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
