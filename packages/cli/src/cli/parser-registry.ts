import { commandKindsForParser } from "./command-registry.ts";
import { parseDoctorArgs } from "./parse-doctor-args.ts";
import { parseGitDiffArgs } from "./parse-git-diff-args.ts";
import { parseMigrationArgs } from "./parse-migration-args.ts";
import { parseCoreTaskArgs } from "./parsers/core-task.ts";
import { parseDecisionArgs } from "./parsers/decision.ts";
import { parseModuleArgs } from "./parsers/extensions-module.ts";
import { parsePresetArgs } from "./parsers/extensions-preset.ts";
import { parseScriptArgs } from "./parsers/extensions-script.ts";
import { parseTemplateArgs } from "./parsers/extensions-template.ts";
import { parseVerticalArgs } from "./parsers/extensions-vertical.ts";
import { parseGuiArgs } from "./parsers/gui.ts";
import { parseNewTaskArgs } from "./parsers/new-task.ts";
import { parseRecordArgs } from "./parsers/record.ts";
import { parseRuntimeEventArgs } from "./parsers/runtime-event.ts";
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
    id: "help",
    commandKinds: commandKindsForParser("help"),
    parse: (args, rootDir, json) => {
      if (args.length > 0 && !["help", "--help", "-h"].includes(args[0] ?? "")) return null;
      return { ok: true, value: { rootDir, json, action: { kind: "help" } } };
    }
  },
  {
    id: "version",
    commandKinds: commandKindsForParser("version"),
    parse: (args, rootDir, json) => {
      if (args[0] !== "version" && !args.includes("--version") && !args.includes("-v")) return null;
      return { ok: true, value: { rootDir, json, action: { kind: "version" } } };
    }
  },
  {
    id: "core-task",
    commandKinds: commandKindsForParser("core-task"),
    parse: parseCoreTaskArgs
  },
  {
    id: "new-task",
    commandKinds: commandKindsForParser("new-task"),
    parse: parseNewTaskArgs
  },
  {
    id: "decision",
    commandKinds: commandKindsForParser("decision"),
    parse: parseDecisionArgs
  },
  {
    id: "record",
    commandKinds: commandKindsForParser("record"),
    parse: parseRecordArgs
  },
  {
    id: "runtime-event",
    commandKinds: commandKindsForParser("runtime-event"),
    parse: parseRuntimeEventArgs
  },
  {
    id: "status-check",
    commandKinds: commandKindsForParser("status-check"),
    parse: parseStatusCheckArgs
  },
  {
    id: "migration",
    commandKinds: commandKindsForParser("migration"),
    parse: parseMigrationArgs
  },
  {
    id: "git-diff",
    commandKinds: commandKindsForParser("git-diff"),
    parse: (args, rootDir, json) => {
      const parsed = parseGitDiffArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "doctor",
    commandKinds: commandKindsForParser("doctor"),
    parse: (args, rootDir, json) => {
      const parsed = parseDoctorArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "gui",
    commandKinds: commandKindsForParser("gui"),
    parse: (args, rootDir, json) => {
      const parsed = parseGuiArgs(args, rootDir, json);
      return parsed ? { ok: true, value: parsed } : null;
    }
  },
  {
    id: "template",
    commandKinds: commandKindsForParser("template"),
    parse: parseTemplateArgs
  },
  {
    id: "preset",
    commandKinds: commandKindsForParser("preset"),
    parse: parsePresetArgs
  },
  {
    id: "script",
    commandKinds: commandKindsForParser("script"),
    parse: parseScriptArgs
  },
  {
    id: "module",
    commandKinds: commandKindsForParser("module"),
    parse: parseModuleArgs
  },
  {
    id: "vertical",
    commandKinds: commandKindsForParser("vertical"),
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
