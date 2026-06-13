import { validateVerticalDefinition } from "../../../../kernel/src/index.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { decodeVerticalDefinition, invalidExtensionResult } from "./shared.ts";

type VerticalAction = Extract<ParsedCommand["action"], { readonly kind: "vertical-validate" }>;

export function runVerticalCommand(action: VerticalAction): CliResult {
  const decoded = decodeVerticalDefinition(action.definitionPath);
  if (!decoded.ok) {
    return invalidExtensionResult("vertical-validate", "vertical_definition_invalid", "Vertical definition failed validation.", decoded.issues);
  }
  const vertical = decoded.value;
  const validation = validateVerticalDefinition(vertical);
  return {
    ok: validation.ok,
    command: "vertical-validate",
    issues: validation.issues,
    error: validation.ok ? undefined : {
      code: "vertical_definition_invalid",
      hint: "Vertical definition failed validation."
    }
  };
}
