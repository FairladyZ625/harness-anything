import { isPriorityTier, isTaskWorkKind, priorityTiers, taskWorkKinds } from "../../../../kernel/src/index.ts";
import type { PriorityTier, TaskWorkKind } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult } from "../types.ts";

export function readTaskWorkKind(value: string | undefined): { readonly ok: true; readonly value?: TaskWorkKind } | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (!value) return { ok: true };
  return isTaskWorkKind(value)
    ? { ok: true, value }
    : { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Use one of ${taskWorkKinds.join(", ")} for --kind.`) };
}

export function readPriorityTier(value: string | undefined): { readonly ok: true; readonly value?: PriorityTier } | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (!value) return { ok: true };
  return isPriorityTier(value)
    ? { ok: true, value }
    : { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Use one of ${priorityTiers.join(", ")} for --risk-tier and --urgency.`) };
}
