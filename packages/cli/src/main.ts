#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli/parse-args.ts";
import { deprecationWarning } from "./cli/command-deprecations.ts";
import { readOption, stripGlobalOptions } from "./cli/parse-options.ts";
import { appendParseFailureRuntimeEvent } from "./cli/parse-failure-runtime-event.ts";
import { makeDaemonLogService } from "@harness-anything/application";
import {
  checkDaemonServeConfiguration as checkDaemonServeConfigurationRoot,
  createDaemonRetryBudgetSignalSink,
  daemonAutostartRootIdentity,
  daemonAutostartRootLifetimeEnabled,
  makeDaemonLogFileStore,
  resolveDaemonRuntimePolicy,
  runDaemonServe as runDaemonServeRoot
} from "@harness-anything/daemon";
import { runCompoundReceiptExitCommand } from "./receipt/compound-exit-command.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CommandRegistryEntry } from "./cli/types.ts";
import { commandGroups, globalCommandOptions } from "./cli/command-spec/command-groups.ts";
import { renderTaskPacketHelp } from "./cli/task-packet-help.ts";
import { parsePositiveIntegerOr } from "./cli/value-utils.ts";
import {
  runDaemonCommand,
  type DaemonServeHooks
} from "./commands/daemon/command.ts";
import { daemonStatusCliProjection } from "./commands/daemon/status-payload.ts";
import { runDaemonConnect } from "./commands/daemon/connect.ts";
import { runRegisteredCommandWithCliComposition } from "./composition/command-executor.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, readDaemonUserRoot, runCommandThroughDaemon } from "./daemon/client.ts";
import {
  parseDaemonLaunchArgv,
  preflightDaemonLaunch,
  resolveCompleteDaemonLaunchSpec,
  resolveDaemonLaunchSpec,
  type ParsedDaemonLaunchArgv
} from "./daemon/daemon-launch-spec.ts";
import { daemonRuntimeLayoutOverrides } from "./daemon/daemon-serve-launch-options.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "./composition/production-authority-lifecycle.ts";
import { daemonServeAdmissionOptions } from "./daemon/daemon-serve-settings.ts";
import { runAgentRuntimeCommand } from "./commands/agent-runtime.ts";
import { runReceiptStatusCommand } from "./commands/receipt-status.ts";
import { runTaskCloseoutFacade, runTaskStartFacade } from "./commands/core/task-lifecycle-facade.ts";
import { isDeclaredLocalMigrationCommand } from "./composition/local-write-scope.ts";
import { startCliTimingPhase } from "./cli/timing.ts";
import { readProjectHarnessSettings } from "./commands/settings.ts";
import { validateCommandOptions } from "./cli/option-claims.ts";
import { cliError, CliErrorCode, errorCodeFromThrown } from "./cli/error-codes.ts";
import { daemonServeHelpResult } from "./commands/daemon/help.ts";

const runRegisteredCommand = runRegisteredCommandWithCliComposition;
type ParsedCommandRunner = (command: Parameters<typeof runRegisteredCommand>[0]) => Promise<CommandReceipt | CommandFailureReceipt>;
const cliTestFixtureRunnerSymbol = Symbol.for("harness-anything.cli-test-fixture-runner");

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "__repo-write-child") {
    const { runRepoWriteChildEntrypoint } = await import(
      "./composition/repo-write-child-entrypoint.ts"
    );
    await runRepoWriteChildEntrypoint(argv[1]);
    return 0;
  }
  const daemonServeHelpExit = maybeRunDaemonServeHelp(argv);
  if (daemonServeHelpExit !== undefined) return daemonServeHelpExit;
  const optionValidation = validateCommandOptions(argv);
  if (!optionValidation.ok) {
    await appendParseFailureRuntimeEvent(argv, optionValidation.error);
    emit(toCommandReceipt({ ok: false, command: "parse", error: optionValidation.error }), true);
    return 2;
  }
  const compoundExit = await runCompoundReceiptExitCommand(argv);
  if (compoundExit !== undefined) return compoundExit;
  const daemonOverrides = stripGlobalOptions(argv);
  if (daemonOverrides.daemonMode) process.env.HARNESS_DAEMON_MODE = daemonOverrides.daemonMode;
  if (daemonOverrides.daemonProfile) process.env.HARNESS_DAEMON_PROFILE = daemonOverrides.daemonProfile;
  const daemonExit = await maybeRunDaemonCommand(argv);
  if (daemonExit !== undefined) return daemonExit;
  const agentExit = await maybeRunAgentRuntimeCommand(argv);
  if (agentExit !== undefined) return agentExit;
  const receiptStatusExit = await maybeRunReceiptStatusCommand(argv);
  if (receiptStatusExit !== undefined) return receiptStatusExit;

  const finishParse = startCliTimingPhase("parse");
  const parsed = parseArgs(argv);
  finishParse();
  if (!parsed.ok) {
    await appendParseFailureRuntimeEvent(argv, parsed.error);
    emit(toCommandReceipt({ ok: false, command: "parse", error: parsed.error }), true);
    return 2;
  }

  if (parsed.value.deprecatedInvocation) console.error(deprecationWarning(parsed.value.deprecatedInvocation));

  const output = parsed.value.action.kind === "task-start"
      ? await runTaskStartFacade(parsed.value, runParsedCommand)
      : parsed.value.action.kind === "task-closeout"
          ? await runTaskCloseoutFacade(parsed.value, runParsedCommand)
          : await runParsedCommand(parsed.value);

  const receipt = "schema" in output ? output : toCommandReceipt(output);
  emit(receipt, parsed.value.json);
  return receipt.ok ? 0 : 1;
}

