import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { createHarnessRuntimeContext } from "../../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../../kernel/src/index.ts";
import { runModuleCommand } from "./module.ts";
import { runPresetCommand } from "./preset.ts";
import { runScriptCommand } from "./script.ts";
import { InvalidRegistryKeyError } from "./state.ts";
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
  "script-list": "script",
  "script-inspect": "script",
  "script-run": "script",
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

export function runExtensionCommand(command: ParsedCommand, coordinator?: WriteCoordinator): CliResult {
  try {
    const action = command.action;
    const layoutInput = createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
    const group = extensionExecutorGroups[action.kind as ExtensionActionKind] as ExtensionExecutorGroup | undefined;
    if (!group) {
      return {
        ok: false,
        command: action.kind,
        error: cliError(CliErrorCode.UnknownCommand, "Unsupported extension command.")
      };
    }
    switch (group) {
      case "template":
        return runTemplateCommand(action as Extract<ExtensionAction, { readonly kind: "template-list" | "template-render" }>);
      case "preset":
        return runPresetCommand(layoutInput, action as Extract<ExtensionAction, { readonly kind: `preset-${string}` }>);
      case "script":
        return runScriptCommand(layoutInput, action as Extract<ExtensionAction, { readonly kind: "script-list" | "script-inspect" | "script-run" }>);
      case "module":
        return runModuleCommand(layoutInput, action as Extract<ExtensionAction, { readonly kind: "module-list" | "module-inspect" | "module-register" | "module-scaffold" | "module-unregister" | "module-step" }>, coordinator);
      case "vertical":
        return runVerticalCommand(action as Extract<ExtensionAction, { readonly kind: "vertical-validate" }>);
    }
  } catch (error) {
    if (error instanceof InvalidRegistryKeyError) {
      return {
        ok: false,
        command: command.action.kind,
        error: cliError(CliErrorCode.InvalidRegistryKey, error.message)
      };
    }
    return {
      ok: false,
      command: command.action.kind,
      error: cliError(CliErrorCode.DecodeFailed, "Input JSON failed to decode or could not be read.")
    };
  }
}
