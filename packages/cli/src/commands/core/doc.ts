import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { buildDocSyncStatusResult, buildDocSyncDryRunResult } from "./doc-sync.ts";

type DocAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "doc-status" | "doc-sync" }>;

export const runDocCommand: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as DocAction;
  if (action.kind === "doc-status") return buildDocSyncStatusResult(context.layoutInput);
  if (action.kind === "doc-sync" && action.mode === "dry-run") return buildDocSyncDryRunResult(context.layoutInput);
  return {
    ok: false,
    command: "doc-sync-submit",
    error: cliError(CliErrorCode.JournalUnavailable, "Doc sync submit requires the daemon-backed CLI path; remove HARNESS_DAEMON_MODE=direct and retry.")
  } satisfies CliResult;
});
