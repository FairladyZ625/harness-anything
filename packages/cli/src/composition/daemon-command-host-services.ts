import {
  makeTaskHolderService,
  type AuthorityHostCommand,
  type AuthorityHostCommandAction,
  type DaemonCommandHostServices
} from "@harness-anything/application";
import type { AuthenticatedActor } from "@harness-anything/daemon";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { isDryRunAction } from "../cli/dry-run-preview.ts";
import { normalizeCommandSemantics } from "../cli/command-semantic-normalizer.ts";
import { productionAuthorityIngressFor } from "../cli/command-spec/index.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { isPlainRecord } from "../cli/value-utils.ts";
import { materializerCommandResult } from "../commands/core/materializer.ts";
import {
  CliActorAttributionError,
  daemonActorAttributionForParsedCommand,
  migrationWriteAttribution
} from "./actor-attribution.ts";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";
import { runRegisteredCommandWithCliComposition } from "./command-executor.ts";

type CliProductionAuthorityCommand = Extract<
  ParsedCommand,
  { readonly action: { readonly kind: AuthorityHostCommandAction["kind"] } }
>;

const cliProductionCommandsSatisfyAuthorityHostContract = true satisfies
  CliProductionAuthorityCommand extends AuthorityHostCommand ? true : never;
void cliProductionCommandsSatisfyAuthorityHostContract;

export const cliDaemonCommandHostServices = {
  parseCommandPayload: (payload) => {
    const command = payload?.command;
    if (!isPlainRecord(command) || typeof command.rootDir !== "string" || !isPlainRecord(command.action) || typeof command.action.kind !== "string") {
      throw new Error("command.run requires payload.command parsed by the CLI parser.");
    }
    return command as unknown as ParsedCommand;
  },
  normalizeCommand: (command, currentSession) => normalizeCommandSemantics(
    command,
    makeTaskHolderService({ rootInput: { rootDir: command.rootDir, layoutOverrides: command.layoutOverrides } }),
    currentSession,
    defaultCliAdapterProvider().createArtifactStore({ rootDir: command.rootDir, layoutOverrides: command.layoutOverrides })
  ),
  authorityCommand: (command) => isProductionAuthorityCommand(command) ? command : undefined,
  authorityIngressFor: (kind) => {
    const ingress = productionAuthorityIngressFor(kind);
    return ingress?.status === "typed-v2" ? ingress.adapter : undefined;
  },
  actorAttribution: daemonActorAttributionForParsedCommand,
  migrationWriteAttribution,
  isActorAttributionError: (error) => error instanceof CliActorAttributionError,
  isDryRunAction: (command) => isDryRunAction(command.action),
  executeCommand: runRegisteredCommandWithCliComposition,
  materializerCommandResult,
  toReceipt: (result) => toCommandReceipt(result as CliResult),
  invalidSessionError: (message) => cliError(CliErrorCode.InvalidSession, message),
  authMissingError: (message) => cliError(CliErrorCode.AuthMissing, message)
} satisfies DaemonCommandHostServices<ParsedCommand, CliResult, AuthenticatedActor>;

function isProductionAuthorityCommand(command: ParsedCommand): command is CliProductionAuthorityCommand {
  const ingress = productionAuthorityIngressFor(command.action.kind);
  return ingress?.status === "typed-v2"
    || command.action.kind === "preset-entrypoint"
    || command.action.kind === "script-run";
}