async function runParsedCommand(command: Parameters<typeof runRegisteredCommand>[0]): Promise<CommandReceipt | CommandFailureReceipt> {
  const configuredMode = process.env.HARNESS_DAEMON_MODE;
  const testFixtureCommandRunner = (globalThis as Record<symbol, unknown>)[cliTestFixtureRunnerSymbol] as ParsedCommandRunner | undefined;
  if (testFixtureCommandRunner && configuredMode !== "direct" && configuredMode !== "local" && configuredMode !== "remote") {
    return runDaemonBackedCommand(() => runTimedCommand(() => testFixtureCommandRunner(command)));
  }
  if (isDaemonIndependentCommand(command) || isGithubIssuesReadCommand(command)) {
    return runLocalRegisteredCommand(command);
  }
  const daemonOutput = await runDaemonBackedCommand(() => runCommandThroughDaemon(command));
  return daemonOutput ?? runLocalRegisteredCommand(command);
}

async function runDaemonBackedCommand<T>(run: () => Promise<T>): Promise<T> {
  if (process.env.HA_PROGRESS === "0") return run();
  const slowDaemonNotice = setTimeout(() => {
    console.error("[ha] Command is still running; this is progress, not the final receipt. Keep waiting for this process to finish. Agent tools must continue reading the same session.");
  }, 1_000);
  slowDaemonNotice.unref();
  try {
    return await run();
  } finally {
    clearTimeout(slowDaemonNotice);
  }
}

async function runLocalRegisteredCommand(
  command: Parameters<typeof runRegisteredCommand>[0]
): Promise<CommandReceipt | CommandFailureReceipt> {
  const localCoordinatorScope = isDeclaredLocalMigrationCommand(command.action)
    ? "migration" as const
    : process.env.HARNESS_DAEMON_MODE === "direct" && process.env.HARNESS_DIRECT_WRITE_REASON === "recovery"
      ? "recovery" as const
      : undefined;
  const onLockConflictRetrySignal = localCoordinatorScope
    ? createDaemonRetryBudgetSignalSink(
        makeDaemonLogService({
          store: makeDaemonLogFileStore({
            userRoot: readDaemonUserRoot(process.env, command.rootDir, command.layoutOverrides)
          })
        }),
        {
          repo: {
            repoId: command.daemonRepoId ?? "canonical",
            canonicalRoot: path.resolve(command.rootDir)
          }
        },
        { source: "cli" }
      )
    : undefined;
  return runTimedCommand(async () => toCommandReceipt(await runRegisteredCommand(command, {
    ...(localCoordinatorScope ? { localCoordinatorScope } : {}),
    ...(onLockConflictRetrySignal ? { onLockConflictRetrySignal } : {})
  })));
}

async function runTimedCommand<T>(run: () => Promise<T>): Promise<T> {
  const finish = startCliTimingPhase("command_execute");
  try {
    return await run();
  } finally {
    finish();
  }
}

function isDaemonIndependentCommand(command: { readonly action: { readonly kind: string } }): boolean {
  return command.action.kind === "help"
    || command.action.kind === "version"
    || command.action.kind === "entity-list"
    || command.action.kind === "capabilities"
    || command.action.kind === "completion"
    || command.action.kind === "gui"
    || command.action.kind === "git-diff"
    || command.action.kind === "authority-repo-enroll"
    || command.action.kind === "authority-repo-resign";
}

async function maybeRunAgentRuntimeCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  if (stripGlobalOptions(argv).args[0] !== "agent") return undefined;
  const outcome = await runAgentRuntimeCommand(argv);
  emit(outcome.receipt, outcome.json);
  return outcome.receipt.ok ? 0 : 1;
}

async function maybeRunReceiptStatusCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  if (stripGlobalOptions(argv).args[0] !== "receipt") return undefined;
  const outcome = await runReceiptStatusCommand(argv);
  emit(outcome.receipt, outcome.json);
  return outcome.receipt.ok ? 0 : 1;
}

function isGithubIssuesReadCommand(command: { readonly action: { readonly kind: string } }): boolean {
  return command.action.kind === "external-snapshot" || command.action.kind === "external-list";
}

async function maybeRunDaemonCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  const stripped = stripGlobalOptions(argv);
  if (stripped.args[0] !== "daemon") return undefined;
  const action = stripped.args[1] ?? "status";
  const layoutOverrides = stripped.authoredRoot !== undefined || argv.includes("--authored-root")
    ? { authoredRoot: stripped.authoredRoot ?? "" }
    : undefined;
  const daemonArgs = stripped.daemonRepoId ? [...stripped.args, "--repo", stripped.daemonRepoId] : stripped.args;
  if (action === "connect") return runDaemonConnect(stripped.args, {
    ...(readOption(argv, "--root") ? { rootDir: stripped.rootDir } : {}),
    ...(layoutOverrides ? { layoutOverrides } : {})
  });
  if (action === "serve") {
    let launchOptions: ParsedDaemonLaunchArgv;
    try {
      launchOptions = parseDaemonLaunchArgv(argv);
    } catch (error) {
      return emitDaemonServeFailure(error, stripped.json, 2);
    }
    const serveLayoutOverrides = daemonRuntimeLayoutOverrides(launchOptions.rootDir, launchOptions.authoredRoot);
    if (daemonArgs.includes("--stdio")) {
      return emitDaemonServeFailure(
        new Error("daemon serve --stdio is disabled because it creates a competing runtime; start the persistent daemon and use 'ha daemon connect --stdio'."),
        stripped.json,
        2
      );
    }
    try {
      if (daemonArgs.includes("--check")) {
        checkDaemonServeConfiguration(launchOptions.rootDir, serveLayoutOverrides, daemonArgs.filter((arg) => arg !== "--check"), launchOptions);
        return 0;
      }
      await runDaemonServe(launchOptions.rootDir, serveLayoutOverrides, daemonArgs, {}, launchOptions);
      return 0;
    } catch (error) {
      return emitDaemonServeFailure(error, stripped.json, 1);
    }
  }
  return runDaemonCommand({
    rootDir: stripped.rootDir,
    layoutOverrides,
    json: stripped.json,
    args: daemonArgs,
    rawArgs: argv,
    runServe: runDaemonServe
  });
}

function maybeRunDaemonServeHelp(argv: ReadonlyArray<string>): number | undefined {
  const stripped = stripGlobalOptions(argv);
  const args = stripped.args;
  const helpFlag = args.includes("--help") || args.includes("-h");
  const explicitHelp = args[0] === "help" && args[1] === "daemon" && args[2] === "serve";
  const flaggedServe = helpFlag && (
    (args[0] === "daemon" && args[1] === "serve")
    || args.filter((arg) => arg !== "--help" && arg !== "-h").slice(0, 2).join(" ") === "daemon serve"
  );
  if (!explicitHelp && !flaggedServe) return undefined;
  emit(toCommandReceipt(daemonServeHelpResult()), stripped.json);
  return 0;
}

function emitDaemonServeFailure(error: unknown, json: boolean, exitCode: 1 | 2): number {
  const code = errorCodeFromThrown(error) ?? CliErrorCode.UnclassifiedCommandFailure;
  emit(toCommandReceipt({
    ok: false,
    command: "daemon-serve",
    error: cliError(code, error instanceof Error ? error.message : String(error))
  }), json);
  return exitCode;
}

function checkDaemonServeConfiguration(
  rootDir: string,
  layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>,
  launchOptions: ParsedDaemonLaunchArgv
): void {
  const userRoot = launchOptions.userRoot ?? daemonUserRoot();
  checkDaemonServeConfigurationRoot({
    rootDir,
    layoutOverrides,
    userRoot,
    endpoint: launchOptions.socketPath ?? localUserDaemonEndpoint(userRoot, daemonIdFromEnv()),
    requestedRepoId: readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID ?? "canonical",
    ...(launchOptions.authorityManifest ? { requestedAuthorityManifest: launchOptions.authorityManifest } : {})
  });
}

