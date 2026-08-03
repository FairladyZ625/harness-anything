import { Effect } from "effect";
import {
  enrollAuthorityRepo,
  resignAuthorityRepo
} from "@harness-anything/daemon";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runAuthorityRepoCommand: CommandRunner = (_context, command) => Effect.sync(() => {
  try {
    if (command.action.kind === "authority-repo-enroll") {
      const result = enrollAuthorityRepo({
        repoId: command.action.repoId,
        repoRoot: command.action.repoRoot,
        manifestPath: command.action.manifestPath,
        serviceStateRoot: command.action.serviceStateRoot,
        ...(command.action.keyRegistryPath ? { keyRegistryPath: command.action.keyRegistryPath } : {}),
        ...(command.action.namespaceTtlMs !== undefined ? { namespaceTtlMs: command.action.namespaceTtlMs } : {}),
        allowedExecutorAgentIds: command.action.allowedExecutorAgentIds
      });
      return {
        ok: true,
        command: command.action.kind,
        path: result.manifestPath,
        report: result.report
      } satisfies CliResult;
    }
    if (command.action.kind === "authority-repo-resign") {
      const result = resignAuthorityRepo({
        repoId: command.action.repoId,
        manifestPath: command.action.manifestPath,
        ...(command.action.keyRegistryPath ? { keyRegistryPath: command.action.keyRegistryPath } : {}),
        ...(command.action.switchRecordPath ? { switchRecordPath: command.action.switchRecordPath } : {}),
        ...(command.action.namespaceTtlMs !== undefined ? { namespaceTtlMs: command.action.namespaceTtlMs } : {})
      });
      return {
        ok: true,
        command: command.action.kind,
        path: result.manifestPath,
        report: result.report
      } satisfies CliResult;
    }
    return {
      ok: false,
      command: command.action.kind,
      error: cliError(CliErrorCode.UnknownCommand, "The authority repo runner received an unsupported action.")
    } satisfies CliResult;
  } catch (error) {
    return {
      ok: false,
      command: command.action.kind,
      error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
    } satisfies CliResult;
  }
});
