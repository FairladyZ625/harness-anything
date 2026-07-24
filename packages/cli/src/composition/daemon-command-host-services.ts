import {
  makeTaskHolderService,
  type AuthorityHostCommand,
  type AuthorityHostCommandAction,
  type DaemonCommandHostServices
} from "@harness-anything/application";
import {
  productionAuthorityCommandHasPurePlan,
  type AuthenticatedActor
} from "@harness-anything/daemon";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { isDryRunAction } from "../cli/dry-run-preview.ts";
import { normalizeCommandSemantics } from "../cli/command-semantic-normalizer.ts";
import { productionAuthorityIngressFor } from "../cli/command-spec/index.ts";
import { displayCommand, toCommandReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
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
  repoWriteChildExecutionMode: durableRepoWriteExecutionMode,
  receiptSeed: (command) => {
    const display = displayCommand(receiptCommandKind(command.action));
    return { command: display.command, action: display.action };
  },
  actorAttribution: daemonActorAttributionForParsedCommand,
  migrationWriteAttribution,
  isActorAttributionError: (error) => error instanceof CliActorAttributionError,
  isDryRunAction: (command) => isDryRunAction(command.action),
  executeCommand: (command, options) => runRegisteredCommandWithCliComposition(command, {
    ...options,
    missingActorAttributionMessage: "Daemon writes require a per-request authenticated actor from harness/people.yaml."
  }),
  materializerCommandResult,
  toReceipt: (result) => toCommandReceipt(result as CliResult),
  toErrorReceipt: ({ command, error }) => toCommandReceipt({
    ok: false,
    command,
    error: cliError(
      error.code === "invalid_session" ? CliErrorCode.InvalidSession : CliErrorCode.AuthMissing,
      error.context.cause
    )
  })
} satisfies DaemonCommandHostServices<ParsedCommand, CliResult, AuthenticatedActor>;

function isProductionAuthorityCommand(command: ParsedCommand): command is CliProductionAuthorityCommand {
  const ingress = productionAuthorityIngressFor(command.action.kind);
  return ingress?.status === "typed-v2"
    || command.action.kind === "preset-entrypoint"
    || command.action.kind === "script-run";
}

function durableRepoWriteExecutionMode(
  command: ParsedCommand
): "durable" | "direct" {
  const authorityCommand = isProductionAuthorityCommand(command)
    ? command
    : undefined;
  return authorityCommand
    && productionAuthorityCommandHasPurePlan(authorityCommand)
    ? "durable"
    : "direct";
}