async function runDaemonServe(
  rootDir: string,
  _layoutOverrides: { readonly authoredRoot?: string } | undefined,
  args: ReadonlyArray<string>,
  hooks: DaemonServeHooks = {},
  parsedLaunchOptions = parseDaemonLaunchArgv(args)
): Promise<void> {
  const implementationPath = fileURLToPath(import.meta.url);
  const entrypoint = path.join(path.dirname(implementationPath), `index${path.extname(implementationPath)}`);
  const requestedUserRoot = parsedLaunchOptions.userRoot ?? daemonUserRoot();
  const requestedEndpoint = parsedLaunchOptions.socketPath ?? localUserDaemonEndpoint(requestedUserRoot, daemonIdFromEnv());
  const explicit = {
    ...(parsedLaunchOptions.authorityManifest ? { authorityManifest: parsedLaunchOptions.authorityManifest } : {}),
    ...(parsedLaunchOptions.authoredRoot ? { authoredRoot: parsedLaunchOptions.authoredRoot } : {})
  };
  const restoredSpec = parsedLaunchOptions.optionsResolved
    ? resolveCompleteDaemonLaunchSpec(requestedEndpoint, explicit)
    : resolveDaemonLaunchSpec(requestedUserRoot, requestedEndpoint, explicit);
  const restoredAuthoredRoot = restoredSpec.options.authoredRoot;
  const restoredLayoutOverrides = daemonRuntimeLayoutOverrides(rootDir, restoredAuthoredRoot);
  const restoredLaunchOptions = Object.freeze({
    ...parsedLaunchOptions,
    ...restoredSpec.options,
    socketPath: restoredSpec.endpoint,
    userRoot: requestedUserRoot
  });
  const requestedRepoId = readOption(args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID ?? "canonical";
  const { cliDaemonServiceHostServices } = await import("./composition/daemon-service-host-services.ts");
  const projectSettings = readProjectHarnessSettings({ rootDir, layoutOverrides: restoredLayoutOverrides }, "daemon-serve");
  if (!projectSettings.ok) throw new Error(projectSettings.result.error?.hint ?? "Invalid daemon runtime settings.");
  await runDaemonServeRoot({
    rootDir,
    ...(restoredAuthoredRoot !== undefined ? { authoredRoot: restoredAuthoredRoot } : {}),
    layoutOverrides: restoredLayoutOverrides,
    userRoot: requestedUserRoot,
    endpoint: restoredSpec.endpoint,
    requestedRepoId,
    ...(restoredLaunchOptions.authorityManifest ? { requestedAuthorityManifest: restoredLaunchOptions.authorityManifest } : {}),
    entrypoint,
    idleMs: parsePositiveIntegerOr(readOption(args, "--idle-ms"), 0, { allowZero: true }),
    ...(daemonAutostartRootLifetimeEnabled(process.env)
      ? { expectedRootIdentity: daemonAutostartRootIdentity(process.env) }
      : {}),
    preflightReplacement: preflightDaemonLaunch,
    runtimePolicy: resolveDaemonRuntimePolicy(process.env, projectSettings.settings.daemonRuntime),
    ...daemonServeAdmissionOptions(projectSettings.settings)
  }, cliDaemonServiceHostServices, {
    persistLaunchConfiguration: (userRoot, configuration, effectiveOptions) => restoredSpec
      .withEffectiveOptions(effectiveOptions)
      .persist(userRoot, configuration),
    createAuthorityLifecycle: createProductionAuthorityLifecycle,
    projectStartedStatus: daemonStatusCliProjection
  }, hooks);
}

function emit(output: CommandReceipt | CommandFailureReceipt, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }

  if (output.ok) {
    const data = receiptDetailsData(output);
    if (output.command === "version") {
      console.log(`harness-anything ${String(data.version ?? "unknown")}`);
      return;
    }
    if (output.command === "help" && Array.isArray(data.commands)) {
      console.log(renderHelp(data));
      return;
    }
    console.log(renderReceiptText(output));
    return;
  }

  console.error(renderReceiptText(output));
}

