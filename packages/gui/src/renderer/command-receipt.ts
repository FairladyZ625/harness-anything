import type { GuiActionResult } from "../api/renderer-dto.ts";
import { localErrorHint } from "./result-validation.ts";

export function readGuiActionResult(value: unknown): GuiActionResult {
  const result = value as Partial<GuiActionResult>;
  if (
    !result ||
    result.schema !== "command-receipt/v2" ||
    typeof result.ok !== "boolean" ||
    typeof result.command !== "string" ||
    !["applied", "pending", "no_changes", "indeterminate", "op_rejected"].includes(String(result.outcome)) ||
    typeof result.opId !== "string"
  ) {
    throw new Error(localErrorHint(value, "GUI action bridge returned an invalid receipt."));
  }
  return result as GuiActionResult;
}
