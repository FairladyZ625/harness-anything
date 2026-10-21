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
export const completionMigrationCommand = {
  id: "migrate-completion",
  path: ["migrate", "completion"],
  usage:
    "ha migrate completion --source <declaration-file|preset-package> --mode <dry-run|convert> [--destination <new-path>]",
  summary: "Convert retired checkerProfile declarations and installed preset packages once, preserving the source.",
  help: "    For an installed pin, use its preset-objects/<digest> directory as --source and a new directory as --destination. Activate with ha preset install --source <candidate-directory> through the target repository writer.\n    Declaration candidates must be reviewed and accepted with ha doc sync --submit --path harness/vertical.json.\n    Historical ledger/snapshot conversion uses ha migrate ledger --help; this command does not rewrite accepted history.",
  helpCommand: "ha migrate completion --help",
  inputs: [
    { name: "--source", kind: "single", required: true, error: { code: "missing_field" } },
    { name: "--mode", kind: "single", required: true, enum: ["dry-run", "convert"], error: { code: "invalid_field" } },
    { name: "--destination", kind: "single", required: false, error: { code: "invalid_field" } },
  ],
} as const;
export const agentDeclarationMigrationCommand = {
  id: "migrate-agent-declaration",
  path: ["migrate", "agent-declaration"],
  usage:
    "ha migrate agent-declaration --source <declaration-file|agents-directory> --mode <dry-run|convert> [--destination <new-path>]",
  summary:
    "Convert pre-runtimes agent declarations (runtime_type plus top-level model) to the runtimes shape once, preserving the source.",
  help: "    Handles one declaration file or a whole harness/agents directory. Unconvertible files are reported per file and never abort the batch.\n    Declarations naming runtime kinds or models without an enabled instance on this node still convert; the receipt lists the exact install-time issue (agent_runtime_type_unavailable / agent_model_unavailable) so the operator can enable an instance or install on another node first.\n    Review the candidates, replace the originals, and reinstall each agent with ha agent install --source harness/agents/<id>.json.",
  helpCommand: "ha migrate agent-declaration --help",
  inputs: [
    { name: "--source", kind: "single", required: true, error: { code: "missing_field" } },
    { name: "--mode", kind: "single", required: true, enum: ["dry-run", "convert"], error: { code: "invalid_field" } },
    { name: "--destination", kind: "single", required: false, error: { code: "invalid_field" } },
  ],
} as const;