function renderHelp(result: Record<string, unknown>): string {
  const commands = Array.isArray(result.commands) ? result.commands as ReadonlyArray<CommandRegistryEntry> : [];
  const report = helpReport(result.report);
  if (report?.kind === "command" && commands.length === 1) {
    return renderCommandHelp(commands[0]!);
  }
  if (report?.kind === "prefix") {
    const prefix = Array.isArray(report.prefix) ? report.prefix.join(" ") : "";
    const defaultCommands = commands.filter((entry) => (entry.display ?? "default") === "default");
    const advancedCommands = commands.filter((entry) => entry.display === "advanced");
    return [
      `Usage: harness-anything ${prefix} <subcommand> [options]`,
      `Alias: ha ${prefix} <subcommand> [options]`,
      ...renderGlobalOptions(),
      ...renderPrefixWorkflow(prefix),
      "",
      "Common commands:",
      ...defaultCommands.map(renderHelpCommandSummary),
      ...(advancedCommands.length > 0
        ? ["", "Advanced commands:", ...advancedCommands.map(renderHelpCommandSummary)]
        : [])
    ].join("\n");
  }
  return [
    "Usage: harness-anything <kind> [options]",
    "Alias: ha <kind> [options]",
    ...renderGlobalOptions(),
    "",
    "Discover: ha <kind> --help | ha capabilities --json",
    "",
    "Commands:",
    ...commands.map(renderHelpCommandSummary)
  ].join("\n");
}

function renderCommandHelp(command: CommandRegistryEntry): string {
  const aliases = command.aliases.length > 0 ? ["", "Aliases:", ...command.aliases.map((alias) => `  ${alias}`)] : [];
  const options = command.options.length > 0 ? ["", "Options:", ...command.options.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`)] : [];
  const additional = command.kind === "new-task" ? taskCreatePresetHelp() : [];
  const packetTemplate = renderTaskPacketHelp(command.kind);
  const workflow = taskWorkflowNextHelp(command.kind);
  const examples = command.examples.length > 0 ? ["", command.examples.length === 1 ? "Example:" : "Examples:", ...command.examples.map((example) => `  ${example}`)] : [];
  return [
    `Usage: ${command.primary}`,
    "",
    command.summary,
    ...renderGlobalOptions(),
    ...aliases,
    ...options,
    ...additional,
    ...packetTemplate,
    ...workflow,
    ...examples
  ].join("\n");
}

function renderHelpCommandSummary(entry: CommandRegistryEntry): string {
  return `  ${entry.primary} - ${entry.summary}`;
}

function renderPrefixWorkflow(prefix: string): ReadonlyArray<string> {
  const workflow = commandGroups.find((group) => group.name === prefix)?.primaryWorkflow;
  if (!workflow) return [];
  return [
    "",
    "Primary workflow:",
    ...workflow.map((command, index) => `  ${index + 1}. ${command}`),
    `  Inspect a step with: ha ${prefix} <subcommand> --help`
  ];
}

function taskWorkflowNextHelp(kind: string): ReadonlyArray<string> {
  const nextByKind: Readonly<Record<string, string>> = {
    "new-task": "ha task start <task-id>",
    "task-start": "ha task progress append <task-id> --text \"<update>\"",
    "progress-append": "ha fact record --task <task-id> --statement \"<verified fact>\"",
    "record-fact": "ha task submit <task-id> --from-file submission.json",
    "task-complete": "ha task show <task-id> --view trace"
  };
  const next = nextByKind[kind];
  return next ? ["", "Next:", `  ${next}`] : [];
}

function renderGlobalOptions(): ReadonlyArray<string> {
  return [
    "",
    "Global options:",
    ...globalCommandOptions.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`)
  ];
}

function taskCreatePresetHelp(): ReadonlyArray<string> {
  return [
    "",
    "Recommended presets:",
    "  standard-task           General implementation or maintenance task; the default starting point.",
    "  long-running-task       Extended task that needs explicit long-running coordination.",
    "  module                  Module-scoped task with registered module metadata.",
    "  subtask-expansion       Plan and fan out a parent task into concrete subtasks.",
    "  github-issue-repair     Guide an agent from a GitHub issue through an evidence-backed repair.",
    "  legacy-migration        Legacy task intake or migration planning.",
    "  create-milestone        Guide creation of a milestone root task and its governed map files.",
    "  decision-conformance    Work that must prove alignment with recorded decisions.",
    "  milestone-closeout      Milestone wrap-up checks and evidence collection.",
    "",
    "Start here:",
    "  ha task create --title \"...\" --vertical software/coding --preset <id>",
    "  ha task create --title \"<name> milestone root\" --vertical software/coding --preset create-milestone --long-running"
  ];
}

function helpReport(report: unknown): { readonly kind: "global" | "command" | "prefix"; readonly prefix?: unknown } | undefined {
  if (!report || typeof report !== "object") return undefined;
  const candidate = report as { readonly schema?: unknown; readonly kind?: unknown; readonly prefix?: unknown };
  if (candidate.schema !== "cli-help-report/v1") return undefined;
  if (candidate.kind !== "global" && candidate.kind !== "command" && candidate.kind !== "prefix") return undefined;
  return { kind: candidate.kind, prefix: candidate.prefix };
}
