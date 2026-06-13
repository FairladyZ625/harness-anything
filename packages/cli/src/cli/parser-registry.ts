import { parseDoctorArgs } from "./parse-doctor-args.ts";
import { parseGitDiffArgs } from "./parse-git-diff-args.ts";
import { parseMigrationArgs } from "./parse-migration-args.ts";
import { parseCoreTaskArgs } from "./parsers/core-task.ts";
import { parseModuleArgs } from "./parsers/extensions-module.ts";
import { parsePresetArgs } from "./parsers/extensions-preset.ts";
import { parseTemplateArgs } from "./parsers/extensions-template.ts";
import { parseVerticalArgs } from "./parsers/extensions-vertical.ts";
import { parseGuiArgs } from "./parsers/gui.ts";
import { parseNewTaskArgs } from "./parsers/new-task.ts";
import { parseStatusCheckArgs } from "./parsers/status-check.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export interface ParserRegistryEntry {
  readonly id: string;
  readonly commandKinds: ReadonlyArray<ParsedCommand["action"]["kind"]>;
  readonly parse: (args: ReadonlyArray<string>, rootDir: string, json: boolean) => ParseResult | null;
}

export const parserRegistry = [
  {
    id: "core-task",
    commandKinds: ["init", "status-set", "progress-append", "task-archive", "task-supersede", "task-delete", "task-reopen", "task-review", "task-complete", "task-list"],
    parse: parseCoreTaskArgs
  },
  {
    id: "new-task",
    commandKinds: ["new-task"],
    parse: parseNewTaskArgs
  },
  {
    id: "status-check",
    commandKinds: ["status", "check", "governance-rebuild", "lesson-promote", "lesson-sediment"],
    parse: parseStatusCheckArgs
  },
  {
    id: "migration",
    commandKinds: ["adopt-multica", "snapshot-multica", "migrate-plan", "migrate-structure", "migrate-run", "migrate-verify", "legacy-scan", "legacy-intake-plan", "legacy-copy-safe-docs", "legacy-index", "legacy-verify"],
    parse: parseMigrationArgs
  },
  {
    id: "git-diff",
    commandKinds: ["git-diff"],
    parse: (args, rootDir, json) => {
      const parsed = parseGitDiffArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "doctor",
    commandKinds: ["doctor"],
    parse: (args, rootDir, json) => {
      const parsed = parseDoctorArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "gui",
    commandKinds: ["gui"],
    parse: (args, rootDir, json) => {
      const parsed = parseGuiArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "template",
    commandKinds: ["template-list", "template-render"],
    parse: parseTemplateArgs
  },
  {
    id: "preset",
    commandKinds: ["preset-validate", "preset-list", "preset-inspect", "preset-check", "preset-install", "preset-seed", "preset-audit", "preset-uninstall", "preset-run", "preset-action"],
    parse: parsePresetArgs
  },
  {
    id: "module",
    commandKinds: ["module-list", "module-inspect", "module-register", "module-scaffold", "module-unregister", "module-step"],
    parse: parseModuleArgs
  },
  {
    id: "vertical",
    commandKinds: ["vertical-validate"],
    parse: (args, rootDir, json) => {
      const parsed = parseVerticalArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  }
] as const satisfies ReadonlyArray<ParserRegistryEntry>;

export function parseRegisteredCommand(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  for (const entry of parserRegistry) {
    const parsed = entry.parse(args, rootDir, json);
    if (parsed) return parsed;
  }
  return null;
}
