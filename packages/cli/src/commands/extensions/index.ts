import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { runModuleCommand } from "./module.ts";
import { runPresetCommand } from "./preset.ts";
import { runTemplateCommand } from "./template.ts";
import { runVerticalCommand } from "./vertical.ts";

export const extensionExecutorGroups = {
  "template-list": "template",
  "template-render": "template",
  "preset-validate": "preset",
  "preset-list": "preset",
  "preset-inspect": "preset",
  "preset-check": "preset",
  "preset-install": "preset",
  "preset-seed": "preset",
  "preset-audit": "preset",
  "preset-uninstall": "preset",
  "preset-run": "preset",
  "preset-action": "preset",
  "module-list": "module",
  "module-inspect": "module",
  "module-register": "module",
  "module-scaffold": "module",
  "module-unregister": "module",
  "module-step": "module",
  "vertical-validate": "vertical"
} as const;

type ExtensionActionKind = keyof typeof extensionExecutorGroups;
type ExtensionAction = Extract<ParsedCommand["action"], { readonly kind: ExtensionActionKind }>;
type ExtensionExecutorGroup = typeof extensionExecutorGroups[ExtensionActionKind];

export const extensionActionKinds = Object.keys(extensionExecutorGroups) as ReadonlyArray<ExtensionActionKind>;
const extensionActionKindSet = new Set<string>(extensionActionKinds);

export function isExtensionAction(action: ParsedCommand["action"]): action is ExtensionAction {
  return extensionActionKindSet.has(action.kind);
}

export function runExtensionCommand(command: ParsedCommand): CliResult {
  try {
    const action = command.action;
    const group = extensionExecutorGroups[action.kind as ExtensionActionKind] as ExtensionExecutorGroup | undefined;
    if (!group) {
      return {
        ok: false,
        command: action.kind,
        error: {
          code: "unknown_command",
          hint: "Unsupported extension command."
        }
      };
    }
    switch (group) {
      case "template":
        return runTemplateCommand(action as Extract<ExtensionAction, { readonly kind: "template-list" | "template-render" }>);
      case "preset":
        return runPresetCommand(command.rootDir, action as Extract<ExtensionAction, { readonly kind: `preset-${string}` }>);
      case "module":
        return runModuleCommand(command.rootDir, action as Extract<ExtensionAction, { readonly kind: "module-list" | "module-inspect" | "module-register" | "module-scaffold" | "module-unregister" | "module-step" }>);
      case "vertical":
        return runVerticalCommand(action as Extract<ExtensionAction, { readonly kind: "vertical-validate" }>);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_registry_key:")) {
      const label = error.message.split(":")[1] ?? "registry";
      return {
        ok: false,
        command: command.action.kind,
        error: {
          code: "invalid_registry_key",
          hint: `Invalid ${label} key.`
        }
      };
    }
    return {
      ok: false,
      command: command.action.kind,
      error: {
        code: "decode_failed",
        hint: "Input JSON failed to decode or could not be read."
      }
    };
  }
}
