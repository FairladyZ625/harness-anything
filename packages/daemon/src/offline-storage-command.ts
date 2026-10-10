export const generationMigrationCommand = {
  id: "migrate-ledger",
  path: ["migrate", "ledger"],
  usage:
    "ha migrate ledger --source <backup> --mode <dry-run|convert|verify|activate> [--destination <absolute-path>] [--fleet-state-root <absolute-path>] [--snapshot-gaps <json-file>]",
  summary: "Convert a verified generation 1 or 2 backup to an isolated generation 3 candidate.",
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
    { name: "--snapshot-gaps", kind: "single", required: false, error: { code: "invalid_field" } },
    { name: "--fleet-state-root", kind: "single", required: false, error: { code: "invalid_field" } },
    { name: "--destination", kind: "single", required: false, error: { code: "invalid_field" } },
  ],
} as const;
